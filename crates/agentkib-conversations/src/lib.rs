use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::WalkDir;

const MAX_TITLE_CHARS: usize = 200;
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CLAUDE_HEADER_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLAUDE_HEADER_LINES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionAvailability {
    Readable,
    MetadataOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionIndexFreshness {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationEventKind {
    UserMessage,
    AgentMessage,
    ToolSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSessionSummary {
    #[serde(skip)]
    pub native_ref: String,
    pub agent: AgentKind,
    pub title: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub message_count: Option<u64>,
    pub git_branch: Option<String>,
    pub archived: bool,
    pub sidechain: bool,
    pub availability: SessionAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub agent: AgentKind,
    pub title: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub message_count: Option<u64>,
    pub git_branch: Option<String>,
    pub archived: bool,
    pub sidechain: bool,
    pub availability: SessionAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationIndexStatus {
    pub workspace_id: String,
    pub agent: AgentKind,
    pub freshness: SessionIndexFreshness,
    pub session_count: u64,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub error_key: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationEvent {
    pub id: String,
    pub kind: ConversationEventKind,
    pub timestamp: Option<DateTime<Utc>>,
    pub content: Option<String>,
    pub tool_name: Option<String>,
    pub tool_status: Option<String>,
    pub duration_ms: Option<u64>,
    pub attachment_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationEventPage {
    pub events: Vec<ConversationEvent>,
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}

pub trait ConversationProvider {
    fn agent(&self) -> AgentKind;
    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>>;
    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage>;
}

pub fn providers() -> Vec<Box<dyn ConversationProvider + Send + Sync>> {
    vec![
        Box::new(CodexProvider::default()),
        Box::new(ClaudeProvider::default()),
    ]
}

pub fn provider(agent: AgentKind) -> Option<Box<dyn ConversationProvider + Send + Sync>> {
    match agent {
        AgentKind::Codex => Some(Box::new(CodexProvider::default())),
        AgentKind::ClaudeCode => Some(Box::new(ClaudeProvider::default())),
        _ => None,
    }
}

#[derive(Default)]
pub struct CodexProvider {
    home: Option<PathBuf>,
}

impl CodexProvider {
    #[cfg(test)]
    fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        })
    }

    fn databases(&self) -> Vec<PathBuf> {
        let Some(home) = self.home() else {
            return Vec::new();
        };
        let mut output = Vec::new();
        for directory in [home.clone(), home.join("sqlite")] {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))
                {
                    output.push(path);
                }
            }
        }
        output.sort();
        output.dedup();
        output
    }

    fn native_sessions(&self, workspace: Option<&Path>) -> Result<Vec<CodexNativeSession>> {
        let mut output = BTreeMap::new();
        for database in self.databases() {
            let connection = open_read_only(&database)?;
            let columns = table_columns(&connection, "threads")?;
            if !columns.contains("id")
                || !columns.contains("cwd")
                || !columns.contains("rollout_path")
            {
                continue;
            }
            let title = first_column_expression(&columns, &["name", "title", "preview"], "''");
            let created =
                first_column_expression(&columns, &["created_at_ms", "created_at"], "NULL");
            let updated = first_column_expression(
                &columns,
                &["recency_at_ms", "updated_at_ms", "recency_at", "updated_at"],
                "NULL",
            );
            let branch = if columns.contains("git_branch") {
                "git_branch"
            } else {
                "NULL"
            };
            let archived = if columns.contains("archived") {
                "archived"
            } else {
                "0"
            };
            let sql = format!(
                "SELECT id, rollout_path, cwd, {title}, {created}, {updated}, {branch}, {archived} FROM threads"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map([], |row| {
                Ok(CodexNativeSession {
                    native_ref: row.get(0)?,
                    transcript: PathBuf::from(row.get::<_, String>(1)?),
                    cwd: PathBuf::from(row.get::<_, String>(2)?),
                    title: row.get::<_, Option<String>>(3)?,
                    created_at: row
                        .get::<_, Option<i64>>(4)?
                        .and_then(timestamp_from_integer),
                    updated_at: row
                        .get::<_, Option<i64>>(5)?
                        .and_then(timestamp_from_integer),
                    git_branch: row.get(6)?,
                    archived: row.get::<_, i64>(7).unwrap_or(0) != 0,
                })
            })?;
            for row in rows {
                let mut value = row?;
                if let Some(workspace) = workspace
                    && !workspace_matches(&value.cwd, workspace)
                {
                    continue;
                }
                if value.transcript.is_relative()
                    && let Some(home) = self.home()
                {
                    value.transcript = home.join(&value.transcript);
                }
                output.insert(value.native_ref.clone(), value);
            }
        }
        Ok(output.into_values().collect())
    }
}

impl ConversationProvider for CodexProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .native_sessions(Some(workspace))?
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.native_ref,
                agent: AgentKind::Codex,
                title: sanitize_title(session.title.as_deref()),
                created_at: session.created_at,
                updated_at: session.updated_at,
                message_count: None,
                git_branch: sanitize_metadata(session.git_branch),
                archived: session.archived,
                sidechain: false,
                availability: if session.transcript.is_file() {
                    SessionAvailability::Readable
                } else {
                    SessionAvailability::MetadataOnly
                },
            })
            .collect())
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Codex session is no longer available")?;
        read_codex_events(&session.transcript, cursor, limit)
    }
}

