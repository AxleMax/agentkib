use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use agentkib_adapters::{HomeTargets, default_manifest, plan_workspace_changes};
use agentkib_core::{
    ActivityRecord, AgentInstallation, AgentKind, ApplyOptions, CatalogAsset, ChangeSet,
    ContextPreview, DiscoveryReport, ExcludedWorkspace, Manifest, McpHubStatus, McpInstallation,
    McpMigrationCandidate, McpNetworkSettings, McpOAuthStart, McpRegistryEntry, McpRuntimeStatus,
    McpServerConfig, McpToolDescriptor, MemoryProposal, MemoryRecord, MemoryStatus, ScanRoot,
    WorkspaceScan, WorkspaceSummary, apply_changeset as apply_core_changeset, load_manifest,
    resolve_context as resolve_core_context, scan_workspace as scan_core_workspace,
    validate_workspace as validate_core_workspace,
};
use agentkib_discovery::discover as discover_local_workspaces;
use agentkib_insights::{
    Achievement, AgentUsageBreakdown, GitIdentitySummary, HeatmapPoint, InsightsQuery,
    InsightsStatus, InsightsSummary, ModelUsageBreakdown, RepositoryCommitBreakdown,
    WorkspaceUsageBreakdown, collect_git, collect_usage,
};
use agentkib_mcp::{HubController, config as mcp_config, installation_root};
use agentkib_store::{Store, default_backup_dir, default_data_dir};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Theme, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

mod i18n;
mod obsidian;
use i18n::{LocalePreference, SupportedLocale, translate};
use obsidian::{ObsidianIntegration, ObsidianWorkspaceLink};

type CommandResult<T> = Result<T, LocalizedMessage>;

