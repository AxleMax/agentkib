use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::history::{
    MAX_DISCOVERY_FILES, MAX_METADATA_BYTES, belongs_to_workspace, read_bounded, stable_native_ref,
};
use crate::paging;
use crate::{
    ConversationEventPage, ConversationProvider, ConversationSessionSummary, HandoffContext,
    NativeSessionListing, NativeSessionSummary, SessionAvailability, SessionDocument,
};

#[derive(Default)]
pub struct GrokBuildProvider {
    home: Option<PathBuf>,
}

#[derive(Clone)]
struct Session {
    native_ref: String,
    transcript: PathBuf,
    cwd: Option<PathBuf>,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    archived: bool,
}

impl GrokBuildProvider {
    #[cfg(test)]
    pub(super) fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("GROK_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".grok")))
        })
    }

    fn roots(&self) -> Vec<(PathBuf, bool)> {
        let Some(home) = self.home() else {
            return Vec::new();
        };
        vec![
            (home.join("sessions"), false),
            (home.join("archived_sessions"), true),
        ]
    }

    fn collect(&self, workspace: Option<&Path>) -> Result<(Vec<Session>, bool)> {
        let mut output = Vec::new();
        let mut incomplete = false;
        let mut visited = 0usize;
        for (root, archived) in self.roots() {
            if !root.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&root)
                .follow_links(false)
                .max_depth(8)
                .into_iter()
                .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
            {
                if visited >= MAX_DISCOVERY_FILES {
                    incomplete = true;
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        incomplete = true;
                        continue;
                    }
                };
                visited += 1;
                if !entry.file_type().is_file() || entry.file_name() != "summary.json" {
                    continue;
                }
                match parse_summary(&root, archived, entry.path()) {
                    Ok(Some(session)) => {
                        if workspace.is_none_or(|workspace| {
                            session
                                .cwd
                                .as_deref()
                                .is_some_and(|cwd| belongs_to_workspace(cwd, workspace))
                        }) {
                            output.push(session);
                        }
                    }
                    Ok(None) | Err(_) => incomplete = true,
                }
            }
        }
        let mut seen = BTreeSet::new();
        output.retain(|session| seen.insert(session.native_ref.clone()));
        output.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.native_ref.cmp(&left.native_ref))
        });
        Ok((output, incomplete))
    }

    fn resolve(&self, native_ref: &str) -> Result<Session> {
        self.collect(None)?
            .0
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Grok Build session is no longer available")
    }
}

impl ConversationProvider for GrokBuildProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::GrokBuild
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .collect(Some(workspace))?
            .0
            .into_iter()
            .map(summary)
            .collect())
    }

    fn list_sessions_detailed(&self, workspace: &Path) -> Result<NativeSessionListing> {
        let (sessions, incomplete) = self.collect(Some(workspace))?;
        Ok(NativeSessionListing {
            sessions: sessions.into_iter().map(summary).collect(),
            incomplete,
        })
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let session = self.resolve(native_ref)?;
        paging::read_page(
            &session.transcript,
            cursor,
            limit,
            paging::Format::GrokBuild,
        )
    }

    fn read_handoff_context(&self, _native_ref: &str) -> Result<HandoffContext> {
        bail!("Grok Build session handoff is unsupported")
    }

    fn read_session_document(
        &self,
        _source: &ConversationSessionSummary,
        _native_ref: &str,
        _home: Option<&Path>,
    ) -> Result<SessionDocument> {
        bail!("Grok Build session documents are unsupported")
    }
}

fn summary(session: Session) -> NativeSessionSummary {
    NativeSessionSummary {
        native_ref: session.native_ref,
        agent: AgentKind::GrokBuild,
        title: session.title,
        origin: crate::SessionOrigin::Unknown,
        spawned_by_session_id: None,
        forked_from_session_id: None,
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: None,
        git_branch: None,
        archived: session.archived,
        sidechain: false,
        availability: if paging::is_readable(&session.transcript) {
            SessionAvailability::Readable
        } else {
            SessionAvailability::MetadataOnly
        },
    }
}

fn parse_summary(root: &Path, archived: bool, path: &Path) -> Result<Option<Session>> {
    let value: Value = serde_json::from_slice(&read_bounded(path, MAX_METADATA_BYTES)?)
        .with_context(|| format!("Invalid Grok summary {}", path.display()))?;
    let Some(id) = value.pointer("/info/id").and_then(Value::as_str) else {
        return Ok(None);
    };
    let cwd = value
        .pointer("/info/cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let title = value
        .get("generated_title")
        .or_else(|| value.get("generatedTitle"))
        .or_else(|| value.get("session_summary"))
        .or_else(|| value.get("sessionSummary"))
        .and_then(Value::as_str)
        .and_then(|value| super::sanitize_title(Some(value)));
    let created_at = value
        .get("created_at")
        .or_else(|| value.get("createdAt"))
        .and_then(super::parse_json_timestamp);
    let updated_at = value
        .get("last_active_at")
        .or_else(|| value.get("lastActiveAt"))
        .or_else(|| value.get("updated_at"))
        .or_else(|| value.get("updatedAt"))
        .and_then(super::parse_json_timestamp)
        .or(created_at);
    let session_dir = path
        .parent()
        .context("Grok summary has no session directory")?;
    let transcript = session_dir.join("chat_history.jsonl");
    let home = root.parent().unwrap_or(root);
    let relative = path.strip_prefix(home).unwrap_or(path).to_string_lossy();
    let native_ref = stable_native_ref(
        "grok-build",
        &[
            home.to_string_lossy().as_ref(),
            if archived { "archived" } else { "active" },
            id,
            &relative,
        ],
    );
    Ok(Some(Session {
        native_ref,
        transcript,
        cwd,
        title,
        created_at,
        updated_at,
        archived,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reads_active_and_archived_transcripts() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        for (root_name, id) in [("sessions", "s1"), ("archived_sessions", "s2")] {
            let session = dir.path().join(root_name).join("project").join(id);
            fs::create_dir_all(&session).unwrap();
            fs::write(
                session.join("summary.json"),
                serde_json::json!({
                    "info": {"id": id, "cwd": workspace},
                    "generated_title": id,
                    "updated_at": "2026-01-01T00:00:01Z"
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                session.join("chat_history.jsonl"),
                "{\"type\":\"user\",\"content\":\"hello\"}\n{\"type\":\"reasoning\",\"content\":\"hidden\"}\n{\"type\":\"assistant\",\"content\":\"done\"}\n",
            )
            .unwrap();
        }
        let provider = GrokBuildProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|session| session.archived));
        let page = provider
            .read_events(&sessions[0].native_ref, None, 50)
            .unwrap();
        assert_eq!(page.events.len(), 2);
    }

    #[test]
    fn malformed_summary_marks_listing_incomplete() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let session = dir.path().join("sessions/project/s1");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("summary.json"), "{broken").unwrap();
        let listing = GrokBuildProvider::with_home(dir.path().to_path_buf())
            .list_sessions_detailed(&workspace)
            .unwrap();
        assert!(listing.incomplete);
    }
}
