use std::fs;
use std::path::{Path, PathBuf};

use std::collections::{BTreeMap, BTreeSet};

use agenthub_core::{
    ActivityRecord, AgentInstallation, AgentKind, AssetKind, CatalogAsset, CatalogScope,
    DiscoveryCandidate, DiscoveryEvidence, DiscoveryReport, ExcludedWorkspace, MemoryProposal,
    MemoryRecord, MemoryStatus, ScanRoot, WorkspaceSource, WorkspaceStatus, WorkspaceSummary,
    hash_content, load_manifest, scan_workspace,
};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_default() -> Result<Self> {
        Self::open(&default_database_path()?)
    }

    fn migrate(&self) -> Result<()> {
        self.connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;",
        )?;
        let current_version = self
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .and_then(|value| value.parse::<u32>().ok());
        if current_version.is_some_and(|version| version >= 2) {
            return Ok(());
        }
        self.connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS memories (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               memory_type TEXT NOT NULL,
               content TEXT NOT NULL,
               status TEXT NOT NULL,
               source_agent TEXT,
               source_thread TEXT,
               source_reference TEXT,
               created_at TEXT NOT NULL,
               approved_at TEXT,
               invalidated_by TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);
             CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content);
             CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
               INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
               DELETE FROM memories_fts WHERE id = old.id;
               INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
               DELETE FROM memories_fts WHERE id = old.id;
             END;
             CREATE TABLE IF NOT EXISTS audit_events (
               id TEXT PRIMARY KEY,
               project_id TEXT,
               action TEXT NOT NULL,
               detail TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS schema_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               id TEXT PRIMARY KEY,
               canonical_path TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               repository_group_id TEXT,
               manifest_workspace_id TEXT,
               status TEXT NOT NULL,
               asset_count INTEGER NOT NULL DEFAULT 0,
               warning_count INTEGER NOT NULL DEFAULT 0,
               last_active_at TEXT,
               last_discovered_at TEXT NOT NULL,
               last_scanned_at TEXT
             );
             CREATE TABLE IF NOT EXISTS workspace_sources (
               workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
               agent TEXT NOT NULL,
               evidence TEXT NOT NULL,
               session_count INTEGER NOT NULL DEFAULT 0,
               last_active_at TEXT,
               PRIMARY KEY(workspace_id, agent, evidence)
             );
             CREATE TABLE IF NOT EXISTS catalog_assets (
               id TEXT PRIMARY KEY,
               scope TEXT NOT NULL,
               workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
               agent TEXT,
               kind TEXT NOT NULL,
               name TEXT NOT NULL,
               path TEXT NOT NULL,
               summary TEXT NOT NULL,
               size INTEGER NOT NULL DEFAULT 0,
               modified_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_catalog_assets_workspace ON catalog_assets(workspace_id);
             CREATE INDEX IF NOT EXISTS idx_catalog_assets_search ON catalog_assets(name, path, summary);
             CREATE TABLE IF NOT EXISTS agent_installations (
               agent TEXT PRIMARY KEY,
               installed INTEGER NOT NULL,
               configured INTEGER NOT NULL,
               version TEXT,
               home TEXT,
               warnings TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS scan_roots (
               id TEXT PRIMARY KEY,
               canonical_path TEXT NOT NULL UNIQUE,
               enabled INTEGER NOT NULL DEFAULT 1,
               max_depth INTEGER NOT NULL DEFAULT 5,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS excluded_workspaces (
               canonical_path TEXT PRIMARY KEY,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS discovery_runs (
               id TEXT PRIMARY KEY,
               started_at TEXT NOT NULL,
               finished_at TEXT NOT NULL,
               discovered_count INTEGER NOT NULL,
               removed_count INTEGER NOT NULL,
               errors TEXT NOT NULL
             );
             INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '2');
             COMMIT;"
        )?;
        Ok(())
    }

    pub fn sync_discovery(
        &self,
        candidates: &[DiscoveryCandidate],
        installations: &[AgentInstallation],
        home_assets: &[CatalogAsset],
        started_at: DateTime<Utc>,
        errors: &[String],
    ) -> Result<DiscoveryReport> {
        let transaction = self.connection.unchecked_transaction()?;
        let excluded = excluded_paths(&transaction)?;
        let mut grouped: BTreeMap<PathBuf, Vec<&DiscoveryCandidate>> = BTreeMap::new();
        for candidate in candidates {
            if candidate.path.is_dir() && !excluded.contains(&candidate.path) {
                grouped
                    .entry(candidate.path.clone())
                    .or_default()
                    .push(candidate);
            }
        }
        let discovered_paths: BTreeSet<_> = grouped.keys().cloned().collect();
        let mut discovery_errors = errors.to_vec();
        for (path, sources) in grouped {
            let workspace_id = upsert_workspace(&transaction, &path, &sources)?;
            if let Err(error) = refresh_workspace_record(&transaction, &workspace_id, &path) {
                record_scan_failure(&transaction, &workspace_id)?;
                discovery_errors.push(format!("工作区 {} 扫描失败：{error}", path.display()));
            }
        }

        let mut stale = Vec::new();
        {
            let mut statement = transaction.prepare("SELECT id, canonical_path FROM workspaces")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            })?;
            for row in rows {
                let (id, path) = row?;
                // Provider 读取失败或用户撤销扫描目录时，不能误删仍然存在的工作区。
                // 历史清理由路径是否仍存在驱动，来源在后续成功发现时再聚合更新。
                if !path.is_dir() {
                    stale.push(id);
                }
            }
        }
        for id in &stale {
            transaction.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        }

        transaction.execute("DELETE FROM catalog_assets WHERE scope = 'agent-home'", [])?;
        for asset in home_assets {
            insert_catalog_asset(&transaction, asset)?;
        }
        transaction.execute("DELETE FROM agent_installations", [])?;
        for installation in installations {
            transaction.execute(
                "INSERT INTO agent_installations(agent, installed, configured, version, home, warnings) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    enum_string(installation.agent)?,
                    installation.installed,
                    installation.configured,
                    installation.version,
                    installation.home.as_ref().map(|value| value.display().to_string()),
                    serde_json::to_string(&installation.warnings)?,
                ],
            )?;
        }
        let finished_at = Utc::now();
        let report = DiscoveryReport {
            started_at,
            finished_at,
            discovered_count: discovered_paths.len(),
            removed_count: stale.len(),
            errors: discovery_errors.clone(),
        };
        transaction.execute(
            "INSERT INTO discovery_runs(id, started_at, finished_at, discovered_count, removed_count, errors) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![Uuid::new_v4().to_string(), report.started_at.to_rfc3339(), report.finished_at.to_rfc3339(), report.discovered_count as i64, report.removed_count as i64, serde_json::to_string(&discovery_errors)?],
        )?;
        transaction.execute(
            "INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?1, NULL, 'discovery.complete', ?2, ?3)",
            params![Uuid::new_v4().to_string(), format!("{} workspaces, {} errors", report.discovered_count, discovery_errors.len()), finished_at.to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(report)
    }

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceSummary>> {
        let mut statement = self.connection.prepare(
            "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces ORDER BY COALESCE(last_active_at, last_scanned_at) DESC, name ASC",
        )?;
        let rows = statement.query_map([], row_to_workspace)?;
        let mut values = Vec::new();
        for row in rows {
            let mut workspace = row?;
            workspace.sources = self.workspace_sources(&workspace.id)?;
            values.push(workspace);
        }
        Ok(values)
    }

    pub fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceSummary>> {
        let mut value = self.connection.query_row(
            "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces WHERE id = ?1",
            params![id],
            row_to_workspace,
        ).optional()?;
        if let Some(workspace) = value.as_mut() {
            workspace.sources = self.workspace_sources(id)?;
        }
        Ok(value)
    }

    pub fn workspace_path(&self, id: &str) -> Result<PathBuf> {
        self.connection
            .query_row(
                "SELECT canonical_path FROM workspaces WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(PathBuf::from)
            .context("工作区不存在")
    }

    pub fn add_workspace(&self, path: &Path) -> Result<WorkspaceSummary> {
        let path = path.canonicalize().context("工作区不存在")?;
        if !path.is_dir() {
            bail!("工作区必须是目录");
        }
        let candidate = DiscoveryCandidate {
            path: path.clone(),
            source_agent: None,
            evidence: DiscoveryEvidence::Manual,
            last_active_at: Some(Utc::now()),
            session_count: 0,
            explicit_workspace: true,
            repository_group_id: None,
        };
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM excluded_workspaces WHERE canonical_path = ?1",
            params![path.display().to_string()],
        )?;
        let workspace_id = upsert_workspace(&transaction, &path, &[&candidate])?;
        if refresh_workspace_record(&transaction, &workspace_id, &path).is_err() {
            record_scan_failure(&transaction, &workspace_id)?;
        }
        transaction.commit()?;
        self.get_workspace_by_path(&path)?.context("工作区写入失败")
    }

    pub fn refresh_workspace(&self, id: &str) -> Result<WorkspaceSummary> {
        let path = self.workspace_path(id)?;
        let transaction = self.connection.unchecked_transaction()?;
        let result = refresh_workspace_record(&transaction, id, &path);
        if result.is_err() {
            record_scan_failure(&transaction, id)?;
        }
        transaction.commit()?;
        result?;
        self.get_workspace(id)?.context("工作区不存在")
    }

    pub fn exclude_workspace(&self, id: &str) -> Result<()> {
        let path = self.workspace_path(id)?;
        self.connection.execute(
            "INSERT OR REPLACE INTO excluded_workspaces(canonical_path, created_at) VALUES (?1, ?2)",
            params![path.display().to_string(), Utc::now().to_rfc3339()],
        )?;
        self.connection
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_excluded_workspaces(&self) -> Result<Vec<ExcludedWorkspace>> {
        let mut statement = self.connection.prepare(
            "SELECT canonical_path, created_at FROM excluded_workspaces ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let created: String = row.get(1)?;
            Ok(ExcludedWorkspace {
                path: PathBuf::from(row.get::<_, String>(0)?),
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn restore_excluded_workspace(&self, path: &Path) -> Result<()> {
        self.connection.execute(
            "DELETE FROM excluded_workspaces WHERE canonical_path = ?1",
            params![path.display().to_string()],
        )?;
        Ok(())
    }

    pub fn list_scan_roots(&self) -> Result<Vec<ScanRoot>> {
        let mut statement = self.connection.prepare("SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots ORDER BY created_at ASC")?;
        let rows = statement.query_map([], |row| {
            let created: String = row.get(4)?;
            Ok(ScanRoot {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                enabled: row.get(2)?,
                max_depth: row.get::<_, i64>(3)? as usize,
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn add_scan_root(&self, path: &Path, max_depth: usize) -> Result<ScanRoot> {
        let path = path.canonicalize().context("扫描目录不存在")?;
        if !path.is_dir() {
            bail!("扫描根必须是目录");
        }
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now();
        self.connection.execute(
            "INSERT INTO scan_roots(id, canonical_path, enabled, max_depth, created_at) VALUES (?1, ?2, 1, ?3, ?4) ON CONFLICT(canonical_path) DO UPDATE SET enabled = 1, max_depth = excluded.max_depth",
            params![id, path.display().to_string(), max_depth.clamp(1, 8) as i64, created_at.to_rfc3339()],
        )?;
        self.connection.query_row(
            "SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots WHERE canonical_path = ?1",
            params![path.display().to_string()],
            |row| { let created: String = row.get(4)?; Ok(ScanRoot { id: row.get(0)?, path: PathBuf::from(row.get::<_, String>(1)?), enabled: row.get(2)?, max_depth: row.get::<_, i64>(3)? as usize, created_at: parse_time(&created).map_err(sql_error)? }) },
        ).map_err(Into::into)
    }

    pub fn remove_scan_root(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM scan_roots WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_agent_installations(&self) -> Result<Vec<AgentInstallation>> {
        let mut statement = self.connection.prepare("SELECT agent, installed, configured, version, home, warnings FROM agent_installations ORDER BY agent")?;
        let rows = statement.query_map([], |row| {
            let agent: String = row.get(0)?;
            let warnings: String = row.get(5)?;
            Ok(AgentInstallation {
                agent: parse_enum(&agent).map_err(sql_error)?,
                installed: row.get(1)?,
                configured: row.get(2)?,
                version: row.get(3)?,
                home: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                warnings: serde_json::from_str(&warnings)
                    .map_err(|error| sql_error(error.into()))?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn search_catalog_assets(
        &self,
        query: &str,
        agent: Option<AgentKind>,
        workspace_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CatalogAsset>> {
        let pattern = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
        let agent = agent.map(enum_string).transpose()?;
        let mut statement = self.connection.prepare(
            "SELECT id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at FROM catalog_assets WHERE (name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' OR summary LIKE ?1 ESCAPE '\\') AND (?2 IS NULL OR agent = ?2) AND (?3 IS NULL OR workspace_id = ?3) ORDER BY modified_at DESC, name ASC LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![pattern, agent, workspace_id, limit.clamp(1, 500) as i64],
            row_to_catalog_asset,
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_global_memories(&self, status: Option<MemoryStatus>) -> Result<Vec<MemoryRecord>> {
        let mut records = Vec::new();
        let (sql, status_value) = if let Some(status) = status {
            (
                "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE status = ?1 ORDER BY created_at DESC",
                Some(enum_string(status)?),
            )
        } else {
            (
                "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories ORDER BY created_at DESC",
                None,
            )
        };
        let mut statement = self.connection.prepare(sql)?;
        if let Some(status) = status_value {
            let rows = statement.query_map(params![status], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        } else {
            let rows = statement.query_map([], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        }
        Ok(records)
    }

    pub fn list_activity(&self, limit: usize) -> Result<Vec<ActivityRecord>> {
        let mut statement = self.connection.prepare("SELECT id, project_id, action, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?1")?;
        let rows = statement.query_map(params![limit.clamp(1, 500) as i64], |row| {
            let created: String = row.get(4)?;
            Ok(ActivityRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                action: row.get(2)?,
                detail: row.get(3)?,
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn propose_memory(&self, proposal: &MemoryProposal) -> Result<MemoryRecord> {
        if proposal.content.trim().is_empty() {
            bail!("记忆内容不能为空");
        }
        let record = MemoryRecord {
            id: Uuid::new_v4().to_string(),
            project_id: proposal.project_id.clone(),
            memory_type: proposal.memory_type,
            content: proposal.content.trim().to_string(),
            status: MemoryStatus::Pending,
            source_agent: proposal.source_agent.clone(),
            source_thread: proposal.source_thread.clone(),
            source_reference: proposal.source_reference.clone(),
            created_at: Utc::now(),
            approved_at: None,
            invalidated_by: None,
        };
        self.insert_memory(&record)?;
        self.audit(Some(&record.project_id), "memory.propose", &record.id)?;
        Ok(record)
    }

    pub fn propose(&self, proposal: &MemoryProposal) -> Result<MemoryRecord> {
        self.propose_memory(proposal)
    }

    pub fn list_memories(
        &self,
        project_id: &str,
        status: Option<MemoryStatus>,
    ) -> Result<Vec<MemoryRecord>> {
        let mut records = Vec::new();
        if let Some(status) = status {
            let mut statement = self.connection.prepare("SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE project_id = ?1 AND status = ?2 ORDER BY created_at DESC")?;
            let rows =
                statement.query_map(params![project_id, enum_string(status)?], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        } else {
            let mut statement = self.connection.prepare("SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE project_id = ?1 ORDER BY created_at DESC")?;
            let rows = statement.query_map(params![project_id], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        }
        Ok(records)
    }

    pub fn list(
        &self,
        project_id: &str,
        status: Option<MemoryStatus>,
    ) -> Result<Vec<MemoryRecord>> {
        self.list_memories(project_id, status)
    }

    pub fn search_approved(
        &self,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>> {
        if query.trim().is_empty() {
            return Ok(self
                .list_memories(project_id, Some(MemoryStatus::Approved))?
                .into_iter()
                .take(limit)
                .collect());
        }
        let mut statement = self.connection.prepare(
            "SELECT m.id, m.project_id, m.memory_type, m.content, m.status, m.source_agent, m.source_thread, m.source_reference, m.created_at, m.approved_at, m.invalidated_by
             FROM memories_fts f JOIN memories m ON m.id = f.id
             WHERE f.project_id = ?1 AND memories_fts MATCH ?2 AND m.status = 'approved'
             ORDER BY rank LIMIT ?3"
        )?;
        let rows = statement.query_map(
            params![project_id, fts_query(query), limit as i64],
            row_to_memory,
        )?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn search(&self, project_id: &str, query: &str, limit: usize) -> Result<Vec<MemoryRecord>> {
        self.search_approved(project_id, query, limit)
    }

    pub fn review_memory(
        &self,
        id: &str,
        status: MemoryStatus,
        edited_content: Option<&str>,
    ) -> Result<MemoryRecord> {
        if !matches!(
            status,
            MemoryStatus::Approved | MemoryStatus::Rejected | MemoryStatus::Invalidated
        ) {
            bail!("review 只能设置 approved、rejected 或 invalidated");
        }
        let approved_at = matches!(status, MemoryStatus::Approved).then(|| Utc::now().to_rfc3339());
        if let Some(content) = edited_content {
            if content.trim().is_empty() {
                bail!("记忆内容不能为空");
            }
            self.connection.execute(
                "UPDATE memories SET content = ?1, status = ?2, approved_at = ?3 WHERE id = ?4",
                params![content.trim(), enum_string(status)?, approved_at, id],
            )?;
        } else {
            self.connection.execute(
                "UPDATE memories SET status = ?1, approved_at = ?2 WHERE id = ?3",
                params![enum_string(status)?, approved_at, id],
            )?;
        }
        let record = self.get_memory(id)?.context("记忆不存在")?;
        self.audit(
            Some(&record.project_id),
            "memory.review",
            &format!("{}:{}", id, enum_string(status)?),
        )?;
        Ok(record)
    }

    pub fn approve_memory(&self, id: &str, edited_content: Option<&str>) -> Result<MemoryRecord> {
        self.review_memory(id, MemoryStatus::Approved, edited_content)
    }

    pub fn audit(&self, project_id: Option<&str>, action: &str, detail: &str) -> Result<()> {
        self.connection.execute("INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![Uuid::new_v4().to_string(), project_id, action, detail, Utc::now().to_rfc3339()])?;
        Ok(())
    }

    fn get_workspace_by_path(&self, path: &Path) -> Result<Option<WorkspaceSummary>> {
        let id = self
            .connection
            .query_row(
                "SELECT id FROM workspaces WHERE canonical_path = ?1",
                params![path.display().to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        id.map(|id| self.get_workspace(&id))
            .transpose()
            .map(Option::flatten)
    }

    fn workspace_sources(&self, id: &str) -> Result<Vec<WorkspaceSource>> {
        let mut statement = self.connection.prepare(
            "SELECT agent, evidence, session_count, last_active_at FROM workspace_sources WHERE workspace_id = ?1 ORDER BY last_active_at DESC",
        )?;
        let rows = statement.query_map(params![id], |row| {
            let agent: String = row.get(0)?;
            let evidence: String = row.get(1)?;
            let last_active_at: Option<String> = row.get(3)?;
            Ok(WorkspaceSource {
                agent: if agent.is_empty() {
                    None
                } else {
                    Some(parse_enum(&agent).map_err(sql_error)?)
                },
                evidence: parse_enum(&evidence).map_err(sql_error)?,
                session_count: row.get::<_, i64>(2)?.max(0) as u64,
                last_active_at: last_active_at
                    .map(|value| parse_time(&value))
                    .transpose()
                    .map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn insert_memory(&self, record: &MemoryRecord) -> Result<()> {
        self.connection.execute(
            "INSERT INTO memories(id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![record.id, record.project_id, enum_string(record.memory_type)?, record.content, enum_string(record.status)?, record.source_agent, record.source_thread, record.source_reference, record.created_at.to_rfc3339(), record.approved_at.map(|v| v.to_rfc3339()), record.invalidated_by]
        )?;
        Ok(())
    }

    fn get_memory(&self, id: &str) -> Result<Option<MemoryRecord>> {
        self.connection.query_row(
            "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE id = ?1",
            params![id], row_to_memory,
        ).optional().map_err(Into::into)
    }
}

fn excluded_paths(connection: &Connection) -> Result<BTreeSet<PathBuf>> {
    let mut statement = connection.prepare("SELECT canonical_path FROM excluded_workspaces")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut output = BTreeSet::new();
    for row in rows {
        output.insert(PathBuf::from(row?));
    }
    Ok(output)
}

fn upsert_workspace(
    connection: &Connection,
    path: &Path,
    sources: &[&DiscoveryCandidate],
) -> Result<String> {
    let path_text = path.display().to_string();
    let id = connection
        .query_row(
            "SELECT id FROM workspaces WHERE canonical_path = ?1",
            params![path_text],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let last_active_at = sources
        .iter()
        .filter_map(|value| value.last_active_at)
        .max();
    let repository_group_id = sources
        .iter()
        .find_map(|value| value.repository_group_id.clone());
    connection.execute(
        "INSERT INTO workspaces(id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_discovered_at, last_scanned_at) VALUES (?1, ?2, ?3, ?4, NULL, 'needs-import', 0, 0, ?5, ?6, NULL) ON CONFLICT(canonical_path) DO UPDATE SET name = excluded.name, repository_group_id = COALESCE(excluded.repository_group_id, workspaces.repository_group_id), last_active_at = CASE WHEN excluded.last_active_at IS NULL THEN workspaces.last_active_at WHEN workspaces.last_active_at IS NULL OR excluded.last_active_at > workspaces.last_active_at THEN excluded.last_active_at ELSE workspaces.last_active_at END, last_discovered_at = excluded.last_discovered_at",
        params![id, path_text, path.file_name().and_then(|value| value.to_str()).unwrap_or("workspace"), repository_group_id, last_active_at.map(|value| value.to_rfc3339()), Utc::now().to_rfc3339()],
    )?;
    let workspace_id: String = connection.query_row(
        "SELECT id FROM workspaces WHERE canonical_path = ?1",
        params![path.display().to_string()],
        |row| row.get(0),
    )?;
    connection.execute(
        "DELETE FROM workspace_sources WHERE workspace_id = ?1 AND evidence != 'manual'",
        params![workspace_id],
    )?;
    for source in sources {
        let agent = source
            .source_agent
            .map(enum_string)
            .transpose()?
            .unwrap_or_default();
        let evidence = enum_string(source.evidence)?;
        connection.execute(
            "INSERT INTO workspace_sources(workspace_id, agent, evidence, session_count, last_active_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(workspace_id, agent, evidence) DO UPDATE SET session_count = excluded.session_count, last_active_at = excluded.last_active_at",
            params![workspace_id, agent, evidence, source.session_count as i64, source.last_active_at.map(|value| value.to_rfc3339())],
        )?;
    }
    Ok(workspace_id)
}

fn record_scan_failure(connection: &Connection, id: &str) -> Result<()> {
    connection.execute(
        "UPDATE workspaces SET status = 'attention', warning_count = MAX(warning_count, 1), last_scanned_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

fn refresh_workspace_record(connection: &Connection, id: &str, path: &Path) -> Result<()> {
    if !path.is_dir() {
        bail!("工作区不存在：{}", path.display());
    }
    let scan = scan_workspace(path)?;
    let mut warning_count = scan.warnings.len() as u64;
    let manifest = load_manifest(path).ok();
    if let Some(manifest) = manifest.as_ref() {
        for adapter in manifest.adapters.values() {
            for (target, expected) in &adapter.generated_hashes {
                let target = PathBuf::from(target);
                let target = if target.is_absolute() {
                    target
                } else {
                    path.join(target)
                };
                match fs::read(&target) {
                    Ok(content) if hash_content(&content) == *expected => {}
                    _ => warning_count += 1,
                }
            }
        }
    }
    let status = if !scan.manifest_exists {
        WorkspaceStatus::NeedsImport
    } else if warning_count == 0 && manifest.is_some() {
        WorkspaceStatus::Healthy
    } else {
        WorkspaceStatus::Attention
    };
    connection.execute(
        "UPDATE workspaces SET manifest_workspace_id = ?1, status = ?2, asset_count = ?3, warning_count = ?4, last_scanned_at = ?5 WHERE id = ?6",
        params![manifest.as_ref().map(|value| value.workspace.id.clone()), enum_string(status)?, scan.assets.len() as i64, warning_count as i64, Utc::now().to_rfc3339(), id],
    )?;
    connection.execute(
        "DELETE FROM catalog_assets WHERE workspace_id = ?1",
        params![id],
    )?;
    for asset in scan.assets {
        let modified_at = fs::metadata(&asset.path)
            .ok()
            .and_then(|value| value.modified().ok())
            .map(DateTime::<Utc>::from);
        insert_catalog_asset(
            connection,
            &CatalogAsset {
                id: catalog_id(
                    CatalogScope::Workspace,
                    Some(id),
                    Some(asset.agent),
                    asset.kind,
                    &asset.path,
                ),
                scope: CatalogScope::Workspace,
                workspace_id: Some(id.to_string()),
                agent: Some(asset.agent),
                kind: asset.kind,
                name: asset
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("asset")
                    .to_string(),
                path: asset.path,
                summary: asset.summary,
                size: asset.size,
                modified_at,
            },
        )?;
    }
    if let Some(manifest) = manifest {
        let manifest_path = path.join(".agenthub/manifest.yaml");
        insert_catalog_asset(
            connection,
            &CatalogAsset {
                id: catalog_id(
                    CatalogScope::Workspace,
                    Some(id),
                    None,
                    AssetKind::Instruction,
                    &manifest_path,
                ),
                scope: CatalogScope::Workspace,
                workspace_id: Some(id.to_string()),
                agent: None,
                kind: AssetKind::Instruction,
                name: "共享项目指令".into(),
                path: manifest_path,
                summary: "AgentHub 公共指令".into(),
                size: manifest.instructions.shared.len() as u64,
                modified_at: None,
            },
        )?;
        for skill in manifest.skills {
            let asset_path = path.join(&skill.path);
            insert_catalog_asset(
                connection,
                &CatalogAsset {
                    id: catalog_id(
                        CatalogScope::Workspace,
                        Some(id),
                        None,
                        AssetKind::Skill,
                        &asset_path,
                    ),
                    scope: CatalogScope::Workspace,
                    workspace_id: Some(id.to_string()),
                    agent: None,
                    kind: AssetKind::Skill,
                    name: skill.name,
                    path: asset_path,
                    summary: "公共 Skill".into(),
                    size: 0,
                    modified_at: None,
                },
            )?;
        }
        for connection_definition in manifest.connections {
            let asset_path = path.join(".agenthub/manifest.yaml");
            let key_path = asset_path.join(format!("connection-{}", connection_definition.name));
            insert_catalog_asset(
                connection,
                &CatalogAsset {
                    id: catalog_id(
                        CatalogScope::Workspace,
                        Some(id),
                        None,
                        AssetKind::Connection,
                        &key_path,
                    ),
                    scope: CatalogScope::Workspace,
                    workspace_id: Some(id.to_string()),
                    agent: None,
                    kind: AssetKind::Connection,
                    name: connection_definition.name,
                    path: asset_path.clone(),
                    summary: "公共 MCP Connection".into(),
                    size: 0,
                    modified_at: None,
                },
            )?;
        }
    }
    Ok(())
}

fn insert_catalog_asset(connection: &Connection, asset: &CatalogAsset) -> Result<()> {
    let id = if asset.id.is_empty() {
        catalog_id(
            asset.scope,
            asset.workspace_id.as_deref(),
            asset.agent,
            asset.kind,
            &asset.path,
        )
    } else {
        asset.id.clone()
    };
    connection.execute(
        "INSERT OR REPLACE INTO catalog_assets(id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, enum_string(asset.scope)?, asset.workspace_id, asset.agent.map(enum_string).transpose()?, enum_string(asset.kind)?, asset.name, asset.path.display().to_string(), asset.summary, asset.size as i64, asset.modified_at.map(|value| value.to_rfc3339())],
    )?;
    Ok(())
}

fn catalog_id(
    scope: CatalogScope,
    workspace_id: Option<&str>,
    agent: Option<AgentKind>,
    kind: AssetKind,
    path: &Path,
) -> String {
    hash_content(
        format!(
            "{:?}|{}|{:?}|{:?}|{}",
            scope,
            workspace_id.unwrap_or_default(),
            agent,
            kind,
            path.display()
        )
        .as_bytes(),
    )
}

fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<WorkspaceSummary> {
    let status: String = row.get(5)?;
    let last_active: Option<String> = row.get(8)?;
    let last_scanned: Option<String> = row.get(9)?;
    Ok(WorkspaceSummary {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        name: row.get(2)?,
        repository_group_id: row.get(3)?,
        manifest_workspace_id: row.get(4)?,
        status: parse_enum(&status).map_err(sql_error)?,
        asset_count: row.get::<_, i64>(6)?.max(0) as u64,
        warning_count: row.get::<_, i64>(7)?.max(0) as u64,
        last_active_at: last_active
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        last_scanned_at: last_scanned
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        sources: Vec::new(),
    })
}

fn row_to_catalog_asset(row: &Row<'_>) -> rusqlite::Result<CatalogAsset> {
    let scope: String = row.get(1)?;
    let agent: Option<String> = row.get(3)?;
    let kind: String = row.get(4)?;
    let modified_at: Option<String> = row.get(9)?;
    Ok(CatalogAsset {
        id: row.get(0)?,
        scope: parse_enum(&scope).map_err(sql_error)?,
        workspace_id: row.get(2)?,
        agent: agent
            .map(|value| parse_enum(&value))
            .transpose()
            .map_err(sql_error)?,
        kind: parse_enum(&kind).map_err(sql_error)?,
        name: row.get(5)?,
        path: PathBuf::from(row.get::<_, String>(6)?),
        summary: row.get(7)?,
        size: row.get::<_, i64>(8)?.max(0) as u64,
        modified_at: modified_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
    })
}

pub fn default_data_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir().context("无法确定本地应用数据目录")?;
    Ok(base.join("com.agenthub.desktop"))
}

pub fn default_database_path() -> Result<PathBuf> {
    Ok(default_data_dir()?.join("agenthub.db"))
}
pub fn default_backup_dir() -> Result<PathBuf> {
    Ok(default_data_dir()?.join("backups"))
}

fn row_to_memory(row: &Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let memory_type: String = row.get(2)?;
    let status: String = row.get(4)?;
    let created_at: String = row.get(8)?;
    let approved_at: Option<String> = row.get(9)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        memory_type: parse_enum(&memory_type).map_err(sql_error)?,
        content: row.get(3)?,
        status: parse_enum(&status).map_err(sql_error)?,
        source_agent: row.get(5)?,
        source_thread: row.get(6)?,
        source_reference: row.get(7)?,
        created_at: parse_time(&created_at).map_err(sql_error)?,
        approved_at: approved_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        invalidated_by: row.get(10)?,
    })
}

fn parse_time(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}
fn enum_string<T: serde::Serialize>(value: T) -> Result<String> {
    Ok(serde_json::to_value(value)?
        .as_str()
        .context("枚举序列化失败")?
        .to_string())
}
fn parse_enum<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(
        value.into(),
    ))?)
}
fn sql_error(error: anyhow::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
}
fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use agenthub_core::MemoryType;
    use tempfile::tempdir;

    fn candidate(path: &Path) -> DiscoveryCandidate {
        DiscoveryCandidate {
            path: path.canonicalize().unwrap(),
            source_agent: Some(AgentKind::Codex),
            evidence: DiscoveryEvidence::SessionCwd,
            last_active_at: Some(Utc::now()),
            session_count: 2,
            explicit_workspace: false,
            repository_group_id: Some("repository".into()),
        }
    }

    #[test]
    fn only_approved_memories_are_searchable() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let record = store
            .propose_memory(&MemoryProposal {
                project_id: "p1".into(),
                memory_type: MemoryType::Decision,
                content: "统一使用 SQLite FTS5".into(),
                source_agent: None,
                source_thread: None,
                source_reference: None,
            })
            .unwrap();
        assert!(
            store
                .search_approved("p1", "SQLite", 10)
                .unwrap()
                .is_empty()
        );
        store
            .review_memory(&record.id, MemoryStatus::Approved, None)
            .unwrap();
        assert_eq!(store.search_approved("p1", "SQLite", 10).unwrap().len(), 1);
    }

    #[test]
    fn discovery_is_idempotent_and_preserves_existing_workspace_on_provider_error() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let candidate = candidate(&workspace);
        for _ in 0..2 {
            store
                .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
                .unwrap();
        }
        let workspaces = store.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].sources.len(), 1);
        assert_eq!(workspaces[0].sources[0].session_count, 2);

        store
            .sync_discovery(&[], &[], &[], Utc::now(), &["codex provider failed".into()])
            .unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn excluded_workspace_stays_hidden_until_restored() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let candidate = candidate(&workspace);
        store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        let id = store.list_workspaces().unwrap()[0].id.clone();
        store.exclude_workspace(&id).unwrap();
        store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        assert!(store.list_workspaces().unwrap().is_empty());

        store
            .restore_excluded_workspace(&workspace.canonicalize().unwrap())
            .unwrap();
        store
            .sync_discovery(&[candidate], &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn nonexistent_history_paths_are_removed() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store
            .sync_discovery(&[candidate(&workspace)], &[], &[], Utc::now(), &[])
            .unwrap();
        fs::remove_dir_all(&workspace).unwrap();
        let report = store
            .sync_discovery(&[], &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(report.removed_count, 1);
        assert!(store.list_workspaces().unwrap().is_empty());
    }

    #[test]
    fn schema_upgrade_keeps_existing_memories() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        {
            let store = Store::open(&database).unwrap();
            store
                .propose_memory(&MemoryProposal {
                    project_id: "p1".into(),
                    memory_type: MemoryType::ProjectFact,
                    content: "保留的记忆".into(),
                    source_agent: None,
                    source_thread: None,
                    source_reference: None,
                })
                .unwrap();
        }
        let reopened = Store::open(&database).unwrap();
        assert_eq!(reopened.list_global_memories(None).unwrap().len(), 1);
    }

    #[test]
    fn current_schema_allows_concurrent_read_connections() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        Store::open(&database).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let database = database.clone();
                std::thread::spawn(move || {
                    Store::open(&database).unwrap().list_workspaces().unwrap()
                })
            })
            .collect();
        for handle in handles {
            assert!(handle.join().unwrap().is_empty());
        }
    }
}