#[derive(Debug, Clone, Serialize)]
struct LocalizedMessage {
    key: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    params: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl LocalizedMessage {
    fn new(key: &str) -> Self {
        Self {
            key: key.into(),
            params: BTreeMap::new(),
            detail: None,
        }
    }

    fn with_detail(key: &str, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(key)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CloseBehavior {
    MinimizeToTray,
    Quit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    fn native(self) -> Option<Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EffectiveTheme {
    Light,
    Dark,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DesktopPreferences {
    #[serde(default)]
    close_behavior: Option<CloseBehavior>,
    #[serde(default)]
    locale_preference: LocalePreference,
    #[serde(default)]
    theme_preference: ThemePreference,
    #[serde(default)]
    mcp_network: McpNetworkSettings,
}

#[derive(Debug)]
struct LifecycleState {
    close_behavior: Mutex<Option<CloseBehavior>>,
    locale_preference: Mutex<LocalePreference>,
    effective_locale: Mutex<SupportedLocale>,
    theme_preference: Mutex<ThemePreference>,
    close_prompt_open: AtomicBool,
    quitting: AtomicBool,
}

#[derive(Debug, Default)]
struct DiscoveryRuntime {
    running: AtomicBool,
    last_report: Mutex<Option<DiscoveryReport>>,
}

#[derive(Debug, Default)]
struct InsightsRuntime {
    running: AtomicBool,
}

impl LifecycleState {
    fn new(preferences: &DesktopPreferences) -> Self {
        let effective_locale = preferences.locale_preference.effective();
        Self {
            close_behavior: Mutex::new(preferences.close_behavior),
            locale_preference: Mutex::new(preferences.locale_preference),
            effective_locale: Mutex::new(effective_locale),
            theme_preference: Mutex::new(preferences.theme_preference),
            close_prompt_open: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }

    fn close_behavior(&self) -> Option<CloseBehavior> {
        *self
            .close_behavior
            .lock()
            .expect("Close behavior state lock is poisoned")
    }

    fn set_close_behavior(&self, value: Option<CloseBehavior>) {
        *self
            .close_behavior
            .lock()
            .expect("Close behavior state lock is poisoned") = value;
    }

    fn locale_preference(&self) -> LocalePreference {
        *self.locale_preference.lock().expect("locale state lock")
    }

    fn effective_locale(&self) -> SupportedLocale {
        *self.effective_locale.lock().expect("locale state lock")
    }

    fn set_locale(&self, preference: LocalePreference, effective: SupportedLocale) {
        *self.locale_preference.lock().expect("locale state lock") = preference;
        *self.effective_locale.lock().expect("locale state lock") = effective;
    }

    fn theme_preference(&self) -> ThemePreference {
        *self.theme_preference.lock().expect("theme state lock")
    }

    fn set_theme_preference(&self, preference: ThemePreference) {
        *self.theme_preference.lock().expect("theme state lock") = preference;
    }
}

#[derive(Serialize)]
struct RuntimeInfo {
    data_dir: PathBuf,
    database_path: PathBuf,
    mcp_package_root: PathBuf,
    mcp_hub: McpHubStatus,
    mcp_network: McpNetworkSettings,
    openclaw_config: Option<PathBuf>,
    hermes_config: Option<PathBuf>,
    close_behavior: Option<CloseBehavior>,
    locale_preference: LocalePreference,
    effective_locale: SupportedLocale,
    theme_preference: ThemePreference,
    effective_theme: EffectiveTheme,
}

#[derive(Serialize)]
struct McpInstallResult {
    installation: McpInstallation,
    server: McpServerConfig,
    tools: Vec<McpToolDescriptor>,
}

#[tauri::command]
fn scan_workspace(project: String) -> CommandResult<WorkspaceScan> {
    scan_core_workspace(Path::new(&project)).map_err(format_error)
}

#[tauri::command]
fn prepare_manifest(project: String) -> CommandResult<Manifest> {
    let path = Path::new(&project);
    if agentkib_core::manifest_path(path).is_file() {
        load_manifest(path).map_err(format_error)
    } else {
        default_manifest(path).map_err(format_error)
    }
}

#[tauri::command]
fn validate_workspace(project: String) -> CommandResult<agentkib_core::WorkspaceValidation> {
    validate_core_workspace(Path::new(&project)).map_err(format_error)
}

#[tauri::command]
fn discover_workspaces(
    app: AppHandle,
    state: tauri::State<'_, Arc<DiscoveryRuntime>>,
) -> CommandResult<DiscoveryReport> {
    perform_discovery(&app, state.inner())
}

#[tauri::command]
fn list_workspaces() -> CommandResult<Vec<WorkspaceSummary>> {
    Store::open_default()
        .and_then(|store| store.list_workspaces())
        .map_err(format_error)
}

#[tauri::command]
fn get_workspace(id: String) -> CommandResult<Option<WorkspaceSummary>> {
    Store::open_default()
        .and_then(|store| store.get_workspace(&id))
        .map_err(format_error)
}

#[tauri::command]
fn add_workspace(path: String) -> CommandResult<WorkspaceSummary> {
    Store::open_default()
        .and_then(|store| store.add_workspace(Path::new(&path)))
        .map_err(format_error)
}

#[tauri::command]
fn refresh_workspace(id: String) -> CommandResult<WorkspaceSummary> {
    Store::open_default()
        .and_then(|store| store.refresh_workspace(&id))
        .map_err(format_error)
}

#[tauri::command]
fn exclude_workspace(id: String) -> CommandResult<()> {
    Store::open_default()
        .and_then(|store| store.exclude_workspace(&id))
        .map_err(format_error)
}

#[tauri::command]
fn list_excluded_workspaces() -> CommandResult<Vec<ExcludedWorkspace>> {
    Store::open_default()
        .and_then(|store| store.list_excluded_workspaces())
        .map_err(format_error)
}

#[tauri::command]
fn restore_excluded_workspace(path: String) -> CommandResult<()> {
    Store::open_default()
        .and_then(|store| store.restore_excluded_workspace(Path::new(&path)))
        .map_err(format_error)
}

#[tauri::command]
fn get_obsidian_integration() -> CommandResult<ObsidianIntegration> {
    default_data_dir()
        .and_then(|data_dir| obsidian::integration(&data_dir))
        .map_err(format_error)
}

#[tauri::command]
fn add_obsidian_vault(path: String) -> CommandResult<ObsidianIntegration> {
    default_data_dir()
        .and_then(|data_dir| obsidian::add_vault(&data_dir, Path::new(&path)))
        .map_err(format_error)
}

#[tauri::command]
fn link_workspace_to_obsidian(
    workspace_id: String,
    vault_path: String,
    relative_target: Option<String>,
) -> CommandResult<ObsidianWorkspaceLink> {
    let store = Store::open_default().map_err(format_error)?;
    if store
        .get_workspace(&workspace_id)
        .map_err(format_error)?
        .is_none()
    {
        return Err(LocalizedMessage::new("errors.workspaceNotFound"));
    }
    default_data_dir()
        .and_then(|data_dir| {
            obsidian::link_workspace(
                &data_dir,
                &workspace_id,
                Path::new(&vault_path),
                relative_target.as_deref(),
            )
        })
        .map_err(format_error)
}

#[tauri::command]
fn unlink_workspace_from_obsidian(workspace_id: String) -> CommandResult<()> {
    default_data_dir()
        .and_then(|data_dir| obsidian::unlink_workspace(&data_dir, &workspace_id))
        .map_err(format_error)
}

#[tauri::command]
fn open_obsidian() -> CommandResult<()> {
    obsidian::open_app().map_err(format_error)
}

#[tauri::command]
fn open_workspace_in_obsidian(workspace_id: String) -> CommandResult<()> {
    default_data_dir()
        .and_then(|data_dir| obsidian::open_workspace(&data_dir, &workspace_id))
        .map_err(format_error)
}

#[tauri::command]
fn list_scan_roots() -> CommandResult<Vec<ScanRoot>> {
    Store::open_default()
        .and_then(|store| store.list_scan_roots())
        .map_err(format_error)
}

#[tauri::command]
fn add_scan_root(path: String, max_depth: usize) -> CommandResult<ScanRoot> {
    Store::open_default()
        .and_then(|store| store.add_scan_root(Path::new(&path), max_depth))
        .map_err(format_error)
}

#[tauri::command]
fn remove_scan_root(id: String) -> CommandResult<()> {
    Store::open_default()
        .and_then(|store| store.remove_scan_root(&id))
        .map_err(format_error)
}

#[tauri::command]
fn list_agent_installations() -> CommandResult<Vec<AgentInstallation>> {
    Store::open_default()
        .and_then(|store| store.list_agent_installations())
        .map_err(format_error)
}

#[tauri::command]
fn search_catalog_assets(
    query: String,
    agent: Option<AgentKind>,
    workspace_id: Option<String>,
    limit: usize,
) -> CommandResult<Vec<CatalogAsset>> {
    Store::open_default()
        .and_then(|store| {
            store.search_catalog_assets(&query, agent, workspace_id.as_deref(), limit)
        })
        .map_err(format_error)
}

#[tauri::command]
fn list_global_memories(status: Option<MemoryStatus>) -> CommandResult<Vec<MemoryRecord>> {
    Store::open_default()
        .and_then(|store| store.list_global_memories(status))
        .map_err(format_error)
}

#[tauri::command]
fn list_activity(limit: usize) -> CommandResult<Vec<ActivityRecord>> {
    Store::open_default()
        .and_then(|store| store.list_activity(limit))
        .map_err(format_error)
}

#[tauri::command]
fn refresh_insights(
    app: AppHandle,
    state: tauri::State<'_, Arc<InsightsRuntime>>,
) -> CommandResult<InsightsSummary> {
    perform_insights(&app, state.inner())
}

#[tauri::command]
fn get_insights_summary(query: InsightsQuery) -> CommandResult<InsightsSummary> {
    Store::open_default()
        .and_then(|store| store.insights_summary(&query))
        .map_err(format_error)
}

#[tauri::command]
fn get_insights_heatmap(query: InsightsQuery) -> CommandResult<Vec<HeatmapPoint>> {
    Store::open_default()
        .and_then(|store| store.insights_heatmap(&query))
        .map_err(format_error)
}

#[tauri::command]
fn get_agent_usage_breakdown(query: InsightsQuery) -> CommandResult<Vec<AgentUsageBreakdown>> {
    Store::open_default()
        .and_then(|store| store.agent_usage_breakdown(&query))
        .map_err(format_error)
}

#[tauri::command]
fn get_model_usage_breakdown(query: InsightsQuery) -> CommandResult<Vec<ModelUsageBreakdown>> {
    Store::open_default()
        .and_then(|store| store.model_usage_breakdown(&query))
        .map_err(format_error)
}

#[tauri::command]
fn get_workspace_usage_breakdown(
    query: InsightsQuery,
) -> CommandResult<Vec<WorkspaceUsageBreakdown>> {
    Store::open_default()
        .and_then(|store| store.workspace_usage_breakdown(&query))
        .map_err(format_error)
}

#[tauri::command]
fn get_repository_commit_breakdown(
    query: InsightsQuery,
) -> CommandResult<Vec<RepositoryCommitBreakdown>> {
    Store::open_default()
        .and_then(|store| store.repository_commit_breakdown(&query))
        .map_err(format_error)
}

#[tauri::command]
fn list_achievements() -> CommandResult<Vec<Achievement>> {
    Store::open_default()
        .and_then(|store| store.list_achievements())
        .map_err(format_error)
}

#[tauri::command]
fn get_insights_status(
    state: tauri::State<'_, Arc<InsightsRuntime>>,
) -> CommandResult<InsightsStatus> {
    Store::open_default()
        .and_then(|store| store.insights_status(state.running.load(Ordering::SeqCst)))
        .map_err(format_error)
}

#[tauri::command]
fn list_git_identities() -> CommandResult<Vec<GitIdentitySummary>> {
    Store::open_default()
        .and_then(|store| store.list_git_identities())
        .map_err(format_error)
}

#[tauri::command]
fn add_git_identity_alias(email: String) -> CommandResult<GitIdentitySummary> {
    Store::open_default()
        .and_then(|store| store.add_git_identity_alias(&email))
        .map_err(format_error)
}

#[tauri::command]
fn set_git_identity_enabled(id: String, enabled: bool) -> CommandResult<()> {
    Store::open_default()
        .and_then(|store| store.set_git_identity_enabled(&id, enabled))
        .map_err(format_error)
}

#[tauri::command]
fn plan_changes(
    project: String,
    mut manifest: Manifest,
    include_home: bool,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<ChangeSet> {
    ensure_agentkib_connection(&mut manifest, hub.settings().port);
    let home = if include_home {
        default_home_targets()
    } else {
        HomeTargets::default()
    };
    plan_workspace_changes(Path::new(&project), &manifest, &home).map_err(format_error)
}

#[tauri::command]
fn apply_changes(
    change_set: ChangeSet,
    approve_home: bool,
) -> CommandResult<agentkib_core::ApplyReport> {
    let project_id = load_manifest(&change_set.project_root)
        .ok()
        .map(|manifest| manifest.workspace.id);
    let known_home = default_home_targets();
    let mut approved_home_files: Vec<_> = [known_home.openclaw_config, known_home.hermes_config]
        .into_iter()
        .flatten()
        .collect();
    approved_home_files.extend(native_mcp_home_files());
    let options = ApplyOptions {
        approved_home_files,
        home_approval: approve_home,
    };
    let result = apply_core_changeset(
        &change_set,
        &default_backup_dir().map_err(format_error)?,
        &options,
    );
    if let Ok(store) = Store::open_default() {
        let (action, detail) = match &result {
            Ok(_) => ("changeset.apply", change_set.id.clone()),
            Err(error) => (
                "changeset.apply_failed",
                format!("{}: {}", change_set.id, error),
            ),
        };
        let _ = store.audit(project_id.as_deref(), action, &detail);
    }
    result.map_err(format_error)
}

#[tauri::command]
fn resolve_context(
    project: String,
    cwd: String,
    agent: AgentKind,
) -> CommandResult<ContextPreview> {
    let manifest = load_manifest(Path::new(&project)).ok();
    let memories = if let (Some(manifest), Ok(store)) = (manifest.as_ref(), Store::open_default()) {
        store
            .list_memories(&manifest.workspace.id, Some(MemoryStatus::Approved))
            .unwrap_or_default()
            .into_iter()
            .map(|value| value.content)
            .collect()
    } else {
        Vec::new()
    };
    let mut preview = resolve_core_context(
        Path::new(&project),
        Path::new(&cwd),
        agent,
        manifest.as_ref(),
        memories,
    )
    .map_err(format_error)?;
    preview.visible_connections =
        mcp_config::load_visible_servers(Some(Path::new(&project)), agent)
            .map_err(format_error)?
            .into_iter()
            .map(|server| server.name)
            .collect();
    Ok(preview)
}

#[tauri::command]
fn list_memories(
    project: String,
    status: Option<MemoryStatus>,
) -> CommandResult<Vec<MemoryRecord>> {
    let manifest = load_manifest(Path::new(&project)).map_err(format_error)?;
    Store::open_default()
        .and_then(|store| store.list_memories(&manifest.workspace.id, status))
        .map_err(format_error)
}

#[tauri::command]
fn search_memories(
    project: String,
    query: String,
    limit: usize,
) -> CommandResult<Vec<MemoryRecord>> {
    let manifest = load_manifest(Path::new(&project)).map_err(format_error)?;
    Store::open_default()
        .and_then(|store| store.search_approved(&manifest.workspace.id, &query, limit.clamp(1, 50)))
        .map_err(format_error)
}

#[tauri::command]
fn propose_memory(mut proposal: MemoryProposal, project: String) -> CommandResult<MemoryRecord> {
    let manifest = load_manifest(Path::new(&project)).map_err(format_error)?;
    proposal.project_id = manifest.workspace.id;
    Store::open_default()
        .and_then(|store| store.propose_memory(&proposal))
        .map_err(format_error)
}

#[tauri::command]
fn review_memory(
    id: String,
    status: MemoryStatus,
    edited_content: Option<String>,
) -> CommandResult<MemoryRecord> {
    Store::open_default()
        .and_then(|store| store.review_memory(&id, status, edited_content.as_deref()))
        .map_err(format_error)
}

#[tauri::command]
fn runtime_info(
    app: AppHandle,
    state: tauri::State<'_, Arc<LifecycleState>>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<RuntimeInfo> {
    refresh_system_locale(&app, state.inner());
    let theme_preference = state.theme_preference();
    let data_dir = default_data_dir().map_err(format_error)?;
    Ok(RuntimeInfo {
        database_path: data_dir.join("agentkib.db"),
        data_dir,
        mcp_package_root: installation_root().map_err(format_error)?,
        mcp_hub: hub.status(),
        mcp_network: hub.settings(),
        openclaw_config: default_home_targets().openclaw_config,
        hermes_config: default_home_targets().hermes_config,
        close_behavior: state.close_behavior(),
        locale_preference: state.locale_preference(),
        effective_locale: state.effective_locale(),
        theme_preference,
        effective_theme: effective_theme(&app, theme_preference),
    })
}

#[tauri::command]
fn set_close_behavior(
    behavior: Option<CloseBehavior>,
    state: tauri::State<'_, Arc<LifecycleState>>,
) -> CommandResult<()> {
    update_preferences(|preferences| preferences.close_behavior = behavior)
        .map_err(format_error)?;
    state.set_close_behavior(behavior);
    Ok(())
}

#[tauri::command]
fn set_locale(
    preference: LocalePreference,
    app: AppHandle,
    state: tauri::State<'_, Arc<LifecycleState>>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<RuntimeInfo> {
    update_preferences(|preferences| preferences.locale_preference = preference)
        .map_err(format_error)?;
    state.set_locale(preference, preference.effective());
    refresh_tray_status(&app).map_err(format_error)?;
    runtime_info(app, state, hub)
}

#[tauri::command]
fn set_theme_preference(
    preference: ThemePreference,
    app: AppHandle,
    state: tauri::State<'_, Arc<LifecycleState>>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<RuntimeInfo> {
    update_preferences(|preferences| preferences.theme_preference = preference)
        .map_err(format_error)?;
    apply_native_theme(&app, preference).map_err(format_error)?;
    state.set_theme_preference(preference);
    runtime_info(app, state, hub)
}

#[tauri::command]
fn get_mcp_network_settings(hub: tauri::State<'_, Arc<HubController>>) -> McpNetworkSettings {
    hub.settings()
}

#[tauri::command]
fn update_mcp_network_settings(
    settings: McpNetworkSettings,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<McpHubStatus> {
    if settings.port == 0 {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "MCP Hub port must be between 1 and 65535",
        ));
    }
    let previous = hub.settings();
    hub.restart(settings.clone()).map_err(format_error)?;
    if let Err(error) = update_preferences(|preferences| preferences.mcp_network = settings) {
        let _ = hub.restart(previous);
        return Err(format_error(error));
    }
    Ok(hub.status())
}

#[tauri::command]
fn get_mcp_hub_status(hub: tauri::State<'_, Arc<HubController>>) -> McpHubStatus {
    let status = hub.status();
    persist_mcp_runtime_snapshots(hub.inner());
    status
}

#[tauri::command]
fn list_mcp_servers(project: Option<String>) -> CommandResult<Vec<McpServerConfig>> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    mcp_config::load_effective_config(project.as_deref())
        .map(|document| {
            document
                .servers
                .into_iter()
                .map(mcp_config::masked_server)
                .collect()
        })
        .map_err(format_error)
}

#[tauri::command]
fn get_mcp_server(
    project: Option<String>,
    server_id: String,
) -> CommandResult<Option<McpServerConfig>> {
    Ok(list_mcp_servers(project)?
        .into_iter()
        .find(|server| server.id == server_id))
}

#[tauri::command]
fn save_mcp_server(
    project: Option<String>,
    mut server: McpServerConfig,
) -> CommandResult<McpServerConfig> {
    if matches!(
        server.transport,
        agentkib_core::McpServerTransport::Sse { .. }
    ) {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "Legacy SSE is import-only; new MCP servers must use Streamable HTTP",
        ));
    }
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    server.env.clear();
    server.headers.clear();
    let path = mcp_config_target(project.as_deref(), false).map_err(format_error)?;
    mcp_config::save_server(&path, server.clone(), false).map_err(format_error)?;
    Ok(mcp_config::masked_server(server))
}

#[tauri::command]
fn save_mcp_local_values(
    project: Option<String>,
    server_id: String,
    env: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
) -> CommandResult<()> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    let mut server = mcp_config::load_effective_config(project.as_deref())
        .map_err(format_error)?
        .servers
        .into_iter()
        .find(|server| server.id == server_id)
        .ok_or_else(|| LocalizedMessage::with_detail("errors.generic", "Unknown MCP server"))?;
    server.env = env;
    server.headers = headers;
    let path = mcp_config_target(project.as_deref(), true).map_err(format_error)?;
    mcp_config::save_server(&path, server, true).map_err(format_error)
}

#[tauri::command]
fn remove_mcp_server(project: Option<String>, server_id: String) -> CommandResult<()> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    for private in [false, true] {
        let path = mcp_config_target(project.as_deref(), private).map_err(format_error)?;
        mcp_config::remove_server(&path, &server_id, private).map_err(format_error)?;
    }
    Ok(())
}

#[tauri::command]
fn probe_mcp_runtime(
    project: Option<String>,
    server_id: String,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<Vec<McpToolDescriptor>> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    let server = mcp_config::load_effective_config(project.as_deref())
        .map_err(format_error)?
        .servers
        .into_iter()
        .find(|server| server.id == server_id)
        .ok_or_else(|| LocalizedMessage::with_detail("errors.generic", "Unknown MCP server"))?;
    hub.probe(&server).map_err(format_error)
}

#[tauri::command]
fn start_mcp_oauth(
    project: Option<String>,
    server_id: String,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<McpOAuthStart> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    let server = mcp_config::load_effective_config(project.as_deref())
        .map_err(format_error)?
        .servers
        .into_iter()
        .find(|server| server.id == server_id)
        .ok_or_else(|| LocalizedMessage::with_detail("errors.generic", "Unknown MCP server"))?;
    hub.start_oauth(&server)
        .map(|authorization_url| McpOAuthStart { authorization_url })
        .map_err(format_error)
}

#[tauri::command]
fn list_mcp_runtimes(hub: tauri::State<'_, Arc<HubController>>) -> Vec<McpRuntimeStatus> {
    let statuses = hub.runtime_statuses();
    if let Ok(store) = Store::open_default() {
        let _ = store.save_mcp_runtime_snapshots(&statuses);
    }
    statuses
}

fn persist_mcp_runtime_snapshots(hub: &HubController) {
    if let Ok(store) = Store::open_default() {
        let _ = store.save_mcp_runtime_snapshots(&hub.runtime_statuses());
    }
}

#[tauri::command]
fn restart_mcp_runtime(
    project: Option<String>,
    server_id: String,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<Vec<McpToolDescriptor>> {
    hub.stop_runtime(Some(&server_id));
    probe_mcp_runtime(project, server_id, hub)
}

#[tauri::command]
fn stop_mcp_runtime(server_id: Option<String>, hub: tauri::State<'_, Arc<HubController>>) {
    hub.stop_runtime(server_id.as_deref());
}

#[tauri::command]
fn scan_native_mcp_candidates(
    project: Option<String>,
) -> CommandResult<Vec<McpMigrationCandidate>> {
    let project = registered_project_path(project.as_deref()).map_err(format_error)?;
    agentkib_mcp::native::scan_native_candidates(project.as_deref()).map_err(format_error)
}

#[tauri::command]
fn plan_mcp_migration(
    project: String,
    candidate_ids: Vec<String>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<ChangeSet> {
    let project = registered_project_path(Some(&project))
        .map_err(format_error)?
        .ok_or_else(|| LocalizedMessage::with_detail("errors.generic", "Project is required"))?;
    if candidate_ids.is_empty() {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "Select at least one native MCP candidate",
        ));
    }
    let candidates =
        agentkib_mcp::native::scan_native_candidates(Some(&project)).map_err(format_error)?;
    let manifest = load_manifest(&project).map_err(format_error)?;
    let gateway_url = format!(
        "http://127.0.0.1:{}/mcp/v1/workspaces/{}/agents/{{agent}}",
        hub.settings().port,
        manifest.workspace.id
    );
    let effective = mcp_config::load_effective_config(Some(&project)).map_err(format_error)?;
    let mut servers = Vec::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate_ids.contains(&candidate.id))
    {
        let imported = agentkib_mcp::native::migration_server(candidate).map_err(format_error)?;
        let server = if candidate.has_secret_values {
            effective
                .servers
                .iter()
                .find(|server| {
                    server.name == candidate.name
                        && (!server.env.is_empty()
                            || !server.headers.is_empty()
                            || server.oauth_credentials.is_some())
                })
                .cloned()
                .ok_or_else(|| {
                    LocalizedMessage::with_detail(
                        "errors.generic",
                        format!(
                            "Re-enter local secret values and probe `{}` before removing its native configuration",
                            candidate.name
                        ),
                    )
                })?
        } else {
            imported
        };
        if matches!(
            &server.transport,
            agentkib_core::McpServerTransport::Sse { .. }
        ) {
            return Err(LocalizedMessage::with_detail(
                "errors.generic",
                format!(
                    "Legacy SSE server `{}` must be converted to Streamable HTTP before migration",
                    candidate.name
                ),
            ));
        }
        hub.probe(&server).map_err(format_error)?;
        servers.push(server);
    }
    if servers.len() != candidate_ids.len() {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "Native MCP candidates changed; scan again",
        ));
    }
    agentkib_mcp::native::plan_migration(&project, &candidate_ids, &servers, &gateway_url)
        .map_err(format_error)
}

