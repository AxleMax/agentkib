use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use agentkib_core::{
    AgentInstallation, AgentKind, AssetKind, CatalogAsset, CatalogScope, DiscoveryCandidate,
    DiscoveryEvidence, hash_content,
};
use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value as JsonValue;
use walkdir::{DirEntry, WalkDir};

pub trait WorkspaceDiscoveryProvider {
    fn installation(&self) -> AgentInstallation;
    fn discover(&self) -> Result<Vec<DiscoveryCandidate>>;
    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>>;
}

pub struct DiscoverySnapshot {
    pub candidates: Vec<DiscoveryCandidate>,
    pub installations: Vec<AgentInstallation>,
    pub home_assets: Vec<CatalogAsset>,
    pub errors: Vec<String>,
}

pub fn discover(scan_roots: &[(PathBuf, usize)]) -> DiscoverySnapshot {
    let providers: Vec<Box<dyn WorkspaceDiscoveryProvider>> = vec![
        Box::new(CodexProvider::default()),
        Box::new(ClaudeProvider::default()),
        Box::new(OpenClawProvider::default()),
        Box::new(HermesProvider::default()),
    ];
    let mut candidates = Vec::new();
    let mut installations = Vec::new();
    let mut home_assets = Vec::new();
    let mut errors = Vec::new();
    for provider in providers {
        let installation = provider.installation();
        let label = installation.agent.as_str();
        installations.push(installation);
        match provider.discover() {
            Ok(values) => candidates.extend(values),
            Err(error) => errors.push(format!("{label} workspace discovery failed: {error}")),
        }
        match provider.scan_home_assets() {
            Ok(values) => home_assets.extend(values),
            Err(error) => errors.push(format!("{label} Home asset scan failed: {error}")),
        }
    }
    for (root, depth) in scan_roots {
        match discover_scan_root(root, *depth) {
            Ok((values, scan_errors)) => {
                candidates.extend(values);
                errors.extend(scan_errors.into_iter().map(|error| {
                    format!("Scan root {} partially failed: {error}", root.display())
                }));
            }
            Err(error) => errors.push(format!("Scan root {} failed: {error}", root.display())),
        }
    }
    DiscoverySnapshot {
        candidates: normalize_and_merge(candidates),
        installations,
        home_assets,
        errors,
    }
}

#[derive(Default)]
struct CodexProvider {
    home: Option<PathBuf>,
}

impl CodexProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".codex")))
        })
    }
}

impl WorkspaceDiscoveryProvider for CodexProvider {
    fn installation(&self) -> AgentInstallation {
        installation(AgentKind::Codex, self.home())
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        for entry in fs::read_dir(home)? {
            let path = entry?.path();
            if !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))
            {
                continue;
            }
            let connection = open_read_only(&path)?;
            let columns = table_columns(&connection, "threads")?;
            if !columns.contains("cwd") {
                continue;
            }
            let timestamps: Vec<_> = ["recency_at", "updated_at", "created_at"]
                .into_iter()
                .filter(|column| columns.contains(*column))
                .collect();
            let timestamp_expression = match timestamps.as_slice() {
                [] => "NULL".to_string(),
                [only] => format!("MAX({only})"),
                values => format!("MAX(COALESCE({}))", values.join(", ")),
            };
            let sql = format!(
                "SELECT cwd, {timestamp_expression}, COUNT(*) \
                 FROM threads WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (path, updated, count) = row?;
                output.push(candidate(
                    PathBuf::from(path),
                    Some(AgentKind::Codex),
                    DiscoveryEvidence::SessionCwd,
                    updated.and_then(timestamp_from_integer),
                    count.max(0) as u64,
                    false,
                ));
            }
        }
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::Codex,
                    &home,
                    &["AGENTS.md", "config.toml", "skills", "agents", "hooks"],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct ClaudeProvider {
    home: Option<PathBuf>,
}

#[derive(Default)]
struct SessionActivity {
    session_ids: BTreeSet<String>,
    anonymous_sessions: u64,
    last_active_at: Option<DateTime<Utc>>,
}

impl SessionActivity {
    fn count(&self) -> u64 {
        self.session_ids.len() as u64 + self.anonymous_sessions
    }
}

impl ClaudeProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".claude")))
        })
    }
}