struct CodexNativeSession {
    native_ref: String,
    transcript: PathBuf,
    cwd: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    git_branch: Option<String>,
    archived: bool,
}

#[derive(Default)]
pub struct ClaudeProvider {
    home: Option<PathBuf>,
}

impl ClaudeProvider {
    #[cfg(test)]
    fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".claude")))
        })
    }

    fn native_sessions(&self, workspace: Option<&Path>) -> Result<Vec<ClaudeNativeSession>> {
        let Some(home) = self.home() else {
            return Ok(Vec::new());
        };
        let projects = home.join("projects");
        let mut output = BTreeMap::new();
        let mut relevant_errors = Vec::new();
        let mut index_paths = Vec::new();
        let mut transcript_paths = Vec::new();
        if projects.is_dir() {
            for entry in WalkDir::new(&projects)
                .max_depth(3)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
            {
                let entry = match entry {
                    Ok(value) => value,
                    Err(error) => {
                        relevant_errors.push(error.to_string());
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                if entry.file_name() == "sessions-index.json" {
                    index_paths.push(entry.into_path());
                } else if entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
                {
                    transcript_paths.push(entry.into_path());
                }
            }
        }

        // sessions-index.json is a useful Claude cache, but transcript files are the
        // durable source documented by Claude Code. Parse the cache first only so
        // transcript discovery can enrich it without reading message bodies.
        for index_path in index_paths {
            let value: Value = match fs::read_to_string(&index_path)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
            {
                Some(value) => value,
                None => {
                    relevant_errors.push(format!("Cannot parse {}", index_path.display()));
                    continue;
                }
            };
            if value.get("version").and_then(Value::as_u64) != Some(1) {
                relevant_errors.push(format!(
                    "Unsupported Claude session index version in {}",
                    index_path.display()
                ));
                continue;
            }
            for item in value
                .get("entries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(project_path) = item
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                else {
                    continue;
                };
                if platform_path::is_known_agent_probe_workspace(&project_path) {
                    continue;
                }
                let Some(native_ref) = item.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                let transcript = item
                    .get("fullPath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        index_path
                            .parent()
                            .unwrap_or_else(|| Path::new(""))
                            .join(format!("{native_ref}.jsonl"))
                    });
                let summary = item
                    .get("summary")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                let first_prompt = item.get("firstPrompt").and_then(Value::as_str);
                let session = ClaudeNativeSession {
                    native_ref: native_ref.to_owned(),
                    transcript,
                    project_path,
                    title: sanitize_title(summary.or(first_prompt)),
                    created_at: item.get("created").and_then(parse_json_timestamp),
                    updated_at: item
                        .get("modified")
                        .or_else(|| item.get("fileMtime"))
                        .and_then(parse_json_timestamp),
                    message_count: item.get("messageCount").and_then(Value::as_u64),
                    git_branch: item
                        .get("gitBranch")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    sidechain: item
                        .get("isSidechain")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                };
                output.insert(session.native_ref.clone(), session);
            }
        }

        for transcript_path in transcript_paths {
            let file_ref = transcript_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned);
            if let Some(session) = file_ref.as_ref().and_then(|value| output.get_mut(value)) {
                session.transcript = transcript_path;
                continue;
            }
            match claude_session_from_transcript(&transcript_path) {
                Ok(Some(session)) => {
                    if let Some(indexed) = output.get_mut(&session.native_ref) {
                        indexed.transcript = transcript_path;
                    } else {
                        output.insert(session.native_ref.clone(), session);
                    }
                }
                Ok(None) => {}
                Err(error) => relevant_errors.push(error.to_string()),
            }
        }

        let history_path = home.join("history.jsonl");
        if history_path.is_file() {
            match read_jsonl_snapshot(&history_path) {
                Ok(snapshot) => {
                    for (_, item) in snapshot.records {
                        let Some(project_path) = item
                            .get("project")
                            .and_then(Value::as_str)
                            .map(PathBuf::from)
                        else {
                            continue;
                        };
                        if platform_path::is_known_agent_probe_workspace(&project_path) {
                            continue;
                        }
                        let Some(native_ref) = item.get("sessionId").and_then(Value::as_str) else {
                            continue;
                        };
                        let timestamp = item.get("timestamp").and_then(parse_json_timestamp);
                        if let Some(session) = output.get_mut(native_ref) {
                            session.created_at = earliest_time(session.created_at, timestamp);
                            session.updated_at = latest_time(session.updated_at, timestamp);
                        } else {
                            output.insert(
                                native_ref.to_owned(),
                                ClaudeNativeSession {
                                    native_ref: native_ref.to_owned(),
                                    transcript: PathBuf::new(),
                                    project_path,
                                    // history.jsonl `display` is a user message, not a title.
                                    // Keeping it out of the index preserves the metadata-only boundary.
                                    title: None,
                                    created_at: timestamp,
                                    updated_at: timestamp,
                                    message_count: None,
                                    git_branch: None,
                                    sidechain: false,
                                },
                            );
                        }
                    }
                }
                Err(error) => relevant_errors.push(error.to_string()),
            }
        }
        if output.is_empty() && !relevant_errors.is_empty() {
            bail!(relevant_errors.join("; "));
        }
        Ok(output
            .into_values()
            .filter(|session| {
                !platform_path::is_known_agent_probe_workspace(&session.project_path)
                    && workspace
                        .is_none_or(|workspace| workspace_matches(&session.project_path, workspace))
            })
            .collect())
    }
}