#[tauri::command]
async fn search_mcp_registry(query: String) -> CommandResult<Vec<McpRegistryEntry>> {
    match agentkib_mcp::registry::search_registry(&query).await {
        Ok(entries) => {
            Store::open_default()
                .and_then(|store| store.replace_mcp_registry_cache(&entries))
                .map_err(format_error)?;
            Ok(entries)
        }
        Err(error) => Store::open_default()
            .and_then(|store| store.search_mcp_registry_cache(&query))
            .map_err(|cache_error| {
                format_error(format!(
                    "Registry request failed: {error}; cached lookup failed: {cache_error}"
                ))
            }),
    }
}

#[tauri::command]
async fn refresh_mcp_registry(query: String) -> CommandResult<Vec<McpRegistryEntry>> {
    let entries = agentkib_mcp::registry::search_registry(&query)
        .await
        .map_err(format_error)?;
    Store::open_default()
        .and_then(|store| store.replace_mcp_registry_cache(&entries))
        .map_err(format_error)?;
    Ok(entries)
}

#[tauri::command]
async fn install_mcp(
    entry: McpRegistryEntry,
    project: Option<String>,
    confirmed: bool,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<McpInstallResult> {
    if !confirmed {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "MCP installation requires explicit confirmation",
        ));
    }
    let project_path = registered_project_path(project.as_deref()).map_err(format_error)?;
    let (installation, server) =
        tokio::task::spawn_blocking(move || agentkib_mcp::registry::install_registry_entry(&entry))
            .await
            .map_err(format_error)?
            .map_err(format_error)?;
    Store::open_default()
        .and_then(|store| store.save_mcp_installation(&installation))
        .map_err(format_error)?;
    let path = mcp_config_target(project_path.as_deref(), false).map_err(format_error)?;
    mcp_config::save_server(&path, server.clone(), false).map_err(format_error)?;
    let tools = if server.env.is_empty() && server.headers.is_empty() {
        hub.probe(&server).unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(McpInstallResult {
        installation,
        server: mcp_config::masked_server(server),
        tools,
    })
}