impl WorkspaceDiscoveryProvider for ClaudeProvider {
    fn installation(&self) -> AgentInstallation {
        installation(AgentKind::ClaudeCode, self.home())
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let mut aggregate: BTreeMap<PathBuf, SessionActivity> = BTreeMap::new();
        let history = home.join("history.jsonl");
        if let Ok(content) = fs::read_to_string(history) {
            for line in content.lines() {
                let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
                    continue;
                };
                let Some(path) = value.get("project").and_then(JsonValue::as_str) else {
                    continue;
                };
                let timestamp = value
                    .get("timestamp")
                    .and_then(JsonValue::as_i64)
                    .and_then(timestamp_from_integer);
                merge_activity(
                    &mut aggregate,
                    PathBuf::from(path),
                    session_identifier(&value),
                    timestamp,
                );
            }
        }
        let projects = home.join("projects");
        if projects.is_dir() {
            for entry in WalkDir::new(projects).max_depth(3).follow_links(false) {
                let entry = entry?;
                if entry.file_name() != "sessions-index.json" || !entry.file_type().is_file() {
                    continue;
                }
                let value: JsonValue = serde_json::from_str(&fs::read_to_string(entry.path())?)?;
                for item in session_index_entries(&value) {
                    let Some(path) = item.get("projectPath").and_then(JsonValue::as_str) else {
                        continue;
                    };
                    let timestamp = item
                        .get("modified")
                        .or_else(|| item.get("modifiedAt"))
                        .or_else(|| item.get("lastActivityAt"))
                        .and_then(parse_json_timestamp);
                    merge_activity(
                        &mut aggregate,
                        PathBuf::from(path),
                        session_identifier(item),
                        timestamp,
                    );
                }
            }
        }
        Ok(aggregate
            .into_iter()
            .map(|(path, activity)| {
                candidate(
                    path,
                    Some(AgentKind::ClaudeCode),
                    DiscoveryEvidence::SessionCwd,
                    activity.last_active_at,
                    activity.count(),
                    false,
                )
            })
            .collect())
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::ClaudeCode,
                    &home,
                    &[
                        "CLAUDE.md",
                        "settings.json",
                        "config.json",
                        "skills",
                        "agents",
                        "hooks",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct OpenClawProvider {
    home: Option<PathBuf>,
}

impl OpenClawProvider {
    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("OPENCLAW_STATE_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".openclaw")))
        })
    }
}

impl WorkspaceDiscoveryProvider for OpenClawProvider {
    fn installation(&self) -> AgentInstallation {
        installation(AgentKind::OpenClaw, self.home())
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let Some(home) = self.home().filter(|path| path.is_dir()) else {
            return Ok(Vec::new());
        };
        let config = home.join("openclaw.json");
        if !config.is_file() {
            return Ok(Vec::new());
        }
        let value: JsonValue = json5::from_str(&fs::read_to_string(config)?)?;
        let mut paths = Vec::new();
        if let Some(path) = value
            .pointer("/agents/defaults/workspace")
            .and_then(JsonValue::as_str)
        {
            paths.push(resolve_config_path(&home, path));
        }
        for key in ["list", "entries"] {
            for item in value
                .pointer(&format!("/agents/{key}"))
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = item.get("workspace").and_then(JsonValue::as_str) {
                    paths.push(resolve_config_path(&home, path));
                }
            }
        }
        Ok(paths
            .into_iter()
            .map(|path| {
                candidate(
                    path,
                    Some(AgentKind::OpenClaw),
                    DiscoveryEvidence::ConfiguredWorkspace,
                    None,
                    0,
                    true,
                )
            })
            .collect())
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        Ok(self
            .home()
            .filter(|path| path.is_dir())
            .map(|home| {
                scan_known_home(
                    AgentKind::OpenClaw,
                    &home,
                    &[
                        "openclaw.json",
                        "skills",
                        "agents",
                        "hooks",
                        "SOUL.md",
                        "MEMORY.md",
                    ],
                )
            })
            .transpose()?
            .unwrap_or_default())
    }
}

#[derive(Default)]
struct HermesProvider {
    home: Option<PathBuf>,
}

