use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use agentkib_core::{AgentKind, WorkspaceSummary};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageQuality {
    Exact,
    Estimated,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DatePrecision {
    Exact,
    Day,
    Aggregate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageCapabilities {
    pub token_breakdown: bool,
    pub daily_activity: bool,
    pub workspace_mapping: bool,
}

#[derive(Debug, Clone)]
pub struct ImportCursor {
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct UsageEvent {
    pub source_key: String,
    pub surface_agent: AgentKind,
    pub workspace_path: Option<PathBuf>,
    pub occurred_at: Option<DateTime<Utc>>,
    pub day: Option<NaiveDate>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub session_key: Option<String>,
    pub session_count: u64,
    pub date_precision: DatePrecision,
    pub quality: UsageQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub agent: AgentKind,
    pub available: bool,
    pub quality: UsageQuality,
    pub coverage_from: Option<NaiveDate>,
    pub coverage_to: Option<NaiveDate>,
    pub imported_events: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub error_params: BTreeMap<String, String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UsageBatch {
    pub events: Vec<UsageEvent>,
    pub status: ProviderStatus,
    pub cursor: Option<ImportCursor>,
    pub unchanged: bool,
}

pub trait UsageProvider {
    fn capabilities(&self) -> UsageCapabilities;
    fn import(&self, cursor: Option<ImportCursor>) -> Result<UsageBatch>;
}

#[derive(Debug, Clone)]
pub struct GitIdentityCandidate {
    pub email: String,
    pub label: String,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct GitCommitRecord {
    pub hash: String,
    pub authored_at: DateTime<Utc>,
    pub author_email: String,
}

#[derive(Debug, Clone)]
pub struct GitRepositorySnapshot {
    pub repository_group_id: String,
    pub path: PathBuf,
    pub fingerprint: String,
    pub changed: bool,
    pub commits: Vec<GitCommitRecord>,
    pub identities: Vec<GitIdentityCandidate>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InsightsQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub agent: Option<AgentKind>,
    pub workspace_id: Option<String>,
    pub repository_group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightsSummary {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub reasoning_tokens: u64,
    pub session_count: u64,
    pub my_commits: u64,
    pub all_commits: u64,
    pub attributed_commits: u64,
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub quality: UsageQuality,
    pub coverage_from: Option<NaiveDate>,
    pub coverage_to: Option<NaiveDate>,
    pub refreshed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapPoint {
    pub date: NaiveDate,
    pub tokens: u64,
    pub my_commits: u64,
    pub all_commits: u64,
    pub attributed_commits: u64,
    pub sessions: u64,
    pub quality: UsageQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentUsageBreakdown {
    pub agent: AgentKind,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub reasoning_tokens: u64,
    pub session_count: u64,
    pub quality: UsageQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageBreakdown {
    pub model: String,
    pub total_tokens: u64,
    pub session_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUsageBreakdown {
    pub workspace_id: Option<String>,
    pub name: String,
    pub total_tokens: u64,
    pub session_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryCommitBreakdown {
    pub repository_group_id: String,
    pub name: String,
    pub my_commits: u64,
    pub all_commits: u64,
    pub attributed_commits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Achievement {
    pub code: String,
    pub category: String,
    pub threshold: u64,
    pub progress: u64,
    pub unlocked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightsStatus {
    pub providers: Vec<ProviderStatus>,
    pub refreshed_at: Option<DateTime<Utc>>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIdentitySummary {
    pub id: String,
    pub label: String,
    pub source: String,
    pub enabled: bool,
}

pub fn collect_usage(cursors: &BTreeMap<AgentKind, String>) -> Vec<UsageBatch> {
    let home = dirs::home_dir();
    let providers: Vec<(AgentKind, Box<dyn UsageProvider>)> = vec![
        (
            AgentKind::Codex,
            Box::new(CodexProvider::new(home.as_deref())),
        ),
        (
            AgentKind::ClaudeCode,
            Box::new(ClaudeProvider::new(home.as_deref())),
        ),
        (AgentKind::OpenClaw, Box::new(OpenClawProvider)),
        (
            AgentKind::Hermes,
            Box::new(HermesProvider::new(home.as_deref())),
        ),
    ];
    providers
        .into_iter()
        .map(|(agent, provider)| {
            let cursor = cursors
                .get(&agent)
                .cloned()
                .map(|value| ImportCursor { value });
            provider.import(cursor).unwrap_or_else(|error| UsageBatch {
                events: Vec::new(),
                status: ProviderStatus {
                    agent,
                    available: false,
                    quality: UsageQuality::Incomplete,
                    coverage_from: None,
                    coverage_to: None,
                    imported_events: 0,
                    error_key: Some("errors.providerUnavailable".into()),
                    error_params: BTreeMap::new(),
                    error: Some(error.to_string()),
                },
                cursor: None,
                unchanged: false,
            })
        })
        .collect()
}

pub fn collect_git(
    workspaces: &[WorkspaceSummary],
    known_fingerprints: &BTreeMap<String, String>,
) -> Vec<GitRepositorySnapshot> {
    let mut repositories = BTreeMap::<String, PathBuf>::new();
    for workspace in workspaces {
        if let Some(group) = &workspace.repository_group_id {
            repositories
                .entry(group.clone())
                .or_insert_with(|| workspace.path.clone());
        }
    }
    repositories
        .into_iter()
        .map(
            |(group, path)| match collect_git_repository(&group, &path, known_fingerprints) {
                Ok(value) => value,
                Err(error) => GitRepositorySnapshot {
                    repository_group_id: group,
                    path,
                    fingerprint: String::new(),
                    changed: false,
                    commits: Vec::new(),
                    identities: Vec::new(),
                    error: Some(error.to_string()),
                },
            },
        )
        .collect()
}

struct CodexProvider {
    home: Option<PathBuf>,
}

impl CodexProvider {
    fn new(home: Option<&Path>) -> Self {
        let configured = std::env::var_os("CODEX_HOME").map(PathBuf::from);
        Self {
            home: configured.or_else(|| home.map(|path| path.join(".codex"))),
        }
    }
}

impl UsageProvider for CodexProvider {
    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            token_breakdown: true,
            daily_activity: true,
            workspace_mapping: true,
        }
    }

    fn import(&self, cursor: Option<ImportCursor>) -> Result<UsageBatch> {
        let home = self.home.as_ref().context("Codex Home was not found")?;
        if !home.is_dir() {
            bail!("Codex is not installed or Codex Home does not exist");
        }
        let mut source_paths: Vec<_> = WalkDir::new(home.join("sessions"))
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "jsonl")
            })
            .map(|entry| entry.into_path())
            .collect();
        if let Ok(entries) = fs::read_dir(home) {
            source_paths.extend(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| {
                        let name = path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("");
                        name.starts_with("state_")
                            && path.extension().is_some_and(|value| value == "sqlite")
                    }),
            );
        }
        let fingerprint = source_fingerprint(&source_paths);
        if cursor
            .as_ref()
            .is_some_and(|value| value.value == fingerprint)
        {
            return Ok(unchanged_batch(AgentKind::Codex, fingerprint));
        }
        let mut events = Vec::new();
        let mut detailed_sessions = BTreeSet::new();
        for path in source_paths
            .iter()
            .filter(|path| path.extension().is_some_and(|value| value == "jsonl"))
        {
            let file = match File::open(path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let session_key = path.display().to_string();
            let mut workspace = None;
            let mut session_counted = false;
            for (line_number, line) in BufReader::new(file).lines().enumerate() {
                let Ok(line) = line else { continue };
                if !line.contains("token_count") && !line.contains("session_meta") {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value.pointer("/payload/type").and_then(Value::as_str) == Some("session_meta")
                    || value.get("type").and_then(Value::as_str) == Some("session_meta")
                {
                    workspace = value
                        .pointer("/payload/cwd")
                        .or_else(|| value.pointer("/cwd"))
                        .and_then(Value::as_str)
                        .map(PathBuf::from);
                    continue;
                }
                if value.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let usage = value
                    .pointer("/payload/info/last_token_usage")
                    .or_else(|| value.pointer("/payload/last_token_usage"));
                let Some(usage) = usage else { continue };
                let total = json_u64(usage, "total_tokens");
                if total == 0 {
                    continue;
                }
                let occurred_at = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_datetime);
                let day = occurred_at.map(local_day);
                events.push(UsageEvent {
                    source_key: format!("codex:{}:{line_number}", path.display()),
                    surface_agent: AgentKind::Codex,
                    workspace_path: workspace.clone(),
                    occurred_at,
                    day,
                    model: value
                        .pointer("/payload/info/model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    input_tokens: json_u64(usage, "input_tokens"),
                    output_tokens: json_u64(usage, "output_tokens"),
                    cache_read_tokens: json_u64(usage, "cached_input_tokens"),
                    cache_write_tokens: 0,
                    reasoning_tokens: json_u64(usage, "reasoning_output_tokens"),
                    total_tokens: total,
                    session_key: Some(session_key.clone()),
                    session_count: u64::from(!session_counted),
                    date_precision: DatePrecision::Exact,
                    quality: UsageQuality::Exact,
                });
                session_counted = true;
                detailed_sessions.insert(path.to_path_buf());
            }
        }
        import_codex_fallbacks(home, &detailed_sessions, &mut events);
        Ok(finish_batch(
            AgentKind::Codex,
            events,
            None,
            Some(fingerprint),
        ))
    }
}

fn import_codex_fallbacks(
    home: &Path,
    detailed_sessions: &BTreeSet<PathBuf>,
    events: &mut Vec<UsageEvent>,
) {
    let Ok(entries) = fs::read_dir(home) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !name.starts_with("state_") || path.extension().is_none_or(|value| value != "sqlite") {
            continue;
        }
        let Ok(connection) = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let Ok(mut statement) = connection.prepare(
            "SELECT rollout_path, cwd, updated_at, tokens_used, model FROM threads WHERE tokens_used > 0",
        ) else { continue };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }) else {
            continue;
        };
        for row in rows.filter_map(Result::ok) {
            let rollout = row.0.map(PathBuf::from);
            if rollout
                .as_ref()
                .is_some_and(|value| detailed_sessions.contains(value))
            {
                continue;
            }
            let occurred_at = Utc.timestamp_opt(row.2, 0).single();
            events.push(UsageEvent {
                source_key: format!(
                    "codex-fallback:{}",
                    rollout.as_ref().unwrap_or(&path).display()
                ),
                surface_agent: AgentKind::Codex,
                workspace_path: row.1.map(PathBuf::from),
                occurred_at,
                day: None,
                model: row.4,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
                total_tokens: row.3.max(0) as u64,
                session_key: rollout.map(|value| value.display().to_string()),
                session_count: 1,
                date_precision: DatePrecision::Aggregate,
                quality: UsageQuality::Incomplete,
            });
        }
    }
}

struct ClaudeProvider {
    path: Option<PathBuf>,
}

impl ClaudeProvider {
    fn new(home: Option<&Path>) -> Self {
        Self {
            path: home.map(|path| path.join(".claude/stats-cache.json")),
        }
    }
}

impl UsageProvider for ClaudeProvider {
    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            token_breakdown: true,
            daily_activity: true,
            workspace_mapping: false,
        }
    }

    fn import(&self, cursor: Option<ImportCursor>) -> Result<UsageBatch> {
        let path = self.path.as_ref().context("Claude Home was not found")?;
        let fingerprint = source_fingerprint(std::slice::from_ref(path));
        if cursor
            .as_ref()
            .is_some_and(|value| value.value == fingerprint)
        {
            return Ok(unchanged_batch(AgentKind::ClaudeCode, fingerprint));
        }
        let value: Value =
            serde_json::from_slice(&fs::read(path).context("Claude stats cache was not found")?)?;
        let mut events = Vec::new();
        if let Some(days) = value.get("dailyModelTokens").and_then(Value::as_array) {
            for day_value in days {
                let Some(day) = day_value
                    .get("date")
                    .and_then(Value::as_str)
                    .and_then(parse_day)
                else {
                    continue;
                };
                if let Some(models) = day_value.get("tokensByModel").and_then(Value::as_object) {
                    for (model, tokens) in models {
                        let total = value_u64(tokens);
                        events.push(UsageEvent {
                            source_key: format!("claude:daily:{day}:{model}"),
                            surface_agent: AgentKind::ClaudeCode,
                            workspace_path: None,
                            occurred_at: None,
                            day: Some(day),
                            model: Some(model.clone()),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_write_tokens: 0,
                            reasoning_tokens: 0,
                            total_tokens: total,
                            session_key: None,
                            session_count: 0,
                            date_precision: DatePrecision::Day,
                            quality: UsageQuality::Exact,
                        });
                    }
                }
            }
        }
        if let Some(days) = value.get("dailyActivity").and_then(Value::as_array) {
            for day_value in days {
                let Some(day) = day_value
                    .get("date")
                    .and_then(Value::as_str)
                    .and_then(parse_day)
                else {
                    continue;
                };
                let sessions = day_value.get("sessionCount").map(value_u64).unwrap_or(0);
                if sessions > 0 {
                    events.push(UsageEvent {
                        source_key: format!("claude:sessions:{day}"),
                        surface_agent: AgentKind::ClaudeCode,
                        workspace_path: None,
                        occurred_at: None,
                        day: Some(day),
                        model: None,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        reasoning_tokens: 0,
                        total_tokens: 0,
                        session_key: None,
                        session_count: sessions,
                        date_precision: DatePrecision::Day,
                        quality: UsageQuality::Exact,
                    });
                }
            }
        }
        if let Some(models) = value.get("modelUsage").and_then(Value::as_object) {
            let has_daily_tokens = events.iter().any(|event| event.total_tokens > 0);
            for (model, usage) in models {
                let input = json_u64(usage, "inputTokens");
                let output = json_u64(usage, "outputTokens");
                let cache_read = json_u64(usage, "cacheReadInputTokens");
                let cache_write = json_u64(usage, "cacheCreationInputTokens");
                if input + output + cache_read + cache_write == 0 {
                    continue;
                }
                events.push(UsageEvent {
                    source_key: format!("claude:model-aggregate:{model}"),
                    surface_agent: AgentKind::ClaudeCode,
                    workspace_path: None,
                    occurred_at: None,
                    day: None,
                    model: Some(model.clone()),
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_write_tokens: cache_write,
                    reasoning_tokens: 0,
                    // Daily totals are authoritative when present; this event only enriches the
                    // component breakdown and must not add the lifetime total a second time.
                    total_tokens: if has_daily_tokens {
                        0
                    } else {
                        input.saturating_add(output)
                    },
                    session_key: None,
                    session_count: 0,
                    date_precision: DatePrecision::Aggregate,
                    quality: if has_daily_tokens {
                        UsageQuality::Exact
                    } else {
                        UsageQuality::Incomplete
                    },
                });
            }
        }
        if events.is_empty() {
            bail!("Claude stats cache does not contain usable daily data");
        }
        Ok(finish_batch(
            AgentKind::ClaudeCode,
            events,
            None,
            Some(fingerprint),
        ))
    }
}

struct OpenClawProvider;

impl UsageProvider for OpenClawProvider {
    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            token_breakdown: false,
            daily_activity: true,
            workspace_mapping: false,
        }
    }

    fn import(&self, _cursor: Option<ImportCursor>) -> Result<UsageBatch> {
        let output = command_output_with_timeout(
            "openclaw",
            &["gateway", "usage-cost", "--all-agents", "--json"],
            Duration::from_secs(10),
        )
        .map_err(|_| anyhow::anyhow!("OpenClaw local usage-cost query is unavailable"))?;
        let value: Value = serde_json::from_slice(&output)?;
        let mut events = Vec::new();
        collect_openclaw_values(&value, None, &mut events, "root");
        if events.is_empty() {
            bail!("OpenClaw did not return usable daily Token data");
        }
        Ok(finish_batch(AgentKind::OpenClaw, events, None, None))
    }
}

fn collect_openclaw_values(
    value: &Value,
    inherited_agent: Option<&str>,
    events: &mut Vec<UsageEvent>,
    key: &str,
) {
    match value {
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_openclaw_values(child, inherited_agent, events, &format!("{key}:{index}"));
            }
        }
        Value::Object(object) => {
            let agent = object
                .get("agent")
                .or_else(|| object.get("agentId"))
                .and_then(Value::as_str)
                .or(inherited_agent);
            let day = object
                .get("date")
                .or_else(|| object.get("day"))
                .and_then(Value::as_str)
                .and_then(parse_day);
            let total = object
                .get("totalTokens")
                .or_else(|| object.get("total_tokens"))
                .or_else(|| object.get("tokens"))
                .map(value_u64)
                .unwrap_or(0);
            if let Some(day) = day.filter(|_| total > 0) {
                let model = object.get("model").and_then(Value::as_str).unwrap_or("all");
                let channel = object
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("all");
                events.push(UsageEvent {
                    source_key: format!(
                        "openclaw:{day}:{}:{model}:{channel}",
                        agent.unwrap_or("all")
                    ),
                    surface_agent: AgentKind::OpenClaw,
                    workspace_path: None,
                    occurred_at: None,
                    day: Some(day),
                    model: (model != "all").then(|| model.to_string()),
                    input_tokens: object.get("inputTokens").map(value_u64).unwrap_or(0),
                    output_tokens: object.get("outputTokens").map(value_u64).unwrap_or(0),
                    cache_read_tokens: object.get("cacheReadTokens").map(value_u64).unwrap_or(0),
                    cache_write_tokens: object.get("cacheWriteTokens").map(value_u64).unwrap_or(0),
                    reasoning_tokens: object.get("reasoningTokens").map(value_u64).unwrap_or(0),
                    total_tokens: total,
                    session_key: None,
                    session_count: object.get("sessions").map(value_u64).unwrap_or(0),
                    date_precision: DatePrecision::Day,
                    quality: UsageQuality::Exact,
                });
                return;
            }
            for (child_key, child) in object {
                collect_openclaw_values(child, agent, events, &format!("{key}:{child_key}"));
            }
        }
        _ => {}
    }
}

struct HermesProvider {
    paths: Vec<PathBuf>,
}

impl HermesProvider {
    fn new(home: Option<&Path>) -> Self {
        let mut paths = Vec::new();
        if let Some(root) = home.map(|path| path.join(".hermes")) {
            if root.join("state.db").is_file() {
                paths.push(root.join("state.db"));
            }
            if root.is_dir() {
                paths.extend(
                    WalkDir::new(root.join("profiles"))
                        .max_depth(3)
                        .follow_links(false)
                        .into_iter()
                        .filter_map(Result::ok)
                        .filter(|entry| {
                            entry.file_type().is_file() && entry.file_name() == "state.db"
                        })
                        .map(|entry| entry.into_path()),
                );
            }
        }
        Self { paths }
    }
}

impl UsageProvider for HermesProvider {
    fn capabilities(&self) -> UsageCapabilities {
        UsageCapabilities {
            token_breakdown: false,
            daily_activity: false,
            workspace_mapping: true,
        }
    }

    fn import(&self, cursor: Option<ImportCursor>) -> Result<UsageBatch> {
        if self.paths.is_empty() {
            bail!("Hermes is not installed or state.db was not found");
        }
        let fingerprint = source_fingerprint(&self.paths);
        if cursor
            .as_ref()
            .is_some_and(|value| value.value == fingerprint)
        {
            return Ok(unchanged_batch(AgentKind::Hermes, fingerprint));
        }
        let mut events = Vec::new();
        for path in &self.paths {
            import_hermes_database(path, &mut events)?;
        }
        if events.is_empty() {
            bail!("Hermes state.db does not contain usable session statistics");
        }
        Ok(finish_batch(
            AgentKind::Hermes,
            events,
            None,
            Some(fingerprint),
        ))
    }
}

fn import_hermes_database(path: &Path, events: &mut Vec<UsageEvent>) -> Result<()> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut statement = connection.prepare("SELECT * FROM sessions")?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|value| value.to_string())
        .collect();
    let rows = statement.query_map([], |row| {
        let get_u64 = |candidates: &[&str]| -> u64 {
            candidates
                .iter()
                .find_map(|name| names.iter().position(|value| value == name))
                .and_then(|index| match row.get_ref(index).ok()? {
                    ValueRef::Integer(value) => Some(value.max(0) as u64),
                    ValueRef::Real(value) => Some(value.max(0.0) as u64),
                    _ => None,
                })
                .unwrap_or(0)
        };
        let get_string = |candidates: &[&str]| -> Option<String> {
            candidates
                .iter()
                .find_map(|name| names.iter().position(|value| value == name))
                .and_then(|index| row.get::<_, Option<String>>(index).ok().flatten())
        };
        Ok((
            get_string(&["id", "session_id"]),
            get_string(&["cwd", "working_directory", "project_path"]),
            get_string(&["updated_at", "created_at", "timestamp"]),
            get_string(&["model"]),
            get_u64(&["input_tokens"]),
            get_u64(&["output_tokens"]),
            get_u64(&["cache_read_tokens"]),
            get_u64(&["cache_write_tokens"]),
            get_u64(&["reasoning_tokens"]),
        ))
    })?;
    for (index, row) in rows.enumerate() {
        let (id, cwd, timestamp, model, input, output, cache_read, cache_write, reasoning) = row?;
        let total = input.saturating_add(output);
        if total == 0 {
            continue;
        }
        let occurred_at = timestamp.as_deref().and_then(parse_datetime);
        events.push(UsageEvent {
            source_key: format!(
                "hermes:{}:{}",
                path.display(),
                id.as_deref().unwrap_or(&index.to_string())
            ),
            surface_agent: AgentKind::Hermes,
            workspace_path: cwd.map(PathBuf::from),
            occurred_at,
            day: occurred_at.map(local_day),
            model,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            reasoning_tokens: reasoning,
            total_tokens: total,
            session_key: id,
            session_count: 1,
            date_precision: if occurred_at.is_some() {
                DatePrecision::Exact
            } else {
                DatePrecision::Aggregate
            },
            quality: UsageQuality::Exact,
        });
    }
    Ok(())
}