#[tauri::command]
async fn update_mcp(
    installation_id: String,
    entry: McpRegistryEntry,
    project: Option<String>,
    confirmed: bool,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<McpInstallResult> {
    if !confirmed {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "MCP update requires explicit confirmation",
        ));
    }
    let store = Store::open_default().map_err(format_error)?;
    let previous = store
        .list_mcp_installations()
        .map_err(format_error)?
        .into_iter()
        .find(|value| value.id == installation_id)
        .ok_or_else(|| {
            LocalizedMessage::with_detail("errors.generic", "Unknown MCP installation")
        })?;
    let result = install_mcp(entry, project.clone(), true, hub.clone()).await?;
    if result.installation.id != previous.id {
        hub.stop_runtime(Some(&previous.id));
        remove_mcp_server(project, previous.id.clone())?;
        agentkib_mcp::registry::uninstall_package(&previous).map_err(format_error)?;
        store
            .remove_mcp_installation(&previous.id)
            .map_err(format_error)?;
    }
    Ok(result)
}

#[tauri::command]
fn list_mcp_installations() -> CommandResult<Vec<McpInstallation>> {
    Store::open_default()
        .and_then(|store| store.list_mcp_installations())
        .map_err(format_error)
}

#[tauri::command]
fn uninstall_mcp(
    installation_id: String,
    confirmed: bool,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<()> {
    if !confirmed {
        return Err(LocalizedMessage::with_detail(
            "errors.generic",
            "MCP uninstall requires explicit confirmation",
        ));
    }
    let store = Store::open_default().map_err(format_error)?;
    let installation = store
        .list_mcp_installations()
        .map_err(format_error)?
        .into_iter()
        .find(|value| value.id == installation_id)
        .ok_or_else(|| {
            LocalizedMessage::with_detail("errors.generic", "Unknown MCP installation")
        })?;
    hub.stop_runtime(Some(&installation.id));
    agentkib_mcp::registry::uninstall_package(&installation).map_err(format_error)?;
    let mut config_paths = mcp_config::config_paths(None).map_err(format_error)?;
    for workspace in store.list_workspaces().map_err(format_error)? {
        config_paths.extend(mcp_config::config_paths(Some(&workspace.path)).map_err(format_error)?);
    }
    for path in config_paths.into_iter().filter(|path| path.is_file()) {
        let private = path.file_name().and_then(|value| value.to_str())
            == Some(mcp_config::LOCAL_CONFIG_NAME);
        mcp_config::remove_server(&path, &installation.id, private).map_err(format_error)?;
    }
    store
        .remove_mcp_installation(&installation.id)
        .map_err(format_error)
}

fn registered_project_path(project: Option<&str>) -> anyhow::Result<Option<PathBuf>> {
    let Some(project) = project else {
        return Ok(None);
    };
    let canonical = Path::new(project).canonicalize()?;
    let registered = Store::open_default()?
        .list_workspaces()?
        .into_iter()
        .any(|workspace| workspace.path == canonical);
    if !registered {
        anyhow::bail!("MCP project scope must be a registered AgentKib workspace");
    }
    Ok(Some(canonical))
}

fn mcp_config_target(project: Option<&Path>, private: bool) -> anyhow::Result<PathBuf> {
    let paths = mcp_config::config_paths(project)?;
    Ok(match (project.is_some(), private) {
        (false, false) => paths[0].clone(),
        (false, true) => paths[1].clone(),
        (true, false) => paths[2].clone(),
        (true, true) => paths[3].clone(),
    })
}

fn ensure_agentkib_connection(manifest: &mut Manifest, port: u16) {
    let definition = agentkib_core::ConnectionDefinition {
        name: "agentkib".into(),
        transport: agentkib_core::ConnectionTransport::Http {
            url: format!(
                "http://127.0.0.1:{port}/mcp/v1/workspaces/{}/agents/{{agent}}",
                manifest.workspace.id
            ),
        },
        env: Default::default(),
        allow_tools: vec![],
        targets: AgentKind::ALL.into_iter().collect(),
    };
    if let Some(existing) = manifest
        .connections
        .iter_mut()
        .find(|value| value.name == "agentkib")
    {
        *existing = definition;
    } else {
        manifest.connections.push(definition);
    }
}

fn default_home_targets() -> HomeTargets {
    let home = dirs::home_dir();
    HomeTargets {
        openclaw_config: home
            .as_ref()
            .map(|path| path.join(".openclaw/openclaw.json")),
        hermes_config: home.map(|path| path.join(".hermes/config.yaml")),
    }
}

fn native_mcp_home_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![
        home.join(".codex/config.toml"),
        home.join(".claude.json"),
        home.join(".openclaw/openclaw.json"),
        home.join(".hermes/config.yaml"),
    ]
}