impl HermesProvider {
    fn homes(&self) -> Vec<PathBuf> {
        let base = self.home.clone().or_else(|| {
            env::var_os("HERMES_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".hermes")))
        });
        let Some(base) = base else { return Vec::new() };
        let mut homes = vec![base.clone()];
        let profiles = base.join("profiles");
        if let Ok(entries) = fs::read_dir(profiles) {
            homes.extend(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir()),
            );
        }
        homes
    }
}

impl WorkspaceDiscoveryProvider for HermesProvider {
    fn installation(&self) -> AgentInstallation {
        let home = self.homes().into_iter().next();
        installation(AgentKind::Hermes, home)
    }

    fn discover(&self) -> Result<Vec<DiscoveryCandidate>> {
        let mut output = Vec::new();
        for home in self.homes().into_iter().filter(|path| path.is_dir()) {
            let config = home.join("config.yaml");
            if let Ok(content) = fs::read_to_string(config)
                && let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&content)
                && let Some(path) = value
                    .get("terminal")
                    .and_then(|value| value.get("cwd"))
                    .and_then(serde_yaml::Value::as_str)
            {
                output.push(candidate(
                    resolve_config_path(&home, path),
                    Some(AgentKind::Hermes),
                    DiscoveryEvidence::ConfiguredWorkspace,
                    None,
                    0,
                    true,
                ));
            }
            let database = home.join("state.db");
            if database.is_file() {
                let connection = open_read_only(&database)?;
                if table_has_column(&connection, "sessions", "cwd")? {
                    let mut statement = connection.prepare("SELECT cwd, COUNT(*), MAX(started_at) FROM sessions WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd")?;
                    let rows = statement.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<f64>>(2)?,
                        ))
                    })?;
                    for row in rows {
                        let (path, count, timestamp) = row?;
                        output.push(candidate(
                            PathBuf::from(path),
                            Some(AgentKind::Hermes),
                            DiscoveryEvidence::SessionCwd,
                            timestamp.and_then(timestamp_from_float),
                            count.max(0) as u64,
                            false,
                        ));
                    }
                }
            }
        }
        Ok(output)
    }

    fn scan_home_assets(&self) -> Result<Vec<CatalogAsset>> {
        let mut assets = Vec::new();
        for home in self.homes().into_iter().filter(|path| path.is_dir()) {
            assets.extend(scan_known_home(
                AgentKind::Hermes,
                &home,
                &[
                    "config.yaml",
                    "SOUL.md",
                    "MEMORY.md",
                    "skills",
                    "profiles",
                    "hooks",
                ],
            )?);
        }
        Ok(assets)
    }
}

fn discover_scan_root(
    root: &Path,
    max_depth: usize,
) -> Result<(Vec<DiscoveryCandidate>, Vec<String>)> {
    let root = root.canonicalize()?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(max_depth.clamp(1, 8))
        .follow_links(false)
        .into_iter()
        .filter_entry(allowed_scan_entry)
    {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        if entry.file_type().is_dir() && has_project_marker(entry.path()) {
            output.push(candidate(
                entry.path().to_path_buf(),
                None,
                DiscoveryEvidence::ScanMarker,
                modified_at(entry.path()).ok(),
                0,
                true,
            ));
        }
    }
    Ok((output, errors))
}

fn allowed_scan_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | ".next"
                | ".turbo"
                | ".venv"
                | "venv"
                | "vendor"
                | "coverage"
                | "Pods"
                | "DerivedData"
                | "Library"
        )
    ) && !entry.path_is_symlink()
}

fn normalize_and_merge(candidates: Vec<DiscoveryCandidate>) -> Vec<DiscoveryCandidate> {
    let mut grouped: BTreeMap<(PathBuf, Option<AgentKind>, DiscoveryEvidence), DiscoveryCandidate> =
        BTreeMap::new();
    for mut candidate in candidates {
        let Some(path) = normalize_workspace(&candidate.path, candidate.explicit_workspace) else {
            continue;
        };
        candidate.repository_group_id = repository_group_id(&path);
        candidate.path = path.clone();
        let key = (path, candidate.source_agent, candidate.evidence);
        grouped
            .entry(key)
            .and_modify(|existing| {
                existing.session_count = existing
                    .session_count
                    .saturating_add(candidate.session_count);
                existing.last_active_at = latest(existing.last_active_at, candidate.last_active_at);
            })
            .or_insert(candidate);
    }
    grouped.into_values().collect()
}