impl ConversationProvider for ClaudeProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .native_sessions(Some(workspace))?
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.native_ref,
                agent: AgentKind::ClaudeCode,
                title: session.title,
                created_at: session.created_at,
                updated_at: session.updated_at,
                message_count: session.message_count,
                git_branch: sanitize_metadata(session.git_branch),
                archived: false,
                sidechain: session.sidechain,
                availability: if session.transcript.is_file() {
                    SessionAvailability::Readable
                } else {
                    SessionAvailability::MetadataOnly
                },
            })
            .collect())
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let session = self
            .native_sessions(None)?
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context("Claude session is no longer available")?;
        read_claude_events(&session.transcript, cursor, limit)
    }
}

struct ClaudeNativeSession {
    native_ref: String,
    transcript: PathBuf,
    #[allow(dead_code)]
    project_path: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    message_count: Option<u64>,
    git_branch: Option<String>,
    sidechain: bool,
}

fn claude_session_from_transcript(path: &Path) -> Result<Option<ClaudeNativeSession>> {
    let file = File::open(path)
        .with_context(|| format!("Cannot open Claude transcript {}", path.display()))?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_TRANSCRIPT_BYTES {
        bail!("Claude transcript exceeds the 256 MiB read limit");
    }
    let mut reader = BufReader::new(file.take(metadata.len().min(MAX_CLAUDE_HEADER_BYTES)));
    let mut native_ref = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_owned);
    let mut project_path = None;
    let mut created_at = None;
    let mut updated_at = metadata.modified().ok().map(DateTime::<Utc>::from);
    let mut git_branch = None;
    let mut sidechain = false;
    let mut buffer = Vec::new();

    for _ in 0..MAX_CLAUDE_HEADER_LINES {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        if !buffer.ends_with(b"\n") || buffer.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if let Some(value) = value.get("sessionId").and_then(Value::as_str) {
            native_ref = Some(value.to_owned());
        }
        if project_path.is_none() {
            project_path = value
                .get("cwd")
                .or_else(|| value.get("projectPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from);
        }
        if git_branch.is_none() {
            git_branch = value
                .get("gitBranch")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        sidechain |= value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        created_at = earliest_time(created_at, timestamp);
        updated_at = latest_time(updated_at, timestamp);
    }

    let (Some(native_ref), Some(project_path)) = (native_ref, project_path) else {
        return Ok(None);
    };
    if platform_path::is_known_agent_probe_workspace(&project_path) {
        return Ok(None);
    }
    Ok(Some(ClaudeNativeSession {
        native_ref,
        transcript: path.to_path_buf(),
        project_path,
        title: None,
        created_at,
        updated_at,
        message_count: None,
        git_branch,
        sidechain,
    }))
}

fn earliest_time(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.min(candidate)),
        (current, candidate) => current.or(candidate),
    }
}