fn preferences_path() -> anyhow::Result<PathBuf> {
    Ok(default_data_dir()?.join("preferences.json"))
}

fn load_desktop_preferences() -> DesktopPreferences {
    let Ok(path) = preferences_path() else {
        return DesktopPreferences::default();
    };
    load_preferences(&path).unwrap_or_default()
}

fn load_preferences(path: &Path) -> anyhow::Result<DesktopPreferences> {
    if !path.is_file() {
        return Ok(DesktopPreferences::default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn update_preferences(update: impl FnOnce(&mut DesktopPreferences)) -> anyhow::Result<()> {
    let path = preferences_path()?;
    let mut preferences = load_preferences(&path)?;
    update(&mut preferences);
    save_preferences(&path, &preferences)
}

fn refresh_system_locale(app: &AppHandle, lifecycle: &LifecycleState) {
    if lifecycle.locale_preference() != LocalePreference::System {
        return;
    }
    let effective = LocalePreference::System.effective();
    if lifecycle.effective_locale() != effective {
        lifecycle.set_locale(LocalePreference::System, effective);
        let _ = refresh_tray_status(app);
    }
}

fn apply_native_theme(app: &AppHandle, preference: ThemePreference) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_theme(preference.native())?;
    }
    Ok(())
}

fn effective_theme(app: &AppHandle, preference: ThemePreference) -> EffectiveTheme {
    match preference {
        ThemePreference::Light => EffectiveTheme::Light,
        ThemePreference::Dark => EffectiveTheme::Dark,
        ThemePreference::System => match app
            .get_webview_window("main")
            .and_then(|window| window.theme().ok())
        {
            Some(Theme::Light) => EffectiveTheme::Light,
            Some(Theme::Dark) => EffectiveTheme::Dark,
            _ => EffectiveTheme::Dark,
        },
    }
}

fn save_preferences(path: &Path, preferences: &DesktopPreferences) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Preferences path has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension("tmp");
    fs::write(
        &temp,
        format!("{}\n", serde_json::to_string_pretty(preferences)?),
    )?;
    fs::rename(temp, path)?;
    Ok(())
}

fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_real_exit(app: &AppHandle, lifecycle: &LifecycleState) {
    lifecycle.quitting.store(true, Ordering::SeqCst);
    app.state::<Arc<HubController>>().shutdown();
    app.exit(0);
}

fn handle_close_request(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle().clone();
    let lifecycle = app.state::<Arc<LifecycleState>>().inner().clone();
    if lifecycle.quitting.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_close();
    match lifecycle.close_behavior() {
        Some(CloseBehavior::MinimizeToTray) => hide_to_tray(&app),
        Some(CloseBehavior::Quit) => request_real_exit(&app, &lifecycle),
        None => show_first_close_prompt(window, app, lifecycle),
    }
}

fn show_first_close_prompt(window: &tauri::Window, app: AppHandle, lifecycle: Arc<LifecycleState>) {
    if lifecycle.close_prompt_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let locale = lifecycle.effective_locale();
    let hide_label = translate(locale, "dialog.close.hide", &[]);
    let quit_label = translate(locale, "dialog.close.quit", &[]);
    app.dialog()
        .message(translate(locale, "dialog.close.message", &[]))
        .title(translate(locale, "dialog.close.title", &[]))
        .parent(window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            hide_label.clone(),
            quit_label.clone(),
            translate(locale, "dialog.close.cancel", &[]),
        ))
        .show_with_result(move |result| {
            lifecycle.close_prompt_open.store(false, Ordering::SeqCst);
            match result {
                MessageDialogResult::Custom(label) if label == hide_label => {
                    lifecycle.set_close_behavior(Some(CloseBehavior::MinimizeToTray));
                    let _ = update_preferences(|preferences| {
                        preferences.close_behavior = Some(CloseBehavior::MinimizeToTray);
                    });
                    hide_to_tray(&app);
                }
                MessageDialogResult::Custom(label) if label == quit_label => {
                    lifecycle.set_close_behavior(Some(CloseBehavior::Quit));
                    let _ = update_preferences(|preferences| {
                        preferences.close_behavior = Some(CloseBehavior::Quit);
                    });
                    request_real_exit(&app, &lifecycle);
                }
                _ => {}
            }
        });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;

    let locale = app.state::<Arc<LifecycleState>>().effective_locale();
    let menu = MenuBuilder::new(app)
        .text("show", translate(locale, "tray.open", &[]))
        .text("status", translate(locale, "tray.refreshing", &[]))
        .text("mcp_status", "MCP Hub · starting")
        .text("refresh", translate(locale, "tray.refresh", &[]))
        .separator()
        .text("quit", translate(locale, "tray.quit", &[]))
        .build()?;
    let tray = TrayIconBuilder::with_id("agentkib-status")
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .icon_as_template(true)
        .menu(&menu)
        .tooltip(translate(locale, "tray.tooltip", &[]))
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "refresh" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let state = app.state::<Arc<DiscoveryRuntime>>();
                    let _ = perform_discovery(&app, state.inner());
                    let insights = app.state::<Arc<InsightsRuntime>>();
                    let _ = perform_insights(&app, insights.inner());
                });
            }
            "quit" => {
                let lifecycle = app.state::<Arc<LifecycleState>>();
                request_real_exit(app, lifecycle.inner());
            }
            _ => {}
        });
    tray.build(app)?;
    Ok(())
}

