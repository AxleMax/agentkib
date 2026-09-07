use crate::{Compatibility, Connection, Decision, SessionState, Status};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Opt-in, local-only facade. IDs/commands supplied by a caller are not forwarded verbatim.
pub struct Bridge {
    connection: Connection,
    compatibility: Compatibility,
    controls_enabled: bool,
    selected: Option<SessionState>,
    endpoint: PathBuf,
}

impl Bridge {
    pub fn connect(socket: &Path, compatibility: Compatibility) -> Result<Self> {
        Ok(Self {
            connection: Connection::connect(socket)?,
            compatibility,
            controls_enabled: false,
            selected: None,
            endpoint: socket.to_owned(),
        })
    }

    pub fn enable_controls(&mut self) -> Result<()> {
        ensure!(
            self.connection
                .peer_executable()
                .is_some_and(|p| self.compatibility.matches_router(p)),
            "unverified Codex installation or IPC router executable; read-only mode"
        );
        self.controls_enabled = true;
        Ok(())
    }

    pub fn disable_controls(&mut self) {
        self.controls_enabled = false;
    }
    pub fn state(&self) -> Option<&SessionState> {
        self.selected.as_ref()
    }

    pub fn select(&mut self, conversation: &str) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(conversation).is_ok(),
            "select an explicit Codex conversation UUID"
        );
        self.unfollow();
        let response = self.connection.request(
            "thread-owner-discovery",
            json!({"hostId":"local", "conversationId":conversation}),
            None,
            |_| Ok(()),
        )?;
        let owner = response["handledByClientId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("no session owner found")?
            .to_owned();
        ensure!(owner != self.connection.client_id(), "cannot follow self");
        self.selected = Some(SessionState::new(conversation.into(), owner.clone()));
        let result = (|| {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":conversation,"hostId":"local","following":true}),
                &owner,
            )?;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                self.poll(until.saturating_duration_since(Instant::now()))?;
                if self
                    .selected
                    .as_ref()
                    .is_some_and(|s| s.revision().is_some())
                {
                    return Ok(());
                }
            }
            anyhow::bail!("no compatible owner snapshot received; read-only mode");
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        }
        result
    }

    pub fn refresh(&mut self) -> Result<()> {
        let id = self
            .selected
            .as_ref()
            .context("no selected session")?
            .conversation
            .clone();
        self.select(&id)
    }

    pub fn poll(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout.min(Duration::from_secs(3));
        match self.connection.receive(deadline) {
            Ok(Some(message)) => {
                if let Some(state) = &mut self.selected {
                    if following_status_requested(&message, state) {
                        self.connection.broadcast("thread-stream-following-changed",
                            json!({"conversationId":state.conversation,"hostId":"local","following":true}), &state.owner)?;
                    } else {
                        state.notification(message)?;
                    }
                }
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(error) => {
                self.invalidate(Status::Disconnected);
                Err(error)
            }
        }
    }

    /// A returned receipt means the owner acknowledged the request, NOT turn completion.
    /// The caller must observe subsequent state; errors never imply it is safe to resend.
    pub fn send_text(&mut self, text: &str) -> Result<()> {
        ensure!(
            !text.trim().is_empty() && text.len() <= 16 * 1024,
            "text must be 1–16384 bytes"
        );
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            state.status() == Status::Idle,
            "session is not idle; sending is disabled"
        );
        let id = state.conversation.clone();
        self.mutate("thread-follower-start-turn", json!({"conversationId":id,
            "turnStart":{"request":{"threadId":id,"input":[{"type":"text","text":text,"text_elements":[]}]}}}))
    }

    pub fn stop(&mut self, expected_turn_id: &str) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            state.active_turn() == Some(expected_turn_id),
            "turn changed; stop cancelled"
        );
        self.mutate(
            "thread-follower-interrupt-turn",
            json!({"conversationId":state.conversation,
            "mode":"user-stop","expectedTurnId":expected_turn_id}),
        )
    }

    pub fn approve(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        let approval = state
            .approvals()
            .into_iter()
            .find(|a| &a.request_id == request_id && a.turn_id == expected_turn_id)
            .context("approval no longer pending; nothing sent")?;
        if matches!(decision, Decision::Accept) {
            ensure!(
                match approval.method.as_str() {
                    "item/commandExecution/requestApproval" =>
                        approval.details["command"]
                            .as_str()
                            .is_some_and(|c| !c.is_empty())
                            && approval
                                .details
                                .get("networkApprovalContext")
                                .is_none_or(Value::is_null)
                            && approval
                                .details
                                .get("additionalPermissions")
                                .is_none_or(Value::is_null),
                    "item/fileChange/requestApproval" =>
                        approval.details["changes"]
                            .as_array()
                            .is_some_and(|c| !c.is_empty())
                            && approval.details.get("grantRoot").is_none_or(Value::is_null),
                    _ => false,
                },
                "approval details are incomplete or unsupported; handle in the original client"
            );
        }
        if let Some(available) = approval
            .details
            .get("availableDecisions")
            .filter(|v| !v.is_null())
        {
            ensure!(
                available
                    .as_array()
                    .is_some_and(|items| items.contains(&json!(decision))),
                "decision not offered by owner"
            );
        }
        let method = match approval.method.as_str() {
            "item/commandExecution/requestApproval" => "thread-follower-command-approval-decision",
            "item/fileChange/requestApproval" => "thread-follower-file-approval-decision",
            _ => anyhow::bail!("please handle this request in the original client"),
        };
        self.mutate(
            method,
            json!({"conversationId":state.conversation,"requestId":request_id,"decision":decision}),
        )
    }

    fn ready(&self) -> Result<()> {
        ensure!(
            self.controls_enabled && self.compatibility.is_known(),
            "experimental controls are disabled"
        );
        ensure!(self.connection.is_connected(), "IPC disconnected");
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            matches!(
                state.status(),
                Status::Idle | Status::Running | Status::AwaitingApproval
            ),
            "session state is not confirmed; synchronize before retrying"
        );
        Ok(())
    }

    fn mutate(&mut self, method: &str, params: Value) -> Result<()> {
        let state = self.selected.as_mut().context("no selected session")?;
        let owner = state.owner.clone();
        // Invalidating first prevents a second submission even if the acknowledgement is lost.
        state.status = Status::OutcomeUnknown;
        let mut following_requested = false;
        let response = self.connection.request(method, params, Some(&owner), |m| {
            if following_status_requested(&m, state) {
                following_requested = true;
                Ok(())
            } else {
                state.notification(m)
            }
        });
        if following_requested && self.connection.is_connected() {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":true}),
                &owner,
            )?;
        }
        match response {
            Ok(value) if value["method"] == method => {
                // No blind retry or claimed success. A fresh snapshot resolves the operation.
                state.status = Status::OutcomeUnknown;
                Ok(())
            }
            Ok(_) => {
                state.invalidate(Status::Unsupported);
                anyhow::bail!("unrecognized owner acknowledgement")
            }
            Err(error) => {
                state.invalidate(Status::OutcomeUnknown);
                Err(error)
            }
        }
    }

    fn invalidate(&mut self, status: Status) {
        if let Some(state) = &mut self.selected {
            state.invalidate(status);
        }
    }

    fn unfollow(&mut self) {
        if let Some(state) = self.selected.take() {
            let _ = self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":false}),
                &state.owner,
            );
        }
    }
}