fn finish_batch(
    agent: AgentKind,
    events: Vec<UsageEvent>,
    error: Option<String>,
    cursor: Option<String>,
) -> UsageBatch {
    let coverage_from = events.iter().filter_map(|event| event.day).min();
    let coverage_to = events.iter().filter_map(|event| event.day).max();
    let quality = events
        .iter()
        .map(|event| event.quality)
        .max_by_key(|quality| quality_rank(*quality))
        .unwrap_or(UsageQuality::Incomplete);
    UsageBatch {
        status: ProviderStatus {
            agent,
            available: true,
            quality,
            coverage_from,
            coverage_to,
            imported_events: events.len(),
            error_key: error.as_ref().map(|_| "errors.providerUnavailable".into()),
            error_params: BTreeMap::new(),
            error,
        },
        events,
        cursor: cursor.map(|value| ImportCursor { value }),
        unchanged: false,
    }
}

fn unchanged_batch(agent: AgentKind, cursor: String) -> UsageBatch {
    UsageBatch {
        events: Vec::new(),
        status: ProviderStatus {
            agent,
            available: true,
            quality: UsageQuality::Exact,
            coverage_from: None,
            coverage_to: None,
            imported_events: 0,
            error_key: None,
            error_params: BTreeMap::new(),
            error: None,
        },
        cursor: Some(ImportCursor { value: cursor }),
        unchanged: true,
    }
}