fn latest_time(
    current: Option<DateTime<Utc>>,
    candidate: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.max(candidate)),
        (current, candidate) => current.or(candidate),
    }
}

#[derive(Clone)]
struct IndexedEvent {
    line: usize,
    event: ConversationEvent,
}

fn read_codex_events(
    path: &Path,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let snapshot = read_jsonl_snapshot(path)?;
    let mut primary = Vec::new();
    let mut fallback = Vec::new();
    let mut primary_messages = BTreeSet::new();
    let mut tools: BTreeMap<String, IndexedEvent> = BTreeMap::new();
    let mut warnings = snapshot.warnings;
    for (line, value) in snapshot.records {
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        match (
            value.get("type").and_then(Value::as_str),
            value.pointer("/payload/type").and_then(Value::as_str),
        ) {
            (Some("event_msg"), Some("user_message")) => {
                if let Some(content) = value.pointer("/payload/message").and_then(Value::as_str) {
                    primary_messages
                        .insert(message_key(ConversationEventKind::UserMessage, content));
                    primary.push(message_event(
                        line,
                        ConversationEventKind::UserMessage,
                        timestamp,
                        content,
                        attachment_count(&value),
                    ));
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                if let Some(content) = value.pointer("/payload/message").and_then(Value::as_str) {
                    primary_messages
                        .insert(message_key(ConversationEventKind::AgentMessage, content));
                    primary.push(message_event(
                        line,
                        ConversationEventKind::AgentMessage,
                        timestamp,
                        content,
                        0,
                    ));
                }
            }
            (Some("response_item"), Some("message")) => {
                let role = value.pointer("/payload/role").and_then(Value::as_str);
                if matches!(role, Some("user" | "assistant"))
                    && let Some(content) = response_message_text(value.pointer("/payload/content"))
                {
                    fallback.push(message_event(
                        line,
                        if role == Some("user") {
                            ConversationEventKind::UserMessage
                        } else {
                            ConversationEventKind::AgentMessage
                        },
                        timestamp,
                        &content,
                        0,
                    ));
                }
            }
            (Some("event_msg"), Some("exec_command_end")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    "shell",
                    value.pointer("/payload/status").and_then(Value::as_str),
                    value
                        .pointer("/payload/duration")
                        .and_then(Value::as_f64)
                        .map(|value| (value * 1000.0).max(0.0) as u64),
                    timestamp,
                );
            }
            (Some("event_msg"), Some("patch_apply_end")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    "apply_patch",
                    value
                        .pointer("/payload/status")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            value
                                .pointer("/payload/success")
                                .and_then(Value::as_bool)
                                .map(|success| if success { "completed" } else { "failed" })
                        }),
                    None,
                    timestamp,
                );
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = value
                    .pointer("/payload/name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                upsert_tool(
                    &mut tools,
                    line,
                    call_id,
                    name,
                    value.pointer("/payload/status").and_then(Value::as_str),
                    None,
                    timestamp,
                );
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                let call_id = value
                    .pointer("/payload/call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(tool) = tools.get_mut(call_id) {
                    tool.event.tool_status = Some("completed".into());
                }
            }
            (Some("response_item"), Some("web_search_call")) => {
                upsert_tool(
                    &mut tools,
                    line,
                    &format!("web-{line}"),
                    "web_search",
                    value.pointer("/payload/status").and_then(Value::as_str),
                    None,
                    timestamp,
                );
            }
            _ => {}
        }
    }
    for value in fallback {
        let content = value.event.content.as_deref().unwrap_or_default();
        if !primary_messages.contains(&message_key(value.event.kind, content)) {
            primary.push(value);
        }
    }
    primary.extend(tools.into_values());
    primary.sort_by_key(|value| value.line);
    if primary.is_empty() && !path.is_file() {
        warnings.push("Transcript is no longer available".into());
    }
    Ok(page_events(primary, cursor, limit, warnings))
}