type OperationKey = (PathBuf, String);
static OPERATIONS: OnceLock<Mutex<BTreeSet<OperationKey>>> = OnceLock::new();

// Serializes all bridge instances in this process, without holding a mutex over IPC waits.
// Other official clients are coordinated by the owner; this is not a cross-client CAS.
struct OperationGuard(OperationKey);
impl OperationGuard {
    fn acquire(endpoint: &Path, conversation: &str) -> Result<Self> {
        let mut active = OPERATIONS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| anyhow::anyhow!("bridge operation lock unavailable"))?;
        let key = (endpoint.to_owned(), conversation.into());
        ensure!(
            active.insert(key.clone()),
            "session operation already in flight"
        );
        Ok(Self(key))
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Some(lock) = OPERATIONS.get()
            && let Ok(mut active) = lock.lock()
        {
            active.remove(&self.0);
        }
    }
}

fn following_status_requested(message: &Value, state: &SessionState) -> bool {
    message["type"] == "broadcast"
        && message["method"] == "thread-stream-following-status-requested"
        && message["version"] == 1
        && message["sourceClientId"] == state.owner
        && message["params"]["conversationId"] == state.conversation
        && message["params"]["hostId"] == "local"
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.unfollow();
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[test]
    fn operation_lock_rejects_duplicates_and_releases_on_drop() {
        let endpoint = Path::new("/synthetic/operation-lock-test.sock");
        let first = OperationGuard::acquire(endpoint, "conversation-a").unwrap();
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_err());
        let other = OperationGuard::acquire(endpoint, "conversation-b").unwrap();
        let other_endpoint = OperationGuard::acquire(
            Path::new("/synthetic/other-lock-test.sock"),
            "conversation-a",
        )
        .unwrap();
        drop(first);
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_ok());
        drop((other, other_endpoint));
    }
}