fn source_fingerprint(paths: &[PathBuf]) -> String {
    let mut paths = paths.to_vec();
    paths.sort();
    let mut hasher = Sha256::new();
    for path in paths {
        let mut related = vec![path.clone()];
        if path
            .extension()
            .is_some_and(|value| value == "db" || value == "sqlite")
        {
            related.push(PathBuf::from(format!("{}-wal", path.display())));
            related.push(PathBuf::from(format!("{}-shm", path.display())));
        }
        for source in related {
            hasher.update(source.as_os_str().as_encoded_bytes());
            if let Ok(metadata) = fs::metadata(&source) {
                hasher.update(metadata.len().to_le_bytes());
                if let Ok(modified) = metadata.modified()
                    && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
                {
                    hasher.update(duration.as_nanos().to_le_bytes());
                }
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn quality_rank(value: UsageQuality) -> u8 {
    match value {
        UsageQuality::Exact => 0,
        UsageQuality::Estimated => 1,
        UsageQuality::Incomplete => 2,
    }
}

fn collect_git_repository(
    group: &str,
    path: &Path,
    known_fingerprints: &BTreeMap<String, String>,
) -> Result<GitRepositorySnapshot> {
    let refs = git_output(path, &["for-each-ref", "--format=%(objectname) %(refname)"])?;
    let head = git_output(path, &["rev-parse", "HEAD"]).unwrap_or_default();
    let fingerprint = format!("{head}\n{refs}");
    let mut identities = Vec::new();
    if let Ok(email) = git_output(path, &["config", "user.email"]) {
        let email = email.trim();
        if !email.is_empty() {
            identities.push(GitIdentityCandidate {
                email: email.to_string(),
                label: "settings.gitIdentityRepository".into(),
                source: format!("repository:{group}"),
            });
        }
    }
    if let Ok(email) = command_text("git", &["config", "--global", "user.email"]) {
        let email = email.trim();
        if !email.is_empty() {
            identities.push(GitIdentityCandidate {
                email: email.to_string(),
                label: "settings.gitIdentityGlobal".into(),
                source: "git-global".into(),
            });
        }
    }
    if known_fingerprints
        .get(group)
        .is_some_and(|value| value == &fingerprint)
    {
        return Ok(GitRepositorySnapshot {
            repository_group_id: group.to_string(),
            path: path.to_path_buf(),
            fingerprint,
            changed: false,
            commits: Vec::new(),
            identities,
            error: None,
        });
    }
    let raw = git_output(path, &["log", "--all", "--format=%H%x1f%aI%x1f%ae%x1e"])?;
    let commits = raw
        .split('\u{1e}')
        .filter_map(|record| {
            let mut fields = record.trim().split('\u{1f}');
            let hash = fields.next()?.trim();
            let authored_at = fields.next()?.trim().parse::<DateTime<Utc>>().ok()?;
            let email = fields.next()?.trim();
            (!hash.is_empty() && !email.is_empty()).then(|| GitCommitRecord {
                hash: hash.to_string(),
                authored_at,
                author_email: email.to_ascii_lowercase(),
            })
        })
        .collect();
    Ok(GitRepositorySnapshot {
        repository_group_id: group.to_string(),
        path: path.to_path_buf(),
        fingerprint,
        changed: true,
        commits,
        identities,
        error: None,
    })
}

fn git_output(path: &Path, args: &[&str]) -> Result<String> {
    let mut command_args = vec!["-C", path.to_str().context("Git path is not valid UTF-8")?];
    command_args.extend_from_slice(args);
    command_text("git", &command_args)
}

fn command_text(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("Failed to execute {program}"))?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn command_output_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to execute {program}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            if !output.status.success() {
                bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
            }
            return Ok(output.stdout);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{program} usage query timed out");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).map(value_u64).unwrap_or(0)
}

fn value_u64(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_i64().map(|number| number.max(0) as u64))
        .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
        .unwrap_or(0)
}

fn parse_day(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()
}

fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
        .or_else(|| {
            value
                .parse::<i64>()
                .ok()
                .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single())
        })
}