fn normalize_workspace(path: &Path, explicit: bool) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let home = dirs::home_dir();
    let mut current = Some(canonical.as_path());
    while let Some(path) = current {
        if has_project_marker(path) && home.as_deref() != Some(path) {
            return path.canonicalize().ok();
        }
        current = path.parent();
    }
    explicit.then_some(canonical)
}

fn has_project_marker(path: &Path) -> bool {
    [
        ".agentkib",
        ".git",
        "AGENTS.md",
        "CLAUDE.md",
        ".codex",
        ".claude",
    ]
    .into_iter()
    .any(|name| path.join(name).exists())
}

fn repository_group_id(path: &Path) -> Option<String> {
    let marker = path.join(".git");
    let git_dir = if marker.is_dir() {
        marker.canonicalize().ok()?
    } else {
        let content = fs::read_to_string(marker).ok()?;
        let relative = content.trim().strip_prefix("gitdir:")?.trim();
        path.join(relative).canonicalize().ok()?
    };
    let common = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| git_dir.join(value.trim()))
        .and_then(|value| value.canonicalize().ok())
        .unwrap_or(git_dir);
    Some(hash_content(common.to_string_lossy().as_bytes()))
}

fn scan_known_home(agent: AgentKind, home: &Path, names: &[&str]) -> Result<Vec<CatalogAsset>> {
    let allowed: BTreeSet<_> = names.iter().copied().collect();
    let mut output = Vec::new();
    for name in names {
        let path = home.join(name);
        if !path.exists() {
            continue;
        }
        if path.is_file() {
            if !is_private_home_file(&path) {
                output.push(home_asset(agent, &path, home_asset_kind(&path))?);
            }
            continue;
        }
        for entry in WalkDir::new(&path)
            .max_depth(4)
            .follow_links(false)
            .into_iter()
            .filter_entry(allowed_home_entry)
        {
            let entry = entry?;
            if !entry.file_type().is_file() || is_private_home_file(entry.path()) {
                continue;
            }
            if *name == "skills"
                && entry.path().file_name().and_then(|value| value.to_str()) != Some("SKILL.md")
            {
                continue;
            }
            let kind = home_asset_kind(entry.path());
            output.push(home_asset(agent, entry.path(), kind)?);
        }
    }
    output.retain(|asset| {
        asset
            .path
            .strip_prefix(home)
            .ok()
            .and_then(|path| path.components().next())
            .and_then(|part| part.as_os_str().to_str())
            .is_some_and(|name| allowed.contains(name))
    });
    Ok(output)
}

fn allowed_home_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | "__pycache__"
                | ".venv"
                | "venv"
        )
    ) && !entry.path_is_symlink()
}

fn is_private_home_file(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    text.contains("credential")
        || text.contains("telemetry")
        || text.ends_with(".env")
        || text.contains("session")
        || text.ends_with("state.db")
        || path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name.contains("token")
                    || name.contains("secret")
                    || name.ends_with(".pem")
                    || name.ends_with(".key")
            })
}

fn home_asset_kind(path: &Path) -> AssetKind {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.eq_ignore_ascii_case("SKILL.md") || text.contains("/skills/") {
        AssetKind::Skill
    } else if name.eq_ignore_ascii_case("MEMORY.md") || text.contains("/memory/") {
        AssetKind::Memory
    } else if text.contains("/hooks/") {
        AssetKind::Hook
    } else if text.contains("/agents/") || text.contains("/profiles/") {
        AssetKind::Agent
    } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
        AssetKind::Instruction
    } else {
        AssetKind::Configuration
    }
}

fn home_asset(agent: AgentKind, path: &Path, kind: AssetKind) -> Result<CatalogAsset> {
    let metadata = fs::metadata(path)?;
    let name = if matches!(kind, AssetKind::Skill)
        && path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md")
    {
        path.parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
    } else {
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("asset")
    };
    Ok(CatalogAsset {
        id: String::new(),
        scope: CatalogScope::AgentHome,
        workspace_id: None,
        agent: Some(agent),
        kind,
        name: name.to_string(),
        path: path.to_path_buf(),
        summary: format!("{} Home asset (read-only)", agent.as_str()),
        summary_key: Some("assets.summary.homeAsset".into()),
        summary_params: [("agent".into(), agent.as_str().into())]
            .into_iter()
            .collect(),
        size: metadata.len(),
        modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
    })
}