fn perform_discovery(app: &AppHandle, state: &DiscoveryRuntime) -> CommandResult<DiscoveryReport> {
    if state.running.swap(true, Ordering::SeqCst) {
        return state
            .last_report
            .lock()
            .expect("Discovery state lock is poisoned")
            .clone()
            .ok_or_else(|| LocalizedMessage::new("errors.discoveryRunning"));
    }
    let result = (|| -> anyhow::Result<DiscoveryReport> {
        let store = Store::open_default()?;
        let roots: Vec<_> = store
            .list_scan_roots()?
            .into_iter()
            .filter(|root| root.enabled)
            .map(|root| (root.path, root.max_depth))
            .collect();
        let started_at = chrono::Utc::now();
        let snapshot = discover_local_workspaces(&roots);
        store.sync_discovery(
            &snapshot.candidates,
            &snapshot.installations,
            &snapshot.home_assets,
            started_at,
            &snapshot.errors,
        )
    })();
    state.running.store(false, Ordering::SeqCst);
    match result {
        Ok(report) => {
            *state
                .last_report
                .lock()
                .expect("Discovery state lock is poisoned") = Some(report.clone());
            let _ = app.emit("agentkib:discovery-updated", &report);
            let _ = refresh_tray_status(app);
            Ok(report)
        }
        Err(error) => Err(format_error(error)),
    }
}

fn refresh_tray_status(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    let workspaces = Store::open_default()
        .and_then(|store| store.list_workspaces())
        .unwrap_or_default();
    let attention = workspaces
        .iter()
        .filter(|workspace| !matches!(workspace.status, agentkib_core::WorkspaceStatus::Healthy))
        .count();
    let locale = app.state::<Arc<LifecycleState>>().effective_locale();
    let hub_status = app.state::<Arc<HubController>>().status();
    let menu = MenuBuilder::new(app)
        .text("show", translate(locale, "tray.open", &[]))
        .text(
            "status",
            translate(
                locale,
                "tray.status",
                &[
                    ("workspaces", workspaces.len().to_string()),
                    ("attention", attention.to_string()),
                ],
            ),
        )
        .text(
            "mcp_status",
            format!(
                "MCP Hub · {} · {}",
                translate(
                    locale,
                    if hub_status.running {
                        "mcp.running"
                    } else {
                        "mcp.stopped"
                    },
                    &[]
                ),
                hub_status.runtime_count
            ),
        )
        .text("refresh", translate(locale, "tray.refresh", &[]))
        .separator()
        .text("quit", translate(locale, "tray.quit", &[]))
        .build()?;
    if let Some(tray) = app.tray_by_id("agentkib-status") {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(translate(locale, "tray.tooltip", &[])))?;
    }
    Ok(())
}