fn local_day(value: DateTime<Utc>) -> NaiveDate {
    value.with_timezone(&Local).date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn openclaw_daily_record_is_normalized_once() {
        let value = serde_json::json!({"days":[{"date":"2026-08-12","totalTokens":120,"inputTokens":80,"outputTokens":40}]});
        let mut events = Vec::new();
        collect_openclaw_values(&value, None, &mut events, "root");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].total_tokens, 120);
        assert_eq!(events[0].input_tokens + events[0].output_tokens, 120);
    }

    #[test]
    fn quality_orders_incomplete_as_worst() {
        assert!(quality_rank(UsageQuality::Incomplete) > quality_rank(UsageQuality::Exact));
    }

    #[test]
    fn codex_uses_last_usage_delta_and_ignores_message_lines() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions/2026/08/13");
        fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"session_meta","payload":{"cwd":dir.path()}})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"response_item","payload":{"content":"private prompt must be ignored"}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"timestamp":"2026-08-13T10:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":70,"output_tokens":30,"cached_input_tokens":10,"reasoning_output_tokens":5,"total_tokens":100},"total_token_usage":{"total_tokens":999}}}})).unwrap();
        let batch = CodexProvider {
            home: Some(dir.path().to_path_buf()),
        }
        .import(None)
        .unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].total_tokens, 100);
        assert_eq!(batch.events[0].session_count, 1);
    }

    #[test]
    fn claude_daily_total_is_not_duplicated_by_component_breakdown() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("stats-cache.json");
        fs::write(&path, serde_json::to_vec(&serde_json::json!({
            "dailyModelTokens": [{"date":"2026-08-13","tokensByModel":{"claude":100}}],
            "dailyActivity": [{"date":"2026-08-13","sessionCount":2}],
            "modelUsage": {"claude":{"inputTokens":70,"outputTokens":30,"cacheReadInputTokens":10,"cacheCreationInputTokens":5}}
        })).unwrap()).unwrap();
        let batch = ClaudeProvider { path: Some(path) }.import(None).unwrap();
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| event.total_tokens)
                .sum::<u64>(),
            100
        );
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| event.input_tokens)
                .sum::<u64>(),
            70
        );
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| event.session_count)
                .sum::<u64>(),
            2
        );
    }
}