fn installation(agent: AgentKind, home: Option<PathBuf>) -> AgentInstallation {
    let installed = home.as_ref().is_some_and(|path| path.is_dir());
    AgentInstallation {
        agent,
        installed,
        configured: installed,
        version: None,
        home,
        warnings: Vec::new(),
    }
}

fn candidate(
    path: PathBuf,
    source_agent: Option<AgentKind>,
    evidence: DiscoveryEvidence,
    last_active_at: Option<DateTime<Utc>>,
    session_count: u64,
    explicit_workspace: bool,
) -> DiscoveryCandidate {
    DiscoveryCandidate {
        path,
        source_agent,
        evidence,
        last_active_at,
        session_count,
        explicit_workspace,
        repository_group_id: None,
    }
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(2))?;
    Ok(connection)
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(table_columns(connection, table)?.contains(column))
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut output = BTreeSet::new();
    for value in columns {
        output.insert(value?);
    }
    Ok(output)
}

fn timestamp_from_integer(value: i64) -> Option<DateTime<Utc>> {
    if value <= 0 {
        return None;
    }
    if value > 10_000_000_000 {
        Utc.timestamp_millis_opt(value).single()
    } else {
        Utc.timestamp_opt(value, 0).single()
    }
}

fn timestamp_from_float(value: f64) -> Option<DateTime<Utc>> {
    timestamp_from_integer(value as i64)
}

fn parse_json_timestamp(value: &JsonValue) -> Option<DateTime<Utc>> {
    value.as_i64().and_then(timestamp_from_integer).or_else(|| {
        value.as_str().and_then(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.with_timezone(&Utc))
        })
    })
}

fn merge_activity(
    values: &mut BTreeMap<PathBuf, SessionActivity>,
    path: PathBuf,
    session_id: Option<String>,
    timestamp: Option<DateTime<Utc>>,
) {
    let activity = values.entry(path).or_default();
    if let Some(session_id) = session_id {
        activity.session_ids.insert(session_id);
    } else {
        activity.anonymous_sessions = activity.anonymous_sessions.saturating_add(1);
    }
    activity.last_active_at = latest(activity.last_active_at, timestamp);
}

fn session_identifier(value: &JsonValue) -> Option<String> {
    ["sessionId", "session_id", "id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(JsonValue::as_str))
        .map(str::to_owned)
}

fn session_index_entries(value: &JsonValue) -> Vec<&JsonValue> {
    value
        .get("entries")
        .and_then(JsonValue::as_array)
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .collect()
}

fn latest(left: Option<DateTime<Utc>>, right: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(relative))
            .unwrap_or_else(|| PathBuf::from(value));
    }
    PathBuf::from(value)
}

fn resolve_config_path(home: &Path, value: &str) -> PathBuf {
    let expanded = expand_home(value);
    if expanded.is_absolute() {
        expanded
    } else {
        home.join(expanded)
    }
}