fn perform_insights(app: &AppHandle, state: &InsightsRuntime) -> CommandResult<InsightsSummary> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.insightsRunning"));
    }
    let result = (|| -> anyhow::Result<InsightsSummary> {
        let store = Store::open_default()?;
        let workspaces = store.list_workspaces()?;
        let fingerprints = store.insight_git_fingerprints()?;
        let usage_cursors = store.insight_usage_cursors()?;
        // 文件、Agent CLI 和 Git 读取均发生在数据库事务之外，避免后台刷新长期占锁。
        let usage = collect_usage(&usage_cursors);
        let repositories = collect_git(&workspaces, &fingerprints);
        store.sync_insights(&usage, &repositories)?;
        store.insights_summary(&InsightsQuery::default())
    })();
    state.running.store(false, Ordering::SeqCst);
    match result {
        Ok(summary) => {
            let _ = app.emit("agentkib:insights-updated", &summary);
            Ok(summary)
        }
        Err(error) => Err(format_error(error)),
    }
}

fn start_discovery_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let state = app.state::<Arc<DiscoveryRuntime>>();
            let _ = perform_discovery(&app, state.inner());
            let insights = app.state::<Arc<InsightsRuntime>>();
            let _ = perform_insights(&app, insights.inner());
            std::thread::sleep(std::time::Duration::from_secs(15 * 60));
        }
    });
}

fn format_error(error: impl std::fmt::Display) -> LocalizedMessage {
    LocalizedMessage::with_detail("errors.generic", error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let preferences = load_desktop_preferences();
    let lifecycle = Arc::new(LifecycleState::new(&preferences));
    let hub = Arc::new(
        HubController::new(preferences.mcp_network.clone())
            .expect("Failed to initialize AgentKib MCP Hub runtime"),
    );
    let discovery = Arc::new(DiscoveryRuntime::default());
    let insights = Arc::new(InsightsRuntime::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(lifecycle)
        .manage(hub)
        .manage(discovery)
        .manage(insights)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let theme = app.state::<Arc<LifecycleState>>().theme_preference();
            apply_native_theme(app.handle(), theme)?;
            setup_tray(app)?;
            app.state::<Arc<HubController>>().start()?;
            start_discovery_scheduler(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                handle_close_request(window, api);
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_workspace,
            prepare_manifest,
            validate_workspace,
            discover_workspaces,
            list_workspaces,
            get_workspace,
            add_workspace,
            refresh_workspace,
            exclude_workspace,
            list_excluded_workspaces,
            restore_excluded_workspace,
            get_obsidian_integration,
            add_obsidian_vault,
            link_workspace_to_obsidian,
            unlink_workspace_from_obsidian,
            open_obsidian,
            open_workspace_in_obsidian,
            list_scan_roots,
            add_scan_root,
            remove_scan_root,
            list_agent_installations,
            search_catalog_assets,
            list_global_memories,
            list_activity,
            refresh_insights,
            get_insights_summary,
            get_insights_heatmap,
            get_agent_usage_breakdown,
            get_model_usage_breakdown,
            get_workspace_usage_breakdown,
            get_repository_commit_breakdown,
            list_achievements,
            get_insights_status,
            list_git_identities,
            add_git_identity_alias,
            set_git_identity_enabled,
            plan_changes,
            apply_changes,
            resolve_context,
            list_memories,
            search_memories,
            propose_memory,
            review_memory,
            runtime_info,
            set_close_behavior,
            set_locale,
            set_theme_preference,
            get_mcp_network_settings,
            update_mcp_network_settings,
            get_mcp_hub_status,
            list_mcp_servers,
            get_mcp_server,
            save_mcp_server,
            save_mcp_local_values,
            remove_mcp_server,
            probe_mcp_runtime,
            start_mcp_oauth,
            list_mcp_runtimes,
            restart_mcp_runtime,
            stop_mcp_runtime,
            scan_native_mcp_candidates,
            plan_mcp_migration,
            search_mcp_registry,
            refresh_mcp_registry,
            install_mcp,
            update_mcp,
            list_mcp_installations,
            uninstall_mcp
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build AgentKib");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let lifecycle = app.state::<Arc<LifecycleState>>();
            if code.is_none() && !lifecycle.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                hide_to_tray(app);
            }
        }
        tauri::RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn close_behavior_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        save_preferences(
            &path,
            &DesktopPreferences {
                close_behavior: Some(CloseBehavior::MinimizeToTray),
                locale_preference: LocalePreference::JaJp,
                theme_preference: ThemePreference::Light,
                mcp_network: McpNetworkSettings::default(),
            },
        )
        .unwrap();
        assert_eq!(
            load_preferences(&path).unwrap().close_behavior,
            Some(CloseBehavior::MinimizeToTray)
        );
        assert_eq!(
            load_preferences(&path).unwrap().locale_preference,
            LocalePreference::JaJp
        );
        assert_eq!(
            load_preferences(&path).unwrap().theme_preference,
            ThemePreference::Light
        );
    }

    #[test]
    fn missing_preferences_asks_on_first_close() {
        let dir = tempdir().unwrap();
        assert_eq!(
            load_preferences(&dir.path().join("missing.json"))
                .unwrap()
                .close_behavior,
            None
        );
    }

    #[test]
    fn old_preferences_default_to_system_locale_and_theme() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        fs::write(&path, r#"{"close_behavior":"quit"}"#).unwrap();
        let preferences = load_preferences(&path).unwrap();
        assert_eq!(preferences.close_behavior, Some(CloseBehavior::Quit));
        assert_eq!(preferences.locale_preference, LocalePreference::System);
        assert_eq!(preferences.theme_preference, ThemePreference::System);
    }

    #[test]
    fn theme_preferences_map_to_native_themes() {
        assert_eq!(ThemePreference::System.native(), None);
        assert_eq!(ThemePreference::Light.native(), Some(Theme::Light));
        assert_eq!(ThemePreference::Dark.native(), Some(Theme::Dark));
    }
}
