//! Trusted-host entry point. Browser authentication is performed by the Electron HTTP host;
//! this layer independently restricts operations, source identity and control freshness.
use super::*;
use agentkib_remote::Source;

pub(super) struct Worker {
    sender: Option<mpsc::SyncSender<RpcRequest>>,
    pending: Arc<AtomicU64>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new(events: Sender<RuntimeEvent>) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<RpcRequest>(32);
        let pending = Arc::new(AtomicU64::new(0));
        let finished = pending.clone();
        let handle = std::thread::spawn(move || {
            let mut service = Service::default();
            while let Ok(request) = receiver.recv() {
                let result = service.request(request.params);
                finished.fetch_sub(1, Ordering::SeqCst);
                let _ = events.send(RuntimeEvent::RemoteFinished {
                    request_id: request.id,
                    result: Box::new(result),
                });
            }
        });
        Self {
            sender: Some(sender),
            pending,
            handle: Some(handle),
        }
    }
    pub fn submit(&self, request: RpcRequest) -> Option<RpcResponse> {
        let id = request.id.clone();
        // Opening a page starts history, live and SSE reads together. Bound and serialize
        // those reads; mutations must still acquire an entirely idle worker, never queue.
        let read = matches!(
            request.params["operation"].as_str(),
            Some("catalog" | "events" | "live")
        );
        let claimed = self
            .pending
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                if (read && n < 32) || n == 0 {
                    Some(n + 1)
                } else {
                    None
                }
            });
        if claimed.is_err() {
            return Some(RpcResponse::error(id, -32000, "web-busy", None));
        }
        if self
            .sender
            .as_ref()
            .is_none_or(|sender| sender.try_send(request).is_err())
        {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return Some(RpcResponse::error(id, -32000, "web-unavailable", None));
        }
        None
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    session_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    request_id: Option<String>,
    expected_revision: Option<u64>,
    runtime_boot_id: Option<String>,
    text: Option<String>,
    turn_id: Option<String>,
    approval_id: Option<Value>,
    decision: Option<String>,
    #[serde(default)]
    experimental_enabled: bool,
}
struct Service {
    boot: String,
    used: BTreeSet<String>,
    #[cfg(target_os = "macos")]
    bridges: BTreeMap<String, agentkib_codex_bridge::Bridge>,
    #[cfg(target_os = "macos")]
    recency: Vec<String>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            boot: uuid::Uuid::new_v4().to_string(),
            used: BTreeSet::new(),
            #[cfg(target_os = "macos")]
            bridges: BTreeMap::new(),
            #[cfg(target_os = "macos")]
            recency: Vec::new(),
        }
    }
}
impl Service {
    fn request(&mut self, value: Value) -> anyhow::Result<Value> {
        let request: Request = serde_json::from_value(value)?;
        anyhow::ensure!(
            matches!(
                request.operation.as_str(),
                "catalog" | "events" | "live" | "send" | "approve"
            ),
            "web-operation-unsupported"
        );
        let source = RemoteSessionSource {
            data_dir: agentkib_store::default_data_dir()?,
        };
        if request.operation == "catalog" {
            if source.ensure_available().is_err() {
                return Ok(json!({"sessions":[],"indexEnabled":false}));
            }
            return Ok(json!({"sessions":source.catalog()?["sessions"],"indexEnabled":true}));
        }
        source.ensure_available()?;
        let id = request
            .session_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("invalid-session")?;
        if request.operation == "events" {
            return source.events(id, request.cursor.as_deref(), request.limit.unwrap_or(50));
        }
        // Validate registry even for live state; no caller-supplied filesystem or native UUID.
        let store = Store::open_default()?;
        let session = store
            .get_conversation_session(id)?
            .context("session-unavailable")?;
        let workspace = store.workspace_path(&session.workspace_id)?;
        if request.operation != "live" {
            self.claim(&request)?;
        }
        #[cfg(target_os = "macos")]
        {
            if session.agent != AgentKind::Codex {
                return self.unsupported(&request, "provider-unsupported");
            }
            let native = provider(session.agent)
                .context("provider-unavailable")?
                .list_sessions(&workspace)?
                .into_iter()
                .find(|candidate| {
                    store
                        .conversation_id(session.agent, &candidate.native_ref)
                        .is_ok_and(|found| found == id)
                })
                .context("session-unavailable")?;
            let uuid = match provider(session.agent)
                .context("provider-unavailable")?
                .verified_control_id(&native.native_ref)
            {
                Ok(Some(id)) => id,
                _ => return self.unsupported(&request, "unverified-session-identity"),
            };
            if !self.bridges.contains_key(id) {
                if self.bridges.len() >= 8 {
                    // Revalidate a cached idle snapshot before eviction. Never discard a running,
                    // pending-approval or unresolved-outcome bridge to make room for another tab.
                    let candidates = idle_candidates(
                        &self.recency,
                        self.bridges.iter().map(|(id, bridge)| {
                            (
                                id.as_str(),
                                bridge.state().is_some_and(|state| {
                                    state.status() == agentkib_codex_bridge::Status::Idle
                                        && state.approvals().is_empty()
                                }),
                            )
                        }),
                    );
                    let mut removed = false;
                    for candidate in candidates {
                        let Some(bridge) = self.bridges.get_mut(&candidate) else {
                            continue;
                        };
                        if bridge.refresh().is_ok()
                            && bridge.state().is_some_and(|state| {
                                state.status() == agentkib_codex_bridge::Status::Idle
                                    && state.approvals().is_empty()
                            })
                        {
                            self.bridges.remove(&candidate);
                            self.recency.retain(|id| id != &candidate);
                            removed = true;
                            break;
                        }
                    }
                    if !removed {
                        return self.unsupported(&request, "live-session-busy");
                    }
                }
                let home = dirs::home_dir().context("home-unavailable")?;
                let compatibility = agentkib_codex_bridge::Compatibility::inspect(
                    Path::new("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
                    &home.join(format!(
                        ".vscode/extensions/openai.chatgpt-{}-darwin-arm64/package.json",
                        agentkib_codex_bridge::EXTENSION_VERSION
                    )),
                );
                if !compatibility.is_known() {
                    return self.unsupported(&request, "unverified-installation");
                }
                let connected = agentkib_codex_bridge::Bridge::connect(
                    &home.join(".codex/ipc/ipc.sock"),
                    compatibility,
                )
                .and_then(|mut bridge| {
                    bridge.select(&uuid)?;
                    Ok(bridge)
                });
                match connected {
                    Ok(bridge) => {
                        self.bridges.insert(id.into(), bridge);
                    }
                    Err(_) => return self.unsupported(&request, "open-in-original-client"),
                }
            }
            self.recency.retain(|entry| entry != id);
            self.recency.push(id.into());
            let bridge = self.bridges.get_mut(id).context("live-unavailable")?;
            if bridge
                .state()
                .is_none_or(|state| state.conversation_id() != uuid)
            {
                self.bridges.remove(id);
                self.recency.retain(|entry| entry != id);
                return self.unsupported(&request, "session-identity-changed");
            }
            if bridge.refresh().is_err() {
                self.bridges.remove(id);
                self.recency.retain(|entry| entry != id);
                return self.unsupported(&request, "open-in-original-client");
            }
            let controls = request.experimental_enabled && bridge.enable_controls().is_ok();
            if !controls {
                bridge.disable_controls();
            }
            let state = bridge.state().context("state-unavailable")?;
            if request.operation == "live" {
                let approvals: Vec<_> = state
                    .approvals()
                    .into_iter()
                    .map(|approval| safe_approval(approval, controls))
                    .collect();
                return Ok(
                    json!({"sessionId":id,"runtimeBootId":self.boot,"status":state.status(),"revision":state.revision(),"turnId":state.active_turn(),"sendEnabled":controls && state.status()==agentkib_codex_bridge::Status::Idle,"approvals":approvals}),
                );
            }
            anyhow::ensure!(
                controls
                    && request.expected_revision.is_some()
                    && request.expected_revision == state.revision(),
                "stale-or-disabled-control"
            );
            source.ensure_available()?;
            store.workspace_path(&session.workspace_id)?;
            if request.operation == "send" {
                bridge.send_text_at_revision(
                    request.text.as_deref().context("missing-text")?,
                    request.expected_revision,
                )?;
            } else {
                let approval_id = request.approval_id.as_ref().context("missing-approval")?;
                let turn = request.turn_id.as_deref().context("missing-turn")?;
                let approval = state
                    .approvals()
                    .into_iter()
                    .find(|a| &a.request_id == approval_id && a.turn_id == turn)
                    .context("approval-no-longer-pending")?;
                let safe = safe_approval(approval, controls);
                let decision = request.decision.as_deref().context("missing-decision")?;
                anyhow::ensure!(
                    safe["supported"] == true
                        && safe["availableDecisions"]
                            .as_array()
                            .is_some_and(|list| list.contains(&json!(decision))),
                    "unsupported-approval"
                );
                let decision = match decision {
                    "accept" => agentkib_codex_bridge::Decision::Accept,
                    "decline" => agentkib_codex_bridge::Decision::Decline,
                    "cancel" => agentkib_codex_bridge::Decision::Cancel,
                    _ => anyhow::bail!("unsupported-decision"),
                };
                bridge.approve_at_revision(
                    approval_id,
                    turn,
                    decision,
                    request.expected_revision,
                )?;
            }
            Ok(
                json!({"accepted":true,"completed":false,"requestId":request.request_id,"runtimeBootId":self.boot}),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace, session);
            self.unsupported(&request, "platform-unsupported")
        }
    }
    fn claim(&mut self, request: &Request) -> anyhow::Result<()> {
        anyhow::ensure!(
            request.experimental_enabled && request.runtime_boot_id.as_deref() == Some(&self.boot),
            "stale-or-disabled-control"
        );
        let id = request
            .request_id
            .as_ref()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .context("invalid-request-id")?;
        anyhow::ensure!(
            self.used.len() < 10_000 && self.used.insert(id.clone()),
            "duplicate-or-exhausted-request"
        );
        Ok(())
    }
    fn unsupported(&self, request: &Request, reason: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(request.operation == "live", "control-unavailable");
        Ok(
            json!({"sessionId":request.session_id,"runtimeBootId":self.boot,"status":"unsupported","revision":null,"turnId":null,"sendEnabled":false,"approvals":[],"reason":reason}),
        )
    }
}

#[cfg(any(target_os = "macos", test))]
fn idle_candidates<'a>(
    recency: &[String],
    states: impl Iterator<Item = (&'a str, bool)>,
) -> Vec<String> {
    let idle: BTreeSet<_> = states.filter_map(|(id, idle)| idle.then_some(id)).collect();
    recency
        .iter()
        .filter(|id| idle.contains(id.as_str()))
        .cloned()
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn safe_approval(approval: agentkib_codex_bridge::Approval, controls: bool) -> Value {
    let details = approval.details;
    let complete = match approval.method.as_str() {
        "item/commandExecution/requestApproval" => {
            details["command"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty() && v.len() <= 16 * 1024 && !v.contains('\0'))
                && details["cwd"]
                    .as_str()
                    .is_some_and(|v| Path::new(v).is_absolute())
        }
        "item/fileChange/requestApproval" => details["changes"].as_array().is_some_and(|changes| {
            !changes.is_empty() && changes.len() <= 100 && changes.iter().all(complete_file_change)
        }),
        _ => false,
    };
    let valid_decisions = details
        .get("availableDecisions")
        .is_none_or(|value| value.is_null() || value.is_array());
    let supported = valid_decisions
        && (approval.request_id.is_string() || approval.request_id.is_number())
        && controls
        && complete
        // Version-pinned allowlist: unknown non-null metadata may carry a new permission
        // request or an omitted scope. Never silently hide it while enabling approval.
        && details.as_object().is_some_and(|object| object.iter().all(|(key,value)| value.is_null() || matches!(key.as_str(),
            "threadId"|"turnId"|"itemId"|"approvalId"|"command"|"cwd"|"reason"|"commandActions"|"changes"|"availableDecisions")))
        && [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
        ]
        .iter()
        .all(|key| details.get(key).is_none_or(Value::is_null));
    // Null decisions use the version-pinned protocol's standard decisions; unknown entries never escape.
    let offered = details["availableDecisions"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!("accept"), json!("decline"), json!("cancel")]);
    let decisions: Vec<_> = offered
        .into_iter()
        .filter(|v| matches!(v.as_str(), Some("accept" | "decline" | "cancel")))
        .collect();
    let supported = supported && !decisions.is_empty();
    json!({"requestId":approval.request_id,"turnId":approval.turn_id,"method":approval.method,"command":details["command"],"cwd":details["cwd"],"changes":details["changes"],"availableDecisions":if supported { decisions } else {vec![]},"supported":supported})
}

#[cfg(any(target_os = "macos", test))]
fn complete_file_change(change: &Value) -> bool {
    let Some(object) = change.as_object() else {
        return false;
    };
    // Summary-only entries (path/kind but no actual diff) are not approvable.
    object
        .keys()
        .all(|key| matches!(key.as_str(), "path" | "kind" | "diff"))
        && change["path"]
            .as_str()
            .is_some_and(|path| !path.contains('\0') && Path::new(path).is_absolute())
        && change["diff"]
            .as_str()
            .is_some_and(|diff| diff.len() <= 256 * 1024 && !diff.contains('\0'))
        && change["kind"].as_object().is_some_and(|kind| {
            kind.keys()
                .all(|key| matches!(key.as_str(), "type" | "movePath"))
                && matches!(
                    change["kind"]["type"].as_str(),
                    Some("add" | "update" | "delete")
                )
                && change["kind"].get("movePath").is_none_or(|path| {
                    path.is_null()
                        || path
                            .as_str()
                            .is_some_and(|path| Path::new(path).is_absolute())
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file_approval(details: Value) -> Value {
        safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/fileChange/requestApproval".into(),
                details,
            },
            true,
        )
    }
    #[test]
    fn file_approval_requires_full_known_change_not_a_path_summary() {
        let good = json!({"changes":[{"path":"/tmp/qa.txt","kind":{"type":"add"},"diff":"QA\n"}]});
        assert_eq!(file_approval(good.clone())["supported"], true);
        for changes in [
            json!([{"path":"/tmp/qa.txt","kind":{"type":"add"}}]),
            json!([{"path":"/tmp/qa.txt","kind":{"type":"add"},"diff":null}]),
            json!([{"path":"qa.txt","kind":{"type":"add"},"diff":"QA"}]),
            json!([{"path":"/tmp/qa.txt","kind":{"type":"unknown"},"diff":"QA"}]),
            json!([{"path":"/tmp/qa.txt","kind":{"type":"add"},"diff":"QA","truncated":true}]),
        ] {
            let projected = file_approval(json!({"changes":changes}));
            assert_eq!(projected["supported"], false);
            assert_eq!(projected["availableDecisions"], json!([]));
        }
        for field in [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
            "proposedExecpolicyAmendment",
            "proposedNetworkPolicyAmendments",
            "unknownPermissionScope",
        ] {
            let mut details = good.clone();
            details[field] = json!({});
            assert_eq!(file_approval(details)["supported"], false, "{field}");
        }
    }
    #[test]
    fn command_approval_requires_visible_working_directory_and_complete_scope() {
        let mut approval = agentkib_codex_bridge::Approval {
            request_id: json!(1),
            turn_id: "turn".into(),
            method: "item/commandExecution/requestApproval".into(),
            details: json!({"command":"/usr/bin/true","cwd":"/tmp"}),
        };
        assert_eq!(safe_approval(approval.clone(), true)["supported"], true);
        approval.details["cwd"] = Value::Null;
        assert_eq!(safe_approval(approval, true)["supported"], false);
    }
    #[test]
    fn eviction_is_lru_and_never_selects_busy_approval_or_unknown_entries() {
        let recency = vec![
            "old-running".into(),
            "old-idle".into(),
            "pending".into(),
            "unknown".into(),
            "new-idle".into(),
        ];
        let states = vec![
            ("new-idle", true),
            ("pending", false),
            ("old-idle", true),
            ("unknown", false),
            ("old-running", false),
        ];
        assert_eq!(
            idle_candidates(&recency, states.into_iter()),
            vec!["old-idle", "new-idle"]
        );
        assert!(idle_candidates(&recency, [("pending", false)].into_iter()).is_empty());
    }
    #[test]
    fn restart_does_not_accept_pre_restart_control_and_eviction_cannot_reset_dedup() {
        let mut before = Service::default();
        let request:Request=serde_json::from_value(json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":before.boot,"requestId":uuid::Uuid::new_v4().to_string()})).unwrap();
        before.claim(&request).unwrap();
        // Bridge cache lifecycle deliberately has no relationship to the operation journal.
        #[cfg(target_os = "macos")]
        {
            before.bridges.clear();
            before.recency.clear();
        }
        assert!(before.claim(&request).is_err());
        assert!(Service::default().claim(&request).is_err());
    }
    #[test]
    fn worker_rejects_busy_without_queuing_control() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(1)),
            handle: None,
        };
        let request: RpcRequest = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":1,"method":"web.request","params":{"operation":"send"}}),
        )
        .unwrap();
        assert!(worker.submit(request).unwrap().error.is_some());
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn worker_serializes_page_reads_with_a_bounded_queue() {
        let (sender, receiver) = mpsc::sync_channel(32);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(0)),
            handle: None,
        };
        for id in 0..32 {
            let operation = ["events", "live", "catalog"][id % 3];
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":id,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).is_none());
        }
        for operation in ["live", "send", "approve"] {
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":33,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).unwrap().error.is_some());
        }
        for id in 0..32 {
            assert_eq!(receiver.try_recv().unwrap().id, json!(id));
        }
        assert_eq!(worker.pending.load(Ordering::SeqCst), 32);
    }
    #[test]
    fn rejects_arbitrary_fields_and_stale_replays() {
        assert!(
            serde_json::from_value::<Request>(json!({"operation":"send","path":"/tmp"})).is_err()
        );
        let mut service = Service::default();
        let mut value = json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()});
        let request: Request = serde_json::from_value(value.clone()).unwrap();
        assert!(service.claim(&request).is_ok());
        assert!(service.claim(&request).is_err());
        value["runtimeBootId"] = json!("old");
        assert!(
            service
                .claim(&serde_json::from_value(value).unwrap())
                .is_err()
        );
    }
    #[test]
    fn unsupported_permissions_never_offer_decisions() {
        let value = safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/commandExecution/requestApproval".into(),
                details: json!({"command":"true","additionalPermissions":{}}),
            },
            true,
        );
        assert_eq!(value["supported"], false);
        assert_eq!(value["availableDecisions"], json!([]));
    }
}