fn modified_at(path: &Path) -> Result<DateTime<Utc>> {
    Ok(DateTime::<Utc>::from(
        fs::metadata(path)?
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalizes_nested_directory_to_project_marker() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("packages/api/src")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let result = normalize_workspace(&dir.path().join("packages/api/src"), false).unwrap();
        assert_eq!(result, dir.path().canonicalize().unwrap());
    }

    #[test]
    fn ignores_existing_unmarked_session_directory() {
        let dir = tempdir().unwrap();
        assert!(normalize_workspace(dir.path(), false).is_none());
        assert_eq!(
            normalize_workspace(dir.path(), true).unwrap(),
            dir.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn scan_root_skips_dependency_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("app/.git")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/fake/.git")).unwrap();
        let (discovered, errors) = discover_scan_root(dir.path(), 5).unwrap();
        assert!(errors.is_empty());
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].path,
            dir.path().join("app").canonicalize().unwrap()
        );
    }

    #[test]
    fn worktrees_share_repository_group_without_merging_paths() {
        let dir = tempdir().unwrap();
        let main = dir.path().join("main");
        let worktree = dir.path().join("worktree");
        fs::create_dir_all(main.join(".git/worktrees/feature")).unwrap();
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            "gitdir: ../main/.git/worktrees/feature\n",
        )
        .unwrap();
        fs::write(main.join(".git/worktrees/feature/commondir"), "../..\n").unwrap();

        assert_ne!(
            main.canonicalize().unwrap(),
            worktree.canonicalize().unwrap()
        );
        assert_eq!(repository_group_id(&main), repository_group_id(&worktree));
    }

    #[test]
    fn codex_reads_legacy_thread_timestamp_columns() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let agent_home = dir.path().join("codex");
        fs::create_dir(&agent_home).unwrap();
        let database = Connection::open(agent_home.join("state_test.sqlite")).unwrap();
        database
            .execute_batch("CREATE TABLE threads(cwd TEXT, updated_at INTEGER);")
            .unwrap();
        database
            .execute(
                "INSERT INTO threads(cwd, updated_at) VALUES (?1, 1700000000)",
                [workspace.display().to_string()],
            )
            .unwrap();
        drop(database);

        let candidates = CodexProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 1);
    }

    #[test]
    fn claude_counts_sessions_without_retaining_prompt_data() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let agent_home = dir.path().join("claude");
        fs::create_dir_all(agent_home.join("projects/p1")).unwrap();
        fs::write(
            agent_home.join("history.jsonl"),
            format!(
                "{{\"project\":\"{}\",\"sessionId\":\"private-session\",\"display\":\"private prompt\"}}\n",
                workspace.display()
            ),
        )
        .unwrap();
        fs::write(
            agent_home.join("projects/p1/sessions-index.json"),
            format!(
                "{{\"entries\":[{{\"projectPath\":\"{}\",\"sessionId\":\"private-session\",\"messageCount\":42}}]}}",
                workspace.display()
            ),
        )
        .unwrap();

        let candidates = ClaudeProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].session_count, 1);
        assert!(!format!("{candidates:?}").contains("private-session"));
        assert!(!format!("{candidates:?}").contains("private prompt"));
    }

    #[test]
    fn openclaw_supports_json5_and_multiple_workspaces() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let agent_home = dir.path().join("openclaw");
        fs::create_dir(&agent_home).unwrap();
        fs::write(
            agent_home.join("openclaw.json"),
            format!(
                "{{ agents: {{ defaults: {{ workspace: '{}' }}, list: [{{ workspace: '{}' }}], }}, }}",
                first.display(),
                second.display()
            ),
        )
        .unwrap();

        let candidates = OpenClawProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|value| value.explicit_workspace));
    }

    #[test]
    fn hermes_discovers_default_and_profile_workspaces() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let agent_home = dir.path().join("hermes");
        fs::create_dir_all(agent_home.join("profiles/work")).unwrap();
        fs::write(
            agent_home.join("config.yaml"),
            format!("terminal:\n  cwd: {}\n", first.display()),
        )
        .unwrap();
        fs::write(
            agent_home.join("profiles/work/config.yaml"),
            format!("terminal:\n  cwd: {}\n", second.display()),
        )
        .unwrap();

        let candidates = HermesProvider {
            home: Some(agent_home),
        }
        .discover()
        .unwrap();
        assert_eq!(candidates.len(), 2);
    }

    #[test]
    fn home_catalog_excludes_private_files_and_classifies_memory() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("MEMORY.md"), "private memory body").unwrap();
        fs::write(dir.path().join("credentials.json"), "secret").unwrap();
        fs::create_dir_all(dir.path().join("skills/example/.git")).unwrap();
        fs::write(dir.path().join("skills/example/SKILL.md"), "skill body").unwrap();
        fs::write(
            dir.path().join("skills/example/script.py"),
            "print('noise')",
        )
        .unwrap();
        fs::write(dir.path().join("skills/example/.git/index"), "noise").unwrap();
        let assets = scan_known_home(
            AgentKind::Hermes,
            dir.path(),
            &["MEMORY.md", "credentials.json", "skills"],
        )
        .unwrap();
        assert_eq!(assets.len(), 2);
        assert!(assets.iter().any(|value| value.kind == AssetKind::Memory));
        assert!(assets.iter().any(|value| value.name == "example"));
    }
}