fn message_key(kind: ConversationEventKind, content: &str) -> String {
    format!("{kind:?}:{}", content.trim())
}

fn read_claude_events(
    path: &Path,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let snapshot = read_jsonl_snapshot(path)?;
    let mut events = Vec::new();
    let mut tools: BTreeMap<String, IndexedEvent> = BTreeMap::new();
    for (line, value) in snapshot.records {
        let record_type = value.get("type").and_then(Value::as_str);
        if !matches!(record_type, Some("user" | "assistant")) {
            continue;
        }
        let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
        let role = value
            .pointer("/message/role")
            .and_then(Value::as_str)
            .unwrap_or_else(|| record_type.unwrap_or(""));
        let Some(content) = value.pointer("/message/content") else {
            continue;
        };
        if let Some(text) = response_message_text(Some(content))
            && !text.trim().is_empty()
        {
            events.push(message_event(
                line,
                if role == "assistant" {
                    ConversationEventKind::AgentMessage
                } else {
                    ConversationEventKind::UserMessage
                },
                timestamp,
                &text,
                claude_attachment_count(content),
            ));
        }
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let call_id = block.get("id").and_then(Value::as_str).unwrap_or("");
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        upsert_tool(
                            &mut tools,
                            line,
                            call_id,
                            name,
                            Some("started"),
                            None,
                            timestamp,
                        );
                    }
                    Some("tool_result") => {
                        let call_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if let Some(tool) = tools.get_mut(call_id) {
                            tool.event.tool_status = Some(
                                if block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                                {
                                    "failed"
                                } else {
                                    "completed"
                                }
                                .into(),
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    events.extend(tools.into_values());
    events.sort_by_key(|value| value.line);
    Ok(page_events(events, cursor, limit, snapshot.warnings))
}

struct JsonlSnapshot {
    records: Vec<(usize, Value)>,
    warnings: Vec<String>,
}

fn read_jsonl_snapshot(path: &Path) -> Result<JsonlSnapshot> {
    let file =
        File::open(path).with_context(|| format!("Cannot open transcript {}", path.display()))?;
    let length = file.metadata()?.len();
    if length > MAX_TRANSCRIPT_BYTES {
        bail!("Transcript exceeds the 256 MiB read limit");
    }
    let mut reader = BufReader::new(file.take(length));
    let mut output = Vec::new();
    let mut damaged_lines = 0_u64;
    let mut buffer = Vec::new();
    let mut line = 0_usize;
    loop {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        if read == 0 {
            break;
        }
        line += 1;
        if !buffer.ends_with(b"\n") {
            break;
        }
        if buffer.len() > MAX_LINE_BYTES {
            damaged_lines += 1;
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&buffer) {
            output.push((line, value));
        } else {
            damaged_lines += 1;
        }
    }
    Ok(JsonlSnapshot {
        records: output,
        warnings: (damaged_lines > 0)
            .then(|| format!("Skipped {damaged_lines} damaged transcript line(s)"))
            .into_iter()
            .collect(),
    })
}

fn workspace_matches(candidate: &Path, workspace: &Path) -> bool {
    platform_path::equivalent(candidate, workspace)
        || platform_path::starts_with(candidate, workspace)
}

fn page_events(
    values: Vec<IndexedEvent>,
    cursor: Option<&str>,
    limit: usize,
    warnings: Vec<String>,
) -> ConversationEventPage {
    let end = cursor
        .and_then(decode_cursor)
        .unwrap_or(values.len())
        .min(values.len());
    let limit = limit.clamp(1, 100);
    let mut start = end.saturating_sub(limit);
    let mut bytes = 0_usize;
    for index in (start..end).rev() {
        bytes = bytes.saturating_add(values[index].event.content.as_ref().map_or(0, String::len));
        if bytes > MAX_PAGE_BYTES {
            start = index.saturating_add(1);
            break;
        }
    }
    ConversationEventPage {
        events: values[start..end]
            .iter()
            .map(|value| value.event.clone())
            .collect(),
        next_cursor: (start > 0).then(|| encode_cursor(start)),
        warnings,
    }
}

fn message_event(
    line: usize,
    kind: ConversationEventKind,
    timestamp: Option<DateTime<Utc>>,
    content: &str,
    attachment_count: u64,
) -> IndexedEvent {
    let (content, truncated) = truncate_utf8(content, MAX_MESSAGE_BYTES);
    IndexedEvent {
        line,
        event: ConversationEvent {
            id: format!("event-{line}"),
            kind,
            timestamp,
            content: Some(content),
            tool_name: None,
            tool_status: None,
            duration_ms: None,
            attachment_count,
            truncated,
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn upsert_tool(
    tools: &mut BTreeMap<String, IndexedEvent>,
    line: usize,
    call_id: &str,
    name: &str,
    status: Option<&str>,
    duration_ms: Option<u64>,
    timestamp: Option<DateTime<Utc>>,
) {
    let key = if call_id.is_empty() {
        format!("line-{line}")
    } else {
        call_id.to_owned()
    };
    let event_id = format!("tool-{line}-{}", tools.len());
    let entry = tools.entry(key.clone()).or_insert_with(|| IndexedEvent {
        line,
        event: ConversationEvent {
            id: event_id,
            kind: ConversationEventKind::ToolSummary,
            timestamp,
            content: None,
            tool_name: Some(sanitize_tool_name(name)),
            tool_status: None,
            duration_ms: None,
            attachment_count: 0,
            truncated: false,
        },
    });
    entry.line = entry.line.min(line);
    if let Some(status) = status {
        entry.event.tool_status = Some(sanitize_tool_status(status));
    }
    if duration_ms.is_some() {
        entry.event.duration_ms = duration_ms;
    }
}

fn response_message_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let text = value
        .as_array()?
        .iter()
        .filter(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn attachment_count(value: &Value) -> u64 {
    value
        .pointer("/payload/images")
        .and_then(Value::as_array)
        .map_or(0, |values| values.len() as u64)
        + value
            .pointer("/payload/local_images")
            .and_then(Value::as_array)
            .map_or(0, |values| values.len() as u64)
}

fn claude_attachment_count(content: &Value) -> u64 {
    content.as_array().map_or(0, |blocks| {
        blocks
            .iter()
            .filter(|block| {
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("image" | "document")
                )
            })
            .count() as u64
    })
}

fn sanitize_title(value: Option<&str>) -> Option<String> {
    let normalized = value?
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = normalized.chars().take(MAX_TITLE_CHARS).collect::<String>();
    (!title.is_empty()).then_some(title)
}

fn sanitize_metadata(value: Option<String>) -> Option<String> {
    value.and_then(|value| sanitize_title(Some(&value)))
}

fn sanitize_tool_name(value: &str) -> String {
    sanitize_title(Some(value)).unwrap_or_else(|| "tool".into())
}

fn sanitize_tool_status(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "completed" | "success" | "succeeded" => "completed",
        "failed" | "error" => "failed",
        "started" | "running" | "in_progress" => "running",
        _ => "unknown",
    }
    .into()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

fn encode_cursor(index: usize) -> String {
    format!("p{index:x}")
}

fn decode_cursor(value: &str) -> Option<usize> {
    usize::from_str_radix(value.strip_prefix('p')?, 16).ok()
}

fn open_read_only(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open {} read-only", path.display()))
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

fn first_column_expression(
    columns: &BTreeSet<String>,
    candidates: &[&str],
    fallback: &str,
) -> String {
    let existing = candidates
        .iter()
        .filter(|column| columns.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    match existing.as_slice() {
        [] => fallback.into(),
        [only] => (*only).into(),
        values => format!("COALESCE({})", values.join(", ")),
    }
}

fn timestamp_from_integer(value: i64) -> Option<DateTime<Utc>> {
    if value.abs() >= 10_000_000_000 {
        Utc.timestamp_millis_opt(value).single()
    } else {
        Utc.timestamp_opt(value, 0).single()
    }
}

fn parse_json_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(value) = value.as_i64() {
        return timestamp_from_integer(value);
    }
    value
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn codex_lists_active_archived_and_missing_transcripts() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let transcript = dir.path().join("session.jsonl");
        fs::write(&transcript, "{}\n").unwrap();
        let database = Connection::open(dir.path().join("state_1.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, git_branch TEXT, archived INTEGER);").unwrap();
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 1, 2, 'main', 0)",
                rusqlite::params![
                    "private-id",
                    transcript.display().to_string(),
                    workspace.display().to_string(),
                    "Active"
                ],
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, 1, 3, NULL, 1)",
                rusqlite::params![
                    "archived-id",
                    dir.path().join("missing.jsonl").display().to_string(),
                    workspace.display().to_string(),
                    "Archived\nTitle"
                ],
            )
            .unwrap();
        drop(database);

        let sessions = CodexProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|value| value.native_ref == "private-id"
            && value.availability == SessionAvailability::Readable));
        assert!(sessions.iter().any(|value| value.archived
            && value.availability == SessionAvailability::MetadataOnly
            && value.title.as_deref() == Some("Archived Title")));
    }

    #[test]
    fn codex_excludes_private_event_types_and_tool_payloads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        for value in [
            serde_json::json!({"timestamp":"2026-08-13T10:00:00Z","type":"turn_context","payload":{"developer_instructions":"private developer"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"hello","images":["private-image"]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"answer"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:03Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"private reasoning"}]}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:04Z","type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"secret_tool","arguments":"private argument"}}),
            serde_json::json!({"timestamp":"2026-08-13T10:00:05Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"private output"}}),
        ] {
            writeln!(file, "{value}").unwrap();
        }
        write!(file, "{{\"type\":").unwrap();
        drop(file);

        let page = read_codex_events(&path, None, 100).unwrap();
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.events[0].content.as_deref(), Some("hello"));
        assert_eq!(page.events[0].attachment_count, 1);
        let debug = format!("{page:?}");
        for secret in [
            "private developer",
            "private reasoning",
            "private argument",
            "private output",
            "private-image",
        ] {
            assert!(!debug.contains(secret));
        }
    }

    #[test]
    fn claude_indexes_v1_and_reads_messages_and_tool_summaries() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("private-session.jsonl");
        let mut file = File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"system","message":{"content":"private system"}})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"user","timestamp":"2026-08-13T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"question"}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"assistant","timestamp":"2026-08-13T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"private"}}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"user","timestamp":"2026-08-13T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"private result"}]}})).unwrap();
        fs::write(projects.join("sessions-index.json"), serde_json::to_vec(&serde_json::json!({"version":1,"entries":[{"sessionId":"private-session","fullPath":transcript,"projectPath":workspace,"summary":"Summary\nTitle","created":1_700_000_000_000_i64,"modified":1_700_000_001_000_i64,"messageCount":3,"isSidechain":true}]})).unwrap()).unwrap();

        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Summary Title"));
        assert!(sessions[0].sidechain);
        let page = provider.read_events("private-session", None, 100).unwrap();
        assert_eq!(page.events.len(), 3);
        let debug = format!("{page:?}");
        assert!(!debug.contains("private system"));
        assert!(!debug.contains("private result"));
        assert!(!debug.contains("file_path"));
    }

    #[test]
    fn claude_discovers_readable_transcript_without_index_or_history() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let projects = dir.path().join("projects/project");
        fs::create_dir_all(&projects).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let transcript = projects.join("transcript-only.jsonl");
        let mut file = File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"user",
                "sessionId":"transcript-only",
                "cwd":workspace,
                "gitBranch":"feature/session-browser",
                "timestamp":"2026-08-13T10:00:00Z",
                "message":{"role":"user","content":"question"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"assistant",
                "sessionId":"transcript-only",
                "cwd":workspace,
                "timestamp":"2026-08-13T10:00:01Z",
                "message":{"role":"assistant","content":"answer"}
            })
        )
        .unwrap();
        drop(file);

        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_ref, "transcript-only");
        assert_eq!(sessions[0].availability, SessionAvailability::Readable);
        assert_eq!(
            sessions[0].git_branch.as_deref(),
            Some("feature/session-browser")
        );
        let page = provider.read_events("transcript-only", None, 100).unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].content.as_deref(), Some("question"));
        assert_eq!(page.events[1].content.as_deref(), Some("answer"));
    }

    #[test]
    fn claude_history_falls_back_to_metadata_without_caching_messages() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut history = File::create(dir.path().join("history.jsonl")).unwrap();
        for value in [
            serde_json::json!({"project":workspace,"sessionId":"private-session","timestamp":1_700_000_002_000_i64,"display":"private latest prompt","pastedContents":{"private":"content"}}),
            serde_json::json!({"project":workspace,"sessionId":"private-session","timestamp":1_700_000_001_000_i64,"display":"private first prompt"}),
            serde_json::json!({"project":dir.path().join("other"),"sessionId":"other-session","timestamp":1_700_000_003_000_i64,"display":"other prompt"}),
        ] {
            writeln!(history, "{value}").unwrap();
        }
        drop(history);

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_ref, "private-session");
        assert!(sessions[0].title.is_none());
        assert_eq!(sessions[0].availability, SessionAvailability::MetadataOnly);
        assert_eq!(sessions[0].created_at.unwrap().timestamp(), 1_700_000_001);
        assert_eq!(sessions[0].updated_at.unwrap().timestamp(), 1_700_000_002);
        let serialized = serde_json::to_string(&sessions[0]).unwrap();
        for private in [
            "private-session",
            "private latest prompt",
            "private first prompt",
            "content",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn claude_excludes_codexbar_probe_artifacts() {
        let dir = tempdir().unwrap();
        let probe = dir.path().join("ClaudeProbe");
        let projects = dir.path().join("projects/probe");
        fs::create_dir_all(&probe).unwrap();
        fs::create_dir_all(&projects).unwrap();
        fs::write(probe.join(".codexbar-session-id"), "probe-session").unwrap();
        let transcript = projects.join("probe-session.jsonl");
        fs::write(
            &transcript,
            format!(
                "{}\n",
                serde_json::json!({
                    "type":"user",
                    "sessionId":"probe-session",
                    "cwd":probe,
                    "message":{"role":"user","content":"/usage"}
                })
            ),
        )
        .unwrap();
        fs::write(
            dir.path().join("history.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::json!({"project":probe,"sessionId":"probe-session"}),
                serde_json::json!({"project":probe,"sessionId":"old-probe-session"})
            ),
        )
        .unwrap();

        let sessions = ClaudeProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&probe)
            .unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn title_and_message_limits_are_utf8_safe() {
        let title = "中".repeat(250);
        assert_eq!(sanitize_title(Some(&title)).unwrap().chars().count(), 200);
        let message = "中".repeat(MAX_MESSAGE_BYTES);
        let (truncated, was_truncated) = truncate_utf8(&message, MAX_MESSAGE_BYTES);
        assert!(was_truncated);
        assert!(truncated.is_char_boundary(truncated.len()));
    }
}
