use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use agentkib_adapters::{HomeTargets, default_manifest, plan_workspace_changes};
use agentkib_conversations::{
    ConversationEventPage, ConversationIndexStatus, ConversationSessionSummary, provider, providers,
};
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
use agentkib_gateways::{RemoteGatewayInput, RemoteGatewaySummary};
use agentkib_git::{
    GitCommitPage, GitDiff, GitDiffRequest, GitFileChange, GitHistoryQuery, GitWorkspaceSummary,
};
use agentkib_insights::{
    Achievement, AgentUsageBreakdown, GitIdentitySummary, HeatmapPoint, InsightsCollectionPolicy,
    InsightsQuery, InsightsStatus, InsightsSummary, ModelUsageBreakdown, RepositoryCommitBreakdown,
    WorkspaceUsageBreakdown, collect_git, collect_usage, shutdown_external_commands,
};
use agentkib_mcp::{HubController, config as mcp_config, installation_root};
use agentkib_platform::applications::{
    WorkspaceApplication, WorkspaceApplicationCategory, detect_workspace_applications,
    open_workspace as open_workspace_application,
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use agentkib_platform::process::ProcessTree;
#[cfg(target_os = "linux")]
use agentkib_platform::process::configure_process_group;
use agentkib_platform::{fs::atomic_write, path as platform_path};
#[cfg(target_os = "windows")]
use agentkib_quota::resolve_win_codexbar_config;
use agentkib_quota::{
    CollectorCapabilities, DashboardCliCollector, QuotaBackend, QuotaCollector,
    QuotaCollectorStatus, QuotaCommandOutput, QuotaCommandRunner, QuotaSnapshot,
    sanitize_diagnostic,
};
#[cfg(not(target_os = "windows"))]
use agentkib_quota::{resolve_codexbar_config, write_managed_config};
use agentkib_storage::{
    HardLinkSet, StorageOverview, StorageWorkspace, scan_workspace as scan_workspace_storage,
};
use agentkib_store::{Store, default_backup_dir, default_data_dir};
use anyhow::Context;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Theme, WindowEvent};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;
#[cfg(target_os = "macos")]
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

mod i18n;
mod obsidian;
mod refresh;
use i18n::{LocalePreference, SupportedLocale, translate};
use obsidian::{ObsidianIntegration, ObsidianWorkspaceLink};
use refresh::{RefreshCoordinator, RefreshJobStatus, RefreshKind, RefreshReceipt};

type CommandResult<T> = Result<T, LocalizedMessage>;

#[derive(Debug, Serialize)]
struct InsightsView {
    summary: InsightsSummary,
    heatmap: Vec<HeatmapPoint>,
    agents: Vec<AgentUsageBreakdown>,
    models: Vec<ModelUsageBreakdown>,
    workspaces: Vec<WorkspaceUsageBreakdown>,
    repositories: Vec<RepositoryCommitBreakdown>,
    achievements: Vec<Achievement>,
    status: InsightsStatus,
}

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AppIconPreference {
    #[default]
    White,
    Black,
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct QuotaWindowSelector {
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    kind: String,
    label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct QuotaPopoverPreferences {
    #[serde(default)]
    hidden_providers: Vec<String>,
    #[serde(default)]
    hidden_windows: Vec<QuotaWindowSelector>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct WorkspaceOpenerPreferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    global_recent: Option<String>,
    #[serde(default)]
    by_workspace: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WorkspaceOpener {
    id: String,
    name: String,
    category: WorkspaceApplicationCategory,
    preferred: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct DesktopPreferences {
    #[serde(default)]
    close_behavior: Option<CloseBehavior>,
    #[serde(default)]
    locale_preference: LocalePreference,
    #[serde(default)]
    theme_preference: ThemePreference,
    #[serde(default)]
    app_icon_preference: AppIconPreference,
    #[serde(default)]
    mcp_network: McpNetworkSettings,
    #[serde(default)]
    quota_popover: QuotaPopoverPreferences,
    #[serde(default)]
    workspace_openers: WorkspaceOpenerPreferences,
    #[serde(default = "default_true")]
    session_index_enabled: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            close_behavior: None,
            locale_preference: LocalePreference::default(),
            theme_preference: ThemePreference::default(),
            app_icon_preference: AppIconPreference::default(),
            mcp_network: McpNetworkSettings::default(),
            quota_popover: QuotaPopoverPreferences::default(),
            workspace_openers: WorkspaceOpenerPreferences::default(),
            session_index_enabled: true,
        }
    }
}

const fn default_true() -> bool {
    true
}

#[derive(Debug)]
struct LifecycleState {
    close_behavior: Mutex<Option<CloseBehavior>>,
    locale_preference: Mutex<LocalePreference>,
    effective_locale: Mutex<SupportedLocale>,
    theme_preference: Mutex<ThemePreference>,
    app_icon_preference: Mutex<AppIconPreference>,
    session_index_enabled: AtomicBool,
    close_prompt_open: AtomicBool,
    quitting: AtomicBool,
    tray_available: AtomicBool,
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

#[derive(Debug, Default)]
struct QuotaRuntime {
    running: AtomicBool,
}

#[derive(Debug, Default)]
struct StorageRuntime {
    running: AtomicBool,
    cancel_requested: AtomicBool,
}

#[derive(Debug, Default)]
struct ConversationRuntime {
    running_workspaces: Mutex<BTreeSet<String>>,
}

impl LifecycleState {
    fn new(preferences: &DesktopPreferences) -> Self {
        let effective_locale = preferences.locale_preference.effective();
        Self {
            close_behavior: Mutex::new(preferences.close_behavior),
            locale_preference: Mutex::new(preferences.locale_preference),
            effective_locale: Mutex::new(effective_locale),
            theme_preference: Mutex::new(preferences.theme_preference),
            app_icon_preference: Mutex::new(preferences.app_icon_preference),
            session_index_enabled: AtomicBool::new(preferences.session_index_enabled),
            close_prompt_open: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            tray_available: AtomicBool::new(false),
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

    fn app_icon_preference(&self) -> AppIconPreference {
        *self
            .app_icon_preference
            .lock()
            .expect("app icon state lock")
    }

    fn set_app_icon_preference(&self, preference: AppIconPreference) {
        *self
            .app_icon_preference
            .lock()
            .expect("app icon state lock") = preference;
    }

    fn session_index_enabled(&self) -> bool {
        self.session_index_enabled.load(Ordering::SeqCst)
    }

    fn set_session_index_enabled(&self, enabled: bool) {
        self.session_index_enabled.store(enabled, Ordering::SeqCst);
    }

    fn tray_available(&self) -> bool {
        self.tray_available.load(Ordering::SeqCst)
    }

    fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::SeqCst);
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
    app_icon_preference: AppIconPreference,
    tray_available: bool,
    session_index_enabled: bool,
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
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
) -> RefreshReceipt {
    coordinator.request(app, RefreshKind::Discovery, true)
}

#[tauri::command]
fn request_refresh(
    app: AppHandle,
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
    storage: tauri::State<'_, Arc<StorageRuntime>>,
    kind: RefreshKind,
    force: Option<bool>,
) -> RefreshReceipt {
    if kind == RefreshKind::Storage && !coordinator.is_active(kind) {
        storage.cancel_requested.store(false, Ordering::SeqCst);
    }
    coordinator.request(app, kind, force.unwrap_or(false))
}

#[tauri::command]
fn get_refresh_status(
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
) -> Vec<RefreshJobStatus> {
    coordinator.statuses()
}

#[tauri::command]
fn get_storage_overview() -> CommandResult<StorageOverview> {
    Store::open_default()
        .and_then(|store| store.storage_overview())
        .map_err(format_error)
}

#[tauri::command]
fn cancel_storage_scan(
    app: AppHandle,
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
    storage: tauri::State<'_, Arc<StorageRuntime>>,
) -> bool {
    let active = coordinator.is_active(RefreshKind::Storage);
    if active {
        storage.cancel_requested.store(true, Ordering::SeqCst);
        coordinator.cancel_queued(&app, RefreshKind::Storage);
    }
    active
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

fn workspace_path(workspace_id: &str) -> CommandResult<PathBuf> {
    Store::open_default()
        .and_then(|store| store.workspace_path(workspace_id))
        .map_err(format_error)
}

#[tauri::command]
async fn get_workspace_git_summary(
    workspace_id: String,
) -> CommandResult<Option<GitWorkspaceSummary>> {
    let path = workspace_path(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || agentkib_git::workspace_summary(&path))
        .await
        .map_err(|_| LocalizedMessage::new("errors.git.queryFailed"))?
        .map_err(format_error)
}

#[tauri::command]
async fn list_workspace_git_history(
    workspace_id: String,
    query: GitHistoryQuery,
) -> CommandResult<Option<GitCommitPage>> {
    let path = workspace_path(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || agentkib_git::history(&path, &query))
        .await
        .map_err(|_| LocalizedMessage::new("errors.git.queryFailed"))?
        .map_err(format_error)
}

#[tauri::command]
async fn list_git_commit_files(
    workspace_id: String,
    oid: String,
) -> CommandResult<Option<Vec<GitFileChange>>> {
    let path = workspace_path(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || agentkib_git::commit_files(&path, &oid))
        .await
        .map_err(|_| LocalizedMessage::new("errors.git.queryFailed"))?
        .map_err(format_error)
}

#[tauri::command]
async fn get_git_diff(
    workspace_id: String,
    request: GitDiffRequest,
) -> CommandResult<Option<GitDiff>> {
    let path = workspace_path(&workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || agentkib_git::diff(&path, &request))
        .await
        .map_err(|_| LocalizedMessage::new("errors.git.queryFailed"))?
        .map_err(format_error)
}

#[tauri::command]
async fn list_workspace_openers(workspace_id: String) -> CommandResult<Vec<WorkspaceOpener>> {
    let _ = workspace_path(&workspace_id)?;
    let preferences = load_desktop_preferences();
    let applications = tauri::async_runtime::spawn_blocking(detect_workspace_applications)
        .await
        .map_err(|_| LocalizedMessage::new("errors.workspaceOpener.unavailable"))?;
    let preferred = preferred_opener(&applications, &preferences.workspace_openers, &workspace_id);
    Ok(applications
        .into_iter()
        .map(|application| WorkspaceOpener {
            preferred: preferred.as_deref() == Some(application.id.as_str()),
            id: application.id,
            name: application.name,
            category: application.category,
        })
        .collect())
}

#[tauri::command]
async fn open_workspace_with_app(
    workspace_id: String,
    opener_id: Option<String>,
) -> CommandResult<()> {
    let path = workspace_path(&workspace_id)?;
    let preferences = load_desktop_preferences();
    let selected = tauri::async_runtime::spawn_blocking({
        let workspace_id = workspace_id.clone();
        let requested = opener_id.clone();
        move || -> CommandResult<String> {
            let applications = detect_workspace_applications();
            let selected = requested
                .or_else(|| {
                    preferred_opener(&applications, &preferences.workspace_openers, &workspace_id)
                })
                .ok_or_else(|| LocalizedMessage::new("errors.workspaceOpener.unavailable"))?;
            if !applications
                .iter()
                .any(|application| application.id == selected)
            {
                return Err(LocalizedMessage::new("errors.workspaceOpener.unavailable"));
            }
            open_workspace_application(&selected, &path).map_err(|error| {
                LocalizedMessage::with_detail(
                    "errors.workspaceOpener.openFailed",
                    error.to_string(),
                )
            })?;
            Ok(selected)
        }
    })
    .await
    .map_err(|_| LocalizedMessage::new("errors.workspaceOpener.openFailed"))??;
    if opener_id.is_some() {
        update_preferences(|preferences| {
            preferences.workspace_openers.global_recent = Some(selected.clone());
            preferences
                .workspace_openers
                .by_workspace
                .insert(workspace_id, selected);
        })
        .map_err(format_error)?;
    }
    Ok(())
}

fn preferred_opener(
    applications: &[WorkspaceApplication],
    preferences: &WorkspaceOpenerPreferences,
    workspace_id: &str,
) -> Option<String> {
    let installed = |id: &str| applications.iter().any(|application| application.id == id);
    preferences
        .by_workspace
        .get(workspace_id)
        .filter(|id| installed(id))
        .cloned()
        .or_else(|| {
            preferences
                .global_recent
                .as_ref()
                .filter(|id| installed(id))
                .cloned()
        })
        .or_else(|| {
            applications
                .iter()
                .find(|application| {
                    application.category == WorkspaceApplicationCategory::FileManager
                })
                .map(|application| application.id.clone())
        })
}

#[tauri::command]
fn list_workspace_sessions(
    workspace_id: String,
    lifecycle: tauri::State<'_, Arc<LifecycleState>>,
) -> CommandResult<Vec<ConversationSessionSummary>> {
    if !lifecycle.session_index_enabled() {
        return Ok(Vec::new());
    }
    Store::open_default()
        .and_then(|store| store.list_conversation_sessions(&workspace_id))
        .map_err(format_error)
}

#[tauri::command]
fn get_workspace_session_status(
    workspace_id: String,
) -> CommandResult<Vec<ConversationIndexStatus>> {
    Store::open_default()
        .and_then(|store| store.conversation_index_status(&workspace_id))
        .map_err(format_error)
}

#[tauri::command]
async fn refresh_workspace_sessions(
    app: AppHandle,
    workspace_id: String,
    force: Option<bool>,
    lifecycle: tauri::State<'_, Arc<LifecycleState>>,
    runtime: tauri::State<'_, Arc<ConversationRuntime>>,
) -> CommandResult<Vec<ConversationSessionSummary>> {
    if !lifecycle.session_index_enabled() {
        return Err(LocalizedMessage::new("errors.conversations.indexDisabled"));
    }
    if !force.unwrap_or(false) {
        let store = Store::open_default().map_err(format_error)?;
        let statuses = store
            .conversation_index_status(&workspace_id)
            .map_err(format_error)?;
        if statuses.len() == 2
            && statuses.iter().all(|status| {
                status.freshness == agentkib_conversations::SessionIndexFreshness::Fresh
            })
        {
            return store
                .list_conversation_sessions(&workspace_id)
                .map_err(format_error);
        }
    }
    {
        let mut running = runtime
            .running_workspaces
            .lock()
            .expect("conversation runtime lock");
        if !running.insert(workspace_id.clone()) {
            return Store::open_default()
                .and_then(|store| store.list_conversation_sessions(&workspace_id))
                .map_err(format_error);
        }
    }

    let refresh_workspace_id = workspace_id.clone();
    let lifecycle_state = Arc::clone(lifecycle.inner());
    let joined = tauri::async_runtime::spawn_blocking(
        move || -> anyhow::Result<Vec<ConversationSessionSummary>> {
            let store = Store::open_default()?;
            let workspace = store.workspace_path(&refresh_workspace_id)?;
            for source in providers() {
                if !lifecycle_state.session_index_enabled() {
                    store.clear_conversation_index(Some(&refresh_workspace_id))?;
                    return Ok(Vec::new());
                }
                let agent = source.agent();
                match source.list_sessions(&workspace) {
                    Ok(sessions) => {
                        store.sync_conversation_sessions(
                            &refresh_workspace_id,
                            agent,
                            &sessions,
                        )?;
                    }
                    Err(_) => {
                        // Paths and parser diagnostics can identify private transcript locations,
                        // so only a stable, non-sensitive failure is persisted.
                        store.record_conversation_index_failure(
                            &refresh_workspace_id,
                            agent,
                            "errors.conversations.sourceUnavailable",
                            "Conversation source could not be read",
                        )?;
                    }
                }
            }
            if !lifecycle_state.session_index_enabled() {
                store.clear_conversation_index(Some(&refresh_workspace_id))?;
                return Ok(Vec::new());
            }
            store.list_conversation_sessions(&refresh_workspace_id)
        },
    )
    .await;

    runtime
        .running_workspaces
        .lock()
        .expect("conversation runtime lock")
        .remove(&workspace_id);
    let _ = app.emit("agentkib:conversations-updated", &workspace_id);
    match joined {
        Ok(result) => result.map_err(format_error),
        Err(_) => Err(LocalizedMessage::new("errors.conversations.refreshFailed")),
    }
}

#[tauri::command]
async fn read_session_events(
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
    lifecycle: tauri::State<'_, Arc<LifecycleState>>,
) -> CommandResult<ConversationEventPage> {
    if !lifecycle.session_index_enabled() {
        return Err(LocalizedMessage::new("errors.conversations.indexDisabled"));
    }
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<ConversationEventPage> {
        let store = Store::open_default()?;
        let session = store
            .get_conversation_session(&session_id)?
            .context("Conversation metadata is no longer available")?;
        let workspace = store.workspace_path(&session.workspace_id)?;
        let source = provider(session.agent).context("Conversation Provider is unavailable")?;
        let native = source
            .list_sessions(&workspace)?
            .into_iter()
            .find(|candidate| {
                store
                    .conversation_id(session.agent, &candidate.native_ref)
                    .is_ok_and(|id| id == session_id)
            })
            .context("Conversation transcript is no longer available")?;
        source.read_events(&native.native_ref, cursor.as_deref(), limit.unwrap_or(100))
    })
    .await
    .map_err(|_| LocalizedMessage::new("errors.conversations.readFailed"))?
    .map_err(|_| LocalizedMessage::new("errors.conversations.readFailed"))
}

#[tauri::command]
fn clear_session_index(workspace_id: Option<String>) -> CommandResult<()> {
    Store::open_default()
        .and_then(|store| store.clear_conversation_index(workspace_id.as_deref()))
        .map_err(format_error)
}

#[tauri::command]
fn set_session_index_enabled(
    enabled: bool,
    app: AppHandle,
    lifecycle: tauri::State<'_, Arc<LifecycleState>>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<RuntimeInfo> {
    update_preferences(|preferences| preferences.session_index_enabled = enabled)
        .map_err(format_error)?;
    lifecycle.set_session_index_enabled(enabled);
    if !enabled {
        Store::open_default()
            .and_then(|store| store.clear_conversation_index(None))
            .map_err(format_error)?;
    }
    runtime_info(app, lifecycle, hub)
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
    obsidian::open_app().map_err(format_obsidian_error)
}

#[tauri::command]
fn open_workspace_in_obsidian(workspace_id: String) -> CommandResult<()> {
    default_data_dir()
        .and_then(|data_dir| obsidian::open_workspace(&data_dir, &workspace_id))
        .map_err(format_obsidian_error)
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

fn remote_gateway_registry_path() -> anyhow::Result<PathBuf> {
    Ok(agentkib_gateways::default_registry_path(
        &default_data_dir()?
    ))
}

fn record_remote_gateway_achievements(gateways: &[RemoteGatewaySummary]) {
    let Some(connected_at) = gateways
        .iter()
        .filter_map(|gateway| gateway.last_connected_at)
        .min()
    else {
        return;
    };
    let Ok(store) = Store::open_default() else {
        return;
    };
    let _ = store.unlock_special_achievement("special-remote-handshake", connected_at);
}

#[tauri::command]
fn list_remote_gateways() -> CommandResult<Vec<RemoteGatewaySummary>> {
    let gateways = remote_gateway_registry_path()
        .and_then(|path| agentkib_gateways::list(&path))
        .map_err(format_error)?;
    record_remote_gateway_achievements(&gateways);
    Ok(gateways)
}

#[tauri::command]
async fn save_remote_gateway(input: RemoteGatewayInput) -> CommandResult<RemoteGatewaySummary> {
    let path = remote_gateway_registry_path().map_err(format_error)?;
    agentkib_gateways::save(&path, input)
        .await
        .map_err(format_error)
}

#[tauri::command]
async fn refresh_remote_gateway(id: String) -> CommandResult<RemoteGatewaySummary> {
    let path = remote_gateway_registry_path().map_err(format_error)?;
    let gateway = agentkib_gateways::refresh(&path, &id)
        .await
        .map_err(format_error)?;
    record_remote_gateway_achievements(std::slice::from_ref(&gateway));
    Ok(gateway)
}

#[tauri::command]
async fn remove_remote_gateway(id: String) -> CommandResult<()> {
    let path = remote_gateway_registry_path().map_err(format_error)?;
    agentkib_gateways::remove(&path, &id)
        .await
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
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
) -> RefreshReceipt {
    coordinator.request(app, RefreshKind::Insights, true)
}

#[tauri::command]
async fn get_insights_view(
    query: InsightsQuery,
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
) -> CommandResult<InsightsView> {
    let running = coordinator.statuses().iter().any(|status| {
        status.kind == RefreshKind::Insights
            && matches!(
                status.state,
                refresh::RefreshState::Queued | refresh::RefreshState::Running
            )
    });
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<InsightsView> {
        let store = Store::open_default()?;
        Ok(InsightsView {
            summary: store.insights_summary(&query)?,
            heatmap: store.insights_heatmap(&query)?,
            agents: store.agent_usage_breakdown(&query)?,
            models: store.model_usage_breakdown(&query)?,
            workspaces: store.workspace_usage_breakdown(&query)?,
            repositories: store.repository_commit_breakdown(&query)?,
            achievements: store.list_achievements()?,
            status: store.insights_status(running)?,
        })
    })
    .await
    .map_err(format_error)?
    .map_err(format_error)
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
fn get_quota_snapshot() -> CommandResult<Option<QuotaSnapshot>> {
    Store::open_default()
        .and_then(|store| store.quota_snapshot())
        .map_err(format_error)
}

#[tauri::command]
fn get_quota_popover_preferences() -> CommandResult<QuotaPopoverPreferences> {
    Ok(load_desktop_preferences().quota_popover)
}

#[tauri::command]
fn set_quota_popover_preferences(
    mut preferences: QuotaPopoverPreferences,
    app: AppHandle,
) -> CommandResult<QuotaPopoverPreferences> {
    normalize_quota_popover_preferences(&mut preferences);
    let stored = preferences.clone();
    update_preferences(|desktop| desktop.quota_popover = stored).map_err(format_error)?;
    let _ = app.emit("agentkib:quota-popover-preferences-updated", &preferences);
    Ok(preferences)
}

fn normalize_quota_popover_preferences(preferences: &mut QuotaPopoverPreferences) {
    preferences
        .hidden_providers
        .retain(|provider| !provider.trim().is_empty());
    preferences.hidden_providers.sort();
    preferences.hidden_providers.dedup();
    preferences.hidden_windows.retain(|window| {
        !window.provider_id.trim().is_empty()
            && !window.kind.trim().is_empty()
            && !window.label.trim().is_empty()
    });
    preferences.hidden_windows.sort_by(|left, right| {
        (&left.provider_id, &left.account_id, &left.kind, &left.label).cmp(&(
            &right.provider_id,
            &right.account_id,
            &right.kind,
            &right.label,
        ))
    });
    preferences.hidden_windows.dedup();
}

#[tauri::command]
fn refresh_quota(
    app: AppHandle,
    coordinator: tauri::State<'_, Arc<RefreshCoordinator>>,
) -> RefreshReceipt {
    coordinator.request(app, RefreshKind::Quota, true)
}

#[tauri::command]
fn open_quota_dashboard(
    app: AppHandle,
    provider: Option<String>,
    window: Option<QuotaWindowSelector>,
    configure_popover: bool,
) {
    if let Some(popover) = app.get_webview_window("quota-popover") {
        let _ = popover.hide();
    }
    show_quota_page(&app, provider, window, configure_popover);
}

#[tauri::command]
fn get_quota_collector_status(
    app: AppHandle,
    state: tauri::State<'_, Arc<QuotaRuntime>>,
) -> CommandResult<QuotaCollectorStatus> {
    let context = quota_collection_context(&app).map_err(format_error)?;
    Store::open_default()
        .and_then(|store| {
            store.quota_collector_status(
                context.backend,
                context.platform_supported,
                context.sidecar_available,
                context.config_source,
                state.running.load(Ordering::SeqCst),
            )
        })
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
        app_icon_preference: state.app_icon_preference(),
        tray_available: state.tray_available(),
        session_index_enabled: state.session_index_enabled(),
    })
}

#[tauri::command]
fn open_files_and_folders_settings() -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    {
        const FILES_AND_FOLDERS_SETTINGS_URL: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
        std::process::Command::new("/usr/bin/open")
            .arg(FILES_AND_FOLDERS_SETTINGS_URL)
            .spawn()
            .map_err(|error| {
                LocalizedMessage::with_detail("errors.openSystemSettings", error.to_string())
            })?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd.exe")
            .args([
                "/D",
                "/C",
                "start",
                "",
                "ms-settings:privacy-broadfilesystemaccess",
            ])
            .spawn()
            .map_err(|error| {
                LocalizedMessage::with_detail("errors.openSystemSettings", error.to_string())
            })?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(LocalizedMessage::new("errors.unsupportedPlatform"))
    }
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
    #[cfg(target_os = "macos")]
    let _ = refresh_app_menu(&app);
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
fn set_app_icon_preference(
    preference: AppIconPreference,
    app: AppHandle,
    state: tauri::State<'_, Arc<LifecycleState>>,
    hub: tauri::State<'_, Arc<HubController>>,
) -> CommandResult<RuntimeInfo> {
    update_preferences(|preferences| preferences.app_icon_preference = preference)
        .map_err(format_error)?;
    apply_application_icon(&app, preference).map_err(format_error)?;
    state.set_app_icon_preference(preference);
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
    let canonical = platform_path::canonicalize(Path::new(project))?;
    let registered = Store::open_default()?
        .list_workspaces()?
        .into_iter()
        .any(|workspace| platform_path::equivalent(&workspace.path, &canonical));
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
        targets: AgentKind::WRITABLE.into_iter().collect(),
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
        #[cfg(target_os = "macos")]
        let _ = refresh_app_menu(app);
    }
}

fn apply_native_theme(app: &AppHandle, preference: ThemePreference) -> tauri::Result<()> {
    for label in ["main", "quota-popover"] {
        if let Some(window) = app.get_webview_window(label) {
            window.set_theme(preference.native())?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn application_icon(preference: AppIconPreference) -> tauri::image::Image<'static> {
    match preference {
        AppIconPreference::White => tauri::include_image!("icons/app-icon-white.png"),
        AppIconPreference::Black => tauri::include_image!("icons/app-icon-black.png"),
    }
}

#[cfg(target_os = "macos")]
fn apply_application_icon(app: &AppHandle, preference: AppIconPreference) -> tauri::Result<()> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let bytes: &'static [u8] = match preference {
        AppIconPreference::White => include_bytes!("../icons/app-icon-white.png"),
        AppIconPreference::Black => include_bytes!("../icons/app-icon-black.png"),
    };
    app.run_on_main_thread(move || {
        let marker = unsafe { MainThreadMarker::new_unchecked() };
        let application = NSApplication::sharedApplication(marker);
        let data = NSData::with_bytes(bytes);
        if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
            unsafe { application.setApplicationIconImage(Some(&icon)) };
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_application_icon(app: &AppHandle, preference: AppIconPreference) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(application_icon(preference))?;
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
    atomic_write(
        path,
        format!("{}\n", serde_json::to_string_pretty(preferences)?).as_bytes(),
    )?;
    Ok(())
}

fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let lifecycle = app.state::<Arc<LifecycleState>>();
        let tray_available = lifecycle.tray_available();
        #[cfg(target_os = "linux")]
        let tray_available = tray_available && {
            let available = linux_tray_host_available();
            if !available {
                lifecycle.set_tray_available(false);
            }
            available
        };
        if tray_available {
            let _ = window.hide();
        } else {
            // GNOME and other Linux desktops may not expose AppIndicator support.
            // Keep a taskbar entry so the user can always recover the window.
            let _ = window.minimize();
        }
        #[cfg(target_os = "macos")]
        if tray_available {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_tray_host_available() -> bool {
    let Some(executable) = agentkib_platform::command::resolve("gdbus") else {
        return false;
    };
    let mut command = Command::new(executable);
    command
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            "org.kde.StatusNotifierWatcher",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Ok(process_tree) = ProcessTree::attach(&child) else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return child
                    .wait_with_output()
                    .ok()
                    .is_some_and(|output| linux_tray_watcher_response(&output.stdout));
            }
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = process_tree.terminate();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_tray_watcher_response(output: &[u8]) -> bool {
    std::str::from_utf8(output).is_ok_and(|value| value.trim() == "(true,)")
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
    app.state::<Arc<StorageRuntime>>()
        .cancel_requested
        .store(true, Ordering::SeqCst);
    app.state::<Arc<RefreshCoordinator>>().shutdown();
    shutdown_external_commands();
    app.state::<Arc<HubController>>().shutdown();
    app.exit(0);
}

fn request_guarded_exit(app: &AppHandle) {
    let _ = app.emit("agentkib:quit-requested", ());
}

#[tauri::command]
fn quit_app(app: AppHandle, lifecycle: tauri::State<'_, Arc<LifecycleState>>) {
    request_real_exit(&app, lifecycle.inner());
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
        Some(CloseBehavior::Quit) => request_guarded_exit(&app),
        None => show_first_close_prompt(window, app, lifecycle),
    }
}

fn show_first_close_prompt(window: &tauri::Window, app: AppHandle, lifecycle: Arc<LifecycleState>) {
    if lifecycle.close_prompt_open.swap(true, Ordering::SeqCst) {
        return;
    }
    let locale = lifecycle.effective_locale();
    let tray_available = lifecycle.tray_available();
    let hide_label = translate(
        locale,
        if tray_available {
            if cfg!(target_os = "linux") {
                "dialog.close.hideSystemTray"
            } else {
                "dialog.close.hide"
            }
        } else {
            "dialog.close.minimize"
        },
        &[],
    );
    let quit_label = translate(locale, "dialog.close.quit", &[]);
    app.dialog()
        .message(translate(
            locale,
            if tray_available {
                if cfg!(target_os = "linux") {
                    "dialog.close.messageSystemTray"
                } else {
                    "dialog.close.message"
                }
            } else {
                "dialog.close.messageNoTray"
            },
            &[],
        ))
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
                    request_guarded_exit(&app);
                }
                _ => {}
            }
        });
}

#[cfg(target_os = "macos")]
const QUOTA_SIDECAR: &str = "agentkib-quota-sidecar";
const QUOTA_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug)]
struct QuotaCollectionContext {
    backend: QuotaBackend,
    platform_supported: bool,
    sidecar_available: bool,
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    sidecar_path: Option<PathBuf>,
    config_source: String,
    environment: BTreeMap<String, String>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct TauriQuotaRunner {
    app: AppHandle,
}

#[cfg(target_os = "macos")]
impl QuotaCommandRunner for TauriQuotaRunner {
    fn run(
        &self,
        args: &[String],
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> anyhow::Result<QuotaCommandOutput> {
        let command = self
            .app
            .shell()
            .sidecar(QUOTA_SIDECAR)?
            .args(args)
            .envs(env)
            .set_raw_out(true);
        let (mut events, child) = command.spawn()?;
        let mut child = Some(child);
        let started = Instant::now();
        let coordinator = self.app.state::<Arc<RefreshCoordinator>>().inner().clone();
        tauri::async_runtime::block_on(async move {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            loop {
                if !coordinator.is_accepting() {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                    anyhow::bail!("quota collector was cancelled because AgentKib is exiting");
                }
                let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                    if let Some(child) = child.take() {
                        let _ = child.kill();
                    }
                    anyhow::bail!("quota collector timed out");
                };
                match tokio::time::timeout(remaining.min(Duration::from_millis(100)), events.recv())
                    .await
                {
                    Ok(Some(CommandEvent::Stdout(bytes))) => {
                        if stdout.len().saturating_add(bytes.len()) > QUOTA_OUTPUT_LIMIT {
                            if let Some(child) = child.take() {
                                let _ = child.kill();
                            }
                            anyhow::bail!("quota collector stdout exceeded the size limit");
                        }
                        stdout.extend(bytes);
                    }
                    Ok(Some(CommandEvent::Stderr(bytes))) => {
                        if stderr.len().saturating_add(bytes.len()) > QUOTA_OUTPUT_LIMIT {
                            if let Some(child) = child.take() {
                                let _ = child.kill();
                            }
                            anyhow::bail!("quota collector stderr exceeded the size limit");
                        }
                        stderr.extend(bytes);
                    }
                    Ok(Some(CommandEvent::Terminated(payload))) => {
                        exit_code = payload.code;
                        break;
                    }
                    Ok(Some(CommandEvent::Error(error))) => {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                        anyhow::bail!(error)
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                        break;
                    }
                    Err(_) => continue,
                }
            }
            Ok(QuotaCommandOutput {
                stdout,
                stderr,
                success: exit_code == Some(0),
            })
        })
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct LinuxQuotaRunner {
    app: AppHandle,
    executable: PathBuf,
}

#[cfg(target_os = "linux")]
impl QuotaCommandRunner for LinuxQuotaRunner {
    fn run(
        &self,
        args: &[String],
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> anyhow::Result<QuotaCommandOutput> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The collector may launch provider helpers. A dedicated process group
        // lets timeout and app shutdown terminate the complete sidecar tree.
        configure_process_group(&mut command);
        let mut child = command.spawn()?;
        let process_tree = ProcessTree::attach(&child).inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
        })?;
        let stdout = child
            .stdout
            .take()
            .context("quota collector stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("quota collector stderr is unavailable")?;
        let stdout_reader = std::thread::spawn(move || read_bounded_output(stdout));
        let stderr_reader = std::thread::spawn(move || read_bounded_output(stderr));
        let started = Instant::now();
        let coordinator = self.app.state::<Arc<RefreshCoordinator>>().inner().clone();
        let success = loop {
            if !coordinator.is_accepting() {
                let _ = process_tree.terminate();
                let _ = child.wait();
                anyhow::bail!("quota collector was cancelled because AgentKib is exiting");
            }
            if started.elapsed() >= timeout {
                let _ = process_tree.terminate();
                let _ = child.wait();
                anyhow::bail!("quota collector timed out");
            }
            if let Some(status) = child.try_wait()? {
                break status.success();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stdout = stdout_reader
            .join()
            .map_err(|_| anyhow::anyhow!("quota collector stdout reader panicked"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| anyhow::anyhow!("quota collector stderr reader panicked"))??;
        Ok(QuotaCommandOutput {
            stdout,
            stderr,
            success,
        })
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsQuotaRunner {
    app: AppHandle,
    executable: PathBuf,
}

#[cfg(target_os = "windows")]
impl QuotaCommandRunner for WindowsQuotaRunner {
    fn run(
        &self,
        args: &[String],
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> anyhow::Result<QuotaCommandOutput> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let process_tree = ProcessTree::attach(&child).inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
        })?;
        let stdout = child
            .stdout
            .take()
            .context("quota collector stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("quota collector stderr is unavailable")?;
        let stdout_reader = std::thread::spawn(move || read_bounded_output(stdout));
        let stderr_reader = std::thread::spawn(move || read_bounded_output(stderr));
        let started = Instant::now();
        let coordinator = self.app.state::<Arc<RefreshCoordinator>>().inner().clone();
        let success = loop {
            if !coordinator.is_accepting() {
                let _ = process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("quota collector was cancelled because AgentKib is exiting");
            }
            if started.elapsed() >= timeout {
                let _ = process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("quota collector timed out");
            }
            if let Some(status) = child.try_wait()? {
                break status.success();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stdout = stdout_reader
            .join()
            .map_err(|_| anyhow::anyhow!("quota collector stdout reader panicked"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| anyhow::anyhow!("quota collector stderr reader panicked"))??;
        Ok(QuotaCommandOutput {
            stdout,
            stderr,
            success,
        })
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn read_bounded_output(mut reader: impl Read) -> anyhow::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader
        .by_ref()
        .take(QUOTA_OUTPUT_LIMIT as u64 + 1)
        .read_to_end(&mut output)?;
    if output.len() > QUOTA_OUTPUT_LIMIT {
        anyhow::bail!("quota collector output exceeded the size limit");
    }
    Ok(output)
}

fn quota_backend() -> QuotaBackend {
    #[cfg(target_os = "windows")]
    {
        QuotaBackend::WinCodexBar
    }
    #[cfg(not(target_os = "windows"))]
    {
        QuotaBackend::CodexBarCli
    }
}

fn quota_platform_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
        || cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

fn quota_sidecar_path(_app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let path = _app
        .path()
        .resource_dir()
        .ok()?
        .join("windows")
        .join("agentkib-quota-sidecar.exe");
    #[cfg(not(target_os = "windows"))]
    let path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("agentkib-quota-sidecar");
    path.is_file().then_some(path)
}

fn quota_collection_context(app: &AppHandle) -> anyhow::Result<QuotaCollectionContext> {
    let process_environment = std::env::vars().collect::<BTreeMap<_, _>>();
    #[cfg(not(target_os = "windows"))]
    let home = dirs::home_dir().context("Home directory is unavailable")?;
    let mut environment = BTreeMap::new();
    #[cfg(target_os = "windows")]
    let config_source = resolve_win_codexbar_config(&process_environment)
        .map(|_| "win-codexbar".to_string())
        .unwrap_or_else(|| "automatic".to_string());
    #[cfg(not(target_os = "windows"))]
    let (config_path, config_source) =
        if let Some(path) = resolve_codexbar_config(&home, &process_environment) {
            let source = if process_environment.contains_key("CODEXBAR_CONFIG") {
                "environment"
            } else {
                "codexbar"
            };
            (path, source.to_string())
        } else {
            let path = default_data_dir()?.join("quota/codexbar-config.json");
            let installations = Store::open_default()?.list_agent_installations()?;
            let mut providers = Vec::new();
            if installations
                .iter()
                .any(|value| value.installed && value.agent == AgentKind::Codex)
            {
                providers.push("codex");
            }
            if installations
                .iter()
                .any(|value| value.installed && value.agent == AgentKind::ClaudeCode)
            {
                providers.push("claude");
            }
            if installations
                .iter()
                .any(|value| value.installed && value.agent == AgentKind::Cursor)
            {
                providers.push("cursor");
            }
            if providers.is_empty() {
                providers.push("codex");
            }
            write_managed_config(&path, &providers)?;
            (path, "agentkib-managed".to_string())
        };
    #[cfg(not(target_os = "windows"))]
    environment.insert(
        "CODEXBAR_CONFIG".to_string(),
        config_path.to_string_lossy().into_owned(),
    );
    if let Ok(path) = std::env::var("PATH") {
        environment.insert("PATH".to_string(), path);
    }
    let sidecar_path = quota_sidecar_path(app);
    Ok(QuotaCollectionContext {
        backend: quota_backend(),
        platform_supported: quota_platform_supported(),
        sidecar_available: sidecar_path.is_some(),
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        sidecar_path,
        config_source,
        environment,
    })
}

fn quota_error_key(error: &anyhow::Error, context: &QuotaCollectionContext) -> &'static str {
    if !context.platform_supported {
        "errors.quotaUnsupportedPlatform"
    } else if !context.sidecar_available {
        "errors.quotaSidecarMissing"
    } else if error.to_string().contains("schema version") {
        "errors.quotaSchemaUnsupported"
    } else if error.to_string().contains("timed out") {
        "errors.quotaTimeout"
    } else {
        "errors.quotaUnavailable"
    }
}

fn perform_quota(
    app: &AppHandle,
    state: &QuotaRuntime,
    write_lock: &Mutex<()>,
) -> CommandResult<QuotaSnapshot> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.quotaRunning"));
    }
    let result = (|| -> anyhow::Result<QuotaSnapshot> {
        let context = quota_collection_context(app)?;
        #[cfg(target_os = "macos")]
        let runner = TauriQuotaRunner { app: app.clone() };
        #[cfg(target_os = "linux")]
        let runner = LinuxQuotaRunner {
            app: app.clone(),
            executable: context
                .sidecar_path
                .clone()
                .context("quota collector sidecar is unavailable")?,
        };
        #[cfg(target_os = "windows")]
        let runner = WindowsQuotaRunner {
            app: app.clone(),
            executable: context
                .sidecar_path
                .clone()
                .context("quota collector sidecar is unavailable")?,
        };
        let collector = DashboardCliCollector::new(
            context.backend,
            runner,
            context.environment.clone(),
            CollectorCapabilities {
                platform_supported: context.platform_supported,
                sidecar_available: context.sidecar_available,
                multi_account: true,
                credits: true,
            },
        );
        match collector.collect(Duration::from_secs(35)) {
            Ok(snapshot) => {
                let _write = write_lock
                    .lock()
                    .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
                Store::open_default()?.save_quota_snapshot(&snapshot)?;
                Ok(snapshot)
            }
            Err(error) => {
                let key = quota_error_key(&error, &context);
                let detail = sanitize_diagnostic(&error.to_string());
                let _write = write_lock
                    .lock()
                    .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
                Store::open_default()?.record_quota_failure(
                    context.backend,
                    key,
                    (!detail.is_empty()).then_some(detail.as_str()),
                )?;
                Err(error)
            }
        }
    })();
    state.running.store(false, Ordering::SeqCst);
    match result {
        Ok(snapshot) => {
            let _ = app.emit("agentkib:quota-updated", &snapshot);
            Ok(snapshot)
        }
        Err(error) => Err(LocalizedMessage::with_detail(
            if !quota_platform_supported() {
                "errors.quotaUnsupportedPlatform"
            } else if quota_sidecar_path(app).is_none() {
                "errors.quotaSidecarMissing"
            } else if error.to_string().contains("schema version") {
                "errors.quotaSchemaUnsupported"
            } else if error.to_string().contains("timed out") {
                "errors.quotaTimeout"
            } else {
                "errors.quotaUnavailable"
            },
            sanitize_diagnostic(&error.to_string()),
        )),
    }
}

#[cfg(target_os = "macos")]
const QUOTA_POPOVER_WIDTH: f64 = 392.0;
#[cfg(target_os = "macos")]
const QUOTA_POPOVER_HEIGHT: f64 = 560.0;

#[cfg(target_os = "macos")]
fn setup_quota_popover(app: &tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        "quota-popover",
        WebviewUrl::App("index.html?surface=quota-popover".into()),
    )
    .title("AgentKib Quota")
    .inner_size(QUOTA_POPOVER_WIDTH, QUOTA_POPOVER_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .build()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn quota_popover_position(
    tray_x: f64,
    tray_y: f64,
    tray_width: f64,
    tray_height: f64,
    work_area: Option<(f64, f64, f64, f64)>,
    scale: f64,
) -> PhysicalPosition<i32> {
    let width = QUOTA_POPOVER_WIDTH * scale;
    let height = QUOTA_POPOVER_HEIGHT * scale;
    let mut x = tray_x + (tray_width - width) / 2.0;
    let mut y = tray_y + tray_height + 6.0 * scale;
    if let Some((left, top, work_width, work_height)) = work_area {
        let right = left + work_width;
        let bottom = top + work_height;
        x = x.clamp(left + 8.0, (right - width - 8.0).max(left + 8.0));
        y = y.clamp(top + 8.0, (bottom - height - 8.0).max(top + 8.0));
    }
    PhysicalPosition::new(x.round() as i32, y.round() as i32)
}

#[cfg(target_os = "macos")]
fn toggle_quota_popover(app: &AppHandle, tray_rect: &tauri::Rect) {
    let Some(window) = app.get_webview_window("quota-popover") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let tray_position = tray_rect.position.to_physical::<f64>(scale);
    let tray_size = tray_rect.size.to_physical::<f64>(scale);
    let monitor = window
        .monitor_from_point(tray_position.x, tray_position.y)
        .ok()
        .flatten();
    let monitor_scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(scale);
    let work_area = monitor.map(|monitor| {
        let work_area = monitor.work_area();
        (
            f64::from(work_area.position.x),
            f64::from(work_area.position.y),
            f64::from(work_area.size.width),
            f64::from(work_area.size.height),
        )
    });
    let position = quota_popover_position(
        tray_position.x,
        tray_position.y,
        tray_size.width,
        tray_size.height,
        work_area,
        monitor_scale,
    );
    let _ = window.set_position(position);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(not(target_os = "macos"))]
fn setup_quota_popover(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn refresh_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder,
    };

    let locale = app.state::<Arc<LifecycleState>>().effective_locale();
    let item = |id: &str, key: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, translate(locale, key, &[]), true, accelerator)
    };

    let about = PredefinedMenuItem::about(
        app,
        Some(&translate(locale, "menu.about", &[])),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("AgentKib"))
                .version(Some(app.package_info().version.to_string()))
                .icon(app.default_window_icon().cloned())
                .build(),
        ),
    )?;
    let settings = item("app-menu:settings", "menu.settings", Some("CmdOrCtrl+,"))?;
    let services =
        PredefinedMenuItem::services(app, Some(&translate(locale, "menu.services", &[])))?;
    let hide = PredefinedMenuItem::hide(app, Some(&translate(locale, "menu.hide", &[])))?;
    let hide_others =
        PredefinedMenuItem::hide_others(app, Some(&translate(locale, "menu.hideOthers", &[])))?;
    let show_all =
        PredefinedMenuItem::show_all(app, Some(&translate(locale, "menu.showAll", &[])))?;
    let quit = item("app-menu:quit", "menu.quit", Some("CmdOrCtrl+Q"))?;
    let app_menu = SubmenuBuilder::new(app, "AgentKib")
        .items(&[&about, &settings])
        .separator()
        .item(&services)
        .separator()
        .items(&[&hide, &hide_others, &show_all])
        .separator()
        .item(&quit)
        .build()?;

    let add_workspace = item(
        "app-menu:add-workspace",
        "menu.addWorkspace",
        Some("CmdOrCtrl+O"),
    )?;
    let add_scan_root = item(
        "app-menu:add-scan-root",
        "menu.addScanRoot",
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let close_window =
        PredefinedMenuItem::close_window(app, Some(&translate(locale, "menu.closeWindow", &[])))?;
    let file_menu = SubmenuBuilder::new(app, translate(locale, "menu.file", &[]))
        .items(&[&add_workspace, &add_scan_root])
        .separator()
        .item(&close_window)
        .build()?;

    let undo = PredefinedMenuItem::undo(app, Some(&translate(locale, "menu.undo", &[])))?;
    let redo = PredefinedMenuItem::redo(app, Some(&translate(locale, "menu.redo", &[])))?;
    let cut = PredefinedMenuItem::cut(app, Some(&translate(locale, "menu.cut", &[])))?;
    let copy = PredefinedMenuItem::copy(app, Some(&translate(locale, "menu.copy", &[])))?;
    let paste = PredefinedMenuItem::paste(app, Some(&translate(locale, "menu.paste", &[])))?;
    let select_all =
        PredefinedMenuItem::select_all(app, Some(&translate(locale, "menu.selectAll", &[])))?;
    let edit_menu = SubmenuBuilder::new(app, translate(locale, "menu.edit", &[]))
        .items(&[&undo, &redo])
        .separator()
        .items(&[&cut, &copy, &paste, &select_all])
        .build()?;

    let home = item("app-menu:navigate-home", "nav.home", Some("CmdOrCtrl+1"))?;
    let workspaces = item(
        "app-menu:navigate-workspaces",
        "nav.workspaces",
        Some("CmdOrCtrl+2"),
    )?;
    let assets = item(
        "app-menu:navigate-catalog",
        "nav.assets",
        Some("CmdOrCtrl+3"),
    )?;
    let agents = item(
        "app-menu:navigate-agents",
        "nav.agents",
        Some("CmdOrCtrl+4"),
    )?;
    let quota = item("app-menu:navigate-quota", "nav.quota", Some("CmdOrCtrl+5"))?;
    let insights = item(
        "app-menu:navigate-insights",
        "nav.insights",
        Some("CmdOrCtrl+6"),
    )?;
    let toggle_sidebar = item(
        "app-menu:toggle-sidebar",
        "menu.toggleSidebar",
        Some("CmdOrCtrl+Shift+Backslash"),
    )?;
    let refresh_current = item(
        "app-menu:refresh-current",
        "menu.refreshCurrent",
        Some("CmdOrCtrl+R"),
    )?;
    let refresh_all = item("app-menu:refresh-all", "menu.refreshAll", None)?;
    let fullscreen =
        PredefinedMenuItem::fullscreen(app, Some(&translate(locale, "menu.fullscreen", &[])))?;
    let view_menu = SubmenuBuilder::new(app, translate(locale, "menu.view", &[]))
        .items(&[&home, &workspaces, &assets, &agents, &quota, &insights])
        .separator()
        .item(&toggle_sidebar)
        .separator()
        .items(&[&refresh_current, &refresh_all])
        .separator()
        .item(&fullscreen)
        .build()?;

    let minimize =
        PredefinedMenuItem::minimize(app, Some(&translate(locale, "menu.minimize", &[])))?;
    let zoom = PredefinedMenuItem::maximize(app, Some(&translate(locale, "menu.zoom", &[])))?;
    let window_menu = SubmenuBuilder::new(app, translate(locale, "menu.window", &[]))
        .items(&[&minimize, &zoom])
        .build()?;

    let docs = item("app-menu:help-docs", "menu.helpDocs", None)?;
    let privacy = item("app-menu:settings-privacy", "menu.dataPrivacy", None)?;
    let diagnostics = item("app-menu:settings-diagnostics", "menu.diagnostics", None)?;
    let report_issue = item("app-menu:report-issue", "menu.reportIssue", None)?;
    let help_menu = SubmenuBuilder::new(app, translate(locale, "menu.help", &[]))
        .item(&docs)
        .separator()
        .items(&[&privacy, &diagnostics])
        .separator()
        .item(&report_issue)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn handle_app_menu_event(_app: &AppHandle, _id: &str) {}

#[cfg(target_os = "macos")]
fn handle_app_menu_event(app: &AppHandle, id: &str) {
    match id {
        "app-menu:settings" => show_settings_page(app),
        "app-menu:add-workspace" => emit_app_command(app, "add-workspace"),
        "app-menu:add-scan-root" => emit_app_command(app, "add-scan-root"),
        "app-menu:toggle-sidebar" => emit_app_command(app, "toggle-sidebar"),
        "app-menu:refresh-current" => emit_app_command(app, "refresh-current"),
        "app-menu:refresh-all" => emit_app_command(app, "refresh-all"),
        "app-menu:navigate-home" => show_global_page(app, "home"),
        "app-menu:navigate-workspaces" => show_global_page(app, "workspaces"),
        "app-menu:navigate-catalog" => show_global_page(app, "catalog"),
        "app-menu:navigate-agents" => show_global_page(app, "agents"),
        "app-menu:navigate-quota" => show_quota_page(app, None, None, false),
        "app-menu:navigate-insights" => show_global_page(app, "insights"),
        "app-menu:settings-privacy" => show_settings_section(app, "privacy"),
        "app-menu:settings-diagnostics" => show_settings_section(app, "diagnostics"),
        "app-menu:help-docs" => {
            let _ = app
                .opener()
                .open_url("https://github.com/starroyhq/agentkib#readme", None::<&str>);
        }
        "app-menu:report-issue" => {
            let _ = app.opener().open_url(
                "https://github.com/starroyhq/agentkib/issues/new",
                None::<&str>,
            );
        }
        "app-menu:quit" => request_guarded_exit(app),
        _ => {}
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let locale = app.state::<Arc<LifecycleState>>().effective_locale();
    let status = MenuItem::with_id(
        app,
        "status",
        translate(locale, "tray.refreshing", &[]),
        false,
        None::<&str>,
    )?;
    let mcp_status =
        MenuItem::with_id(app, "mcp_status", "MCP Hub · starting", false, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .text("show", translate(locale, "tray.open", &[]))
        .text("quota_all", translate(locale, "tray.quotaAll", &[]))
        .text(
            "refresh_quota",
            translate(locale, "tray.refreshQuotaAction", &[]),
        )
        .separator()
        .items(&[&status, &mcp_status])
        .text("settings", translate(locale, "nav.settings", &[]))
        .text("refresh_all", translate(locale, "tray.refreshAll", &[]))
        .separator()
        .text("quit", translate(locale, "tray.quit", &[]))
        .build()?;
    #[cfg(target_os = "windows")]
    let tray_image = tauri::include_image!("icons/tray-icon-windows.png");
    #[cfg(not(target_os = "windows"))]
    let tray_image = tauri::include_image!("icons/tray-icon.png");
    let mut tray = TrayIconBuilder::with_id("agentkib-status")
        .icon(tray_image)
        .menu(&menu)
        .tooltip(translate(locale, "tray.tooltip", &[]))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "refresh_quota" => {
                let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
                coordinator.request(app.clone(), RefreshKind::Quota, true);
            }
            "refresh_all" => {
                let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
                for kind in [
                    RefreshKind::Discovery,
                    RefreshKind::Insights,
                    RefreshKind::Gateways,
                    RefreshKind::Quota,
                ] {
                    coordinator.request(app.clone(), kind, true);
                }
            }
            "quota_all" => show_quota_page(app, None, None, false),
            "settings" => show_settings_page(app),
            "quit" => {
                request_guarded_exit(app);
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        tray = tray
            .icon_as_template(true)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    rect,
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    toggle_quota_popover(tray.app_handle(), &rect);
                }
            });
    }

    #[cfg(not(target_os = "macos"))]
    {
        tray = tray.show_menu_on_left_click(true);
    }
    tray.build(app)?;
    Ok(())
}

#[derive(Clone, Serialize)]
struct NavigationRequest {
    page: &'static str,
    settings_section: Option<&'static str>,
    provider: Option<String>,
    window: Option<QuotaWindowSelector>,
    configure_popover: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct AppMenuCommandRequest {
    command: &'static str,
}

#[cfg(target_os = "macos")]
fn emit_app_command(app: &AppHandle, command: &'static str) {
    show_main_window(app);
    let _ = app.emit("agentkib:app-command", AppMenuCommandRequest { command });
}

#[cfg(target_os = "macos")]
fn show_global_page(app: &AppHandle, page: &'static str) {
    show_main_window(app);
    let _ = app.emit(
        "agentkib:navigate",
        NavigationRequest {
            page,
            settings_section: None,
            provider: None,
            window: None,
            configure_popover: false,
        },
    );
}

fn show_quota_page(
    app: &AppHandle,
    provider: Option<String>,
    window: Option<QuotaWindowSelector>,
    configure_popover: bool,
) {
    show_main_window(app);
    let _ = app.emit(
        "agentkib:navigate",
        NavigationRequest {
            page: "quota",
            settings_section: None,
            provider,
            window,
            configure_popover,
        },
    );
}

fn show_settings_page(app: &AppHandle) {
    show_settings_section(app, "general");
}

fn show_settings_section(app: &AppHandle, settings_section: &'static str) {
    show_main_window(app);
    let _ = app.emit(
        "agentkib:navigate",
        NavigationRequest {
            page: "settings",
            settings_section: Some(settings_section),
            provider: None,
            window: None,
            configure_popover: false,
        },
    );
}

fn perform_discovery(
    app: &AppHandle,
    state: &DiscoveryRuntime,
    write_lock: &Mutex<()>,
) -> CommandResult<DiscoveryReport> {
    if state.running.swap(true, Ordering::SeqCst) {
        return state
            .last_report
            .lock()
            .expect("Discovery state lock is poisoned")
            .clone()
            .ok_or_else(|| LocalizedMessage::new("errors.discoveryRunning"));
    }
    let result = (|| -> anyhow::Result<DiscoveryReport> {
        let roots: Vec<_> = Store::open_default()?
            .list_scan_roots()?
            .into_iter()
            .filter(|root| root.enabled)
            .map(|root| (root.path, root.max_depth))
            .collect();
        let started_at = chrono::Utc::now();
        let snapshot = discover_local_workspaces(&roots);
        let _write = write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
        let store = Store::open_default()?;
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
            Ok(report)
        }
        Err(error) => Err(format_error(error)),
    }
}

fn refresh_tray_status(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem};
    if !app.state::<Arc<LifecycleState>>().tray_available() {
        return Ok(());
    }
    let workspaces = Store::open_default()
        .and_then(|store| store.list_workspaces())
        .unwrap_or_default();
    let attention = workspaces
        .iter()
        .filter(|workspace| !matches!(workspace.status, agentkib_core::WorkspaceStatus::Healthy))
        .count();
    let locale = app.state::<Arc<LifecycleState>>().effective_locale();
    let hub_status = app.state::<Arc<HubController>>().status();
    let refresh_statuses = app.state::<Arc<RefreshCoordinator>>().statuses();
    let active_refreshes = refresh_statuses
        .iter()
        .filter_map(|status| {
            matches!(
                status.state,
                refresh::RefreshState::Queued | refresh::RefreshState::Running
            )
            .then_some(status.kind)
        })
        .collect::<Vec<_>>();
    let status_text = active_refresh_translation_key(&active_refreshes).map_or_else(
        || {
            translate(
                locale,
                "tray.status",
                &[
                    ("workspaces", workspaces.len().to_string()),
                    ("attention", attention.to_string()),
                ],
            )
        },
        |key| translate(locale, key, &[]),
    );
    let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
    let mcp_status = MenuItem::with_id(
        app,
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
        false,
        None::<&str>,
    )?;
    let menu = MenuBuilder::new(app)
        .text("show", translate(locale, "tray.open", &[]))
        .text("quota_all", translate(locale, "tray.quotaAll", &[]))
        .text(
            "refresh_quota",
            translate(locale, "tray.refreshQuotaAction", &[]),
        )
        .separator()
        .items(&[&status, &mcp_status])
        .text("settings", translate(locale, "nav.settings", &[]))
        .text("refresh_all", translate(locale, "tray.refreshAll", &[]))
        .separator()
        .text("quit", translate(locale, "tray.quit", &[]))
        .build()?;
    if let Some(tray) = app.tray_by_id("agentkib-status") {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(translate(locale, "tray.tooltip", &[])))?;
    }
    Ok(())
}

fn active_refresh_translation_key(active: &[RefreshKind]) -> Option<&'static str> {
    match active {
        [] => None,
        [RefreshKind::Discovery] => Some("tray.refreshDiscovery"),
        [RefreshKind::Insights] => Some("tray.refreshInsights"),
        [RefreshKind::Gateways] => Some("tray.refreshGateways"),
        [RefreshKind::Quota] => Some("tray.refreshQuota"),
        [RefreshKind::Storage] => Some("tray.refreshMultiple"),
        _ => Some("tray.refreshMultiple"),
    }
}

fn perform_insights(
    app: &AppHandle,
    state: &InsightsRuntime,
    write_lock: &Mutex<()>,
) -> CommandResult<InsightsSummary> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.insightsRunning"));
    }
    let result = (|| -> anyhow::Result<InsightsSummary> {
        let store = Store::open_default()?;
        let workspaces = store.list_workspaces()?;
        let fingerprints = store.insight_git_fingerprints()?;
        let usage_cursors = store.insight_usage_cursors()?;
        let parallelism = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(2);
        let window_visible = app
            .get_webview_window("main")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        let policy = InsightsCollectionPolicy::for_parallelism(parallelism, window_visible);
        // 文件、Agent CLI 和 Git 读取均发生在数据库事务之外，避免后台刷新长期占锁。
        let usage = collect_usage(&usage_cursors, policy);
        let repositories = collect_git(&workspaces, &fingerprints, policy);
        let _write = write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
        let store = Store::open_default()?;
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

fn perform_storage(
    app: &AppHandle,
    state: &StorageRuntime,
    request_id: &str,
    write_lock: &Mutex<()>,
) -> CommandResult<StorageOverview> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.storageRunning"));
    }
    let result = (|| -> anyhow::Result<StorageOverview> {
        let store = Store::open_default()?;
        let mut workspaces = store.list_workspaces()?;
        // Stable path order keeps cross-workspace hard-link ownership deterministic across
        // interrupted scans, so last-good rows cannot temporarily double-count a link.
        workspaces.sort_by(|left, right| left.path.cmp(&right.path));
        drop(store);
        let roots = workspaces
            .iter()
            .map(|workspace| workspace.path.clone())
            .collect::<Vec<_>>();
        let total = workspaces.len() as u64;
        let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
        coordinator.set_progress(app, RefreshKind::Storage, request_id, 0, total);
        let mut hard_links = HardLinkSet::default();

        for (index, workspace) in workspaces.iter().enumerate() {
            if state.cancel_requested.load(Ordering::SeqCst) {
                break;
            }
            if storage_path_is_too_broad(&workspace.path) {
                {
                    let _write = write_lock
                        .lock()
                        .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
                    Store::open_default()?.record_workspace_storage_failure(
                        &workspace.id,
                        Utc::now(),
                        "storage.scanTooBroad",
                        None,
                    )?;
                }
                let overview = Store::open_default()?.storage_overview()?;
                let _ = app.emit("agentkib:storage-updated", &overview);
                coordinator.set_progress(
                    app,
                    RefreshKind::Storage,
                    request_id,
                    index as u64 + 1,
                    total,
                );
                continue;
            }
            let excluded_roots = roots
                .iter()
                .filter(|path| {
                    !platform_path::equivalent(path, &workspace.path)
                        && platform_path::starts_with(path, &workspace.path)
                })
                .cloned()
                .collect::<Vec<_>>();
            let source = StorageWorkspace {
                id: workspace.id.clone(),
                name: workspace.name.clone(),
                path: workspace.path.clone(),
            };
            let scan = scan_workspace_storage(&source, &excluded_roots, &mut hard_links, || {
                state.cancel_requested.load(Ordering::Relaxed)
            });
            if scan.cancelled {
                break;
            }
            {
                let _write = write_lock
                    .lock()
                    .map_err(|_| anyhow::anyhow!("refresh database write lock is poisoned"))?;
                let store = Store::open_default()?;
                if scan.storage.last_success_at.is_some() {
                    store.save_workspace_storage(&scan.storage)?;
                } else {
                    store.record_workspace_storage_failure(
                        &workspace.id,
                        scan.storage.last_attempt_at,
                        scan.storage
                            .error_key
                            .as_deref()
                            .unwrap_or("storage.scanUnavailable"),
                        scan.storage.error_detail.as_deref(),
                    )?;
                }
            }
            let overview = Store::open_default()?.storage_overview()?;
            let _ = app.emit("agentkib:storage-updated", &overview);
            coordinator.set_progress(
                app,
                RefreshKind::Storage,
                request_id,
                index as u64 + 1,
                total,
            );
        }
        let overview = Store::open_default()?.storage_overview()?;
        let _ = app.emit("agentkib:storage-updated", &overview);
        Ok(overview)
    })();
    state.running.store(false, Ordering::SeqCst);
    result.map_err(format_error)
}

fn storage_path_is_too_broad(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    platform_path::equivalent(path, &home)
}

fn run_refresh_job(
    app: &AppHandle,
    kind: RefreshKind,
    request_id: &str,
    write_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    let result = match kind {
        RefreshKind::Discovery => {
            let state = app.state::<Arc<DiscoveryRuntime>>();
            perform_discovery(app, state.inner(), write_lock).map(|_| ())
        }
        RefreshKind::Insights => {
            let state = app.state::<Arc<InsightsRuntime>>();
            perform_insights(app, state.inner(), write_lock).map(|_| ())
        }
        RefreshKind::Gateways => remote_gateway_registry_path()
            .and_then(|path| tauri::async_runtime::block_on(agentkib_gateways::refresh_all(&path)))
            .map(|gateways| {
                record_remote_gateway_achievements(&gateways);
                let _ = app.emit("agentkib:remote-gateways-updated", gateways);
            })
            .map_err(format_error),
        RefreshKind::Quota => {
            let state = app.state::<Arc<QuotaRuntime>>();
            perform_quota(app, state.inner(), write_lock).map(|_| ())
        }
        RefreshKind::Storage => {
            let state = app.state::<Arc<StorageRuntime>>();
            perform_storage(app, state.inner(), request_id, write_lock).map(|_| ())
        }
    };
    result.map_err(|error| anyhow::anyhow!(error.detail.unwrap_or(error.key)))
}

fn start_refresh_scheduler(
    app: AppHandle,
    kind: RefreshKind,
    initial_delay: Duration,
    max_age: chrono::Duration,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(initial_delay).await;
        loop {
            let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
            if kind != RefreshKind::Gateways || remote_gateways_configured() {
                coordinator.request_if_stale(app.clone(), kind, max_age);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn start_quota_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        loop {
            request_quota_if_due(&app);
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

fn start_refresh_schedulers(app: AppHandle) {
    start_quota_scheduler(app.clone());
    start_refresh_scheduler(
        app.clone(),
        RefreshKind::Discovery,
        Duration::from_secs(3),
        chrono::Duration::minutes(15),
    );
    start_refresh_scheduler(
        app.clone(),
        RefreshKind::Gateways,
        Duration::from_secs(5),
        chrono::Duration::minutes(15),
    );
    start_refresh_scheduler(
        app,
        RefreshKind::Insights,
        Duration::from_secs(30),
        chrono::Duration::minutes(30),
    );
}

fn seed_refresh_freshness(app: &AppHandle) {
    let coordinator = app.state::<Arc<RefreshCoordinator>>().inner();
    if let Ok(store) = Store::open_default() {
        coordinator.seed_finished_at(
            RefreshKind::Discovery,
            store.latest_discovery_finished_at().ok().flatten(),
        );
        coordinator.seed_finished_at(
            RefreshKind::Insights,
            store.latest_activity_at("insights.refresh").ok().flatten(),
        );
        coordinator.seed_finished_at(
            RefreshKind::Quota,
            store.quota_last_success_at().ok().flatten(),
        );
    }
    let gateway_finished_at = remote_gateway_registry_path()
        .ok()
        .and_then(|path| agentkib_gateways::list(&path).ok())
        .and_then(|gateways| {
            (!gateways.is_empty()
                && gateways
                    .iter()
                    .all(|value| value.last_connected_at.is_some()))
            .then(|| {
                gateways
                    .into_iter()
                    .filter_map(|value| value.last_connected_at)
                    .min()
            })
            .flatten()
        });
    coordinator.seed_finished_at(RefreshKind::Gateways, gateway_finished_at);
}

fn remote_gateways_configured() -> bool {
    remote_gateway_registry_path()
        .ok()
        .and_then(|path| agentkib_gateways::list(&path).ok())
        .is_some_and(|gateways| !gateways.is_empty())
}

fn request_quota_if_due(app: &AppHandle) {
    let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
    let (snapshot, last_success) = Store::open_default()
        .map(|store| {
            (
                store.quota_snapshot().ok().flatten(),
                store.quota_last_success_at().ok().flatten(),
            )
        })
        .unwrap_or_default();
    let window_visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let low_remaining = snapshot.as_ref().is_some_and(|snapshot| {
        snapshot
            .providers
            .iter()
            .filter_map(|provider| provider.lowest_remaining_percent())
            .reduce(f64::min)
            .is_some_and(|remaining| remaining <= 20.0)
    });
    let max_age = if window_visible || low_remaining {
        chrono::Duration::minutes(5)
    } else {
        chrono::Duration::minutes(15)
    };
    if snapshot
        .as_ref()
        .is_some_and(|snapshot| quota_reset_due(snapshot, last_success, Utc::now()))
    {
        coordinator.request(app.clone(), RefreshKind::Quota, false);
    } else {
        coordinator.request_if_stale(app.clone(), RefreshKind::Quota, max_age);
    }
}

fn quota_reset_due(
    snapshot: &QuotaSnapshot,
    last_success: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    let reset_cutoff = now - chrono::Duration::minutes(1);
    snapshot.providers.iter().any(|provider| {
        provider
            .windows
            .iter()
            .chain(
                provider
                    .accounts
                    .iter()
                    .flat_map(|account| account.windows.iter()),
            )
            .filter_map(|window| window.reset_at)
            .any(|reset| {
                reset <= reset_cutoff && last_success.is_none_or(|success| success < reset)
            })
    })
}

fn format_error(error: impl std::fmt::Display) -> LocalizedMessage {
    LocalizedMessage::with_detail("errors.generic", error.to_string())
}

fn format_obsidian_error(error: impl std::fmt::Display) -> LocalizedMessage {
    let detail = error.to_string();
    let key = if detail.contains("URI handler is unavailable") {
        "errors.obsidianUriHandlerUnavailable"
    } else {
        "errors.obsidianOpenFailed"
    };
    LocalizedMessage::with_detail(key, detail)
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
    let quota = Arc::new(QuotaRuntime::default());
    let storage = Arc::new(StorageRuntime::default());
    let conversations = Arc::new(ConversationRuntime::default());
    let refresh = Arc::new(RefreshCoordinator::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(lifecycle)
        .manage(hub)
        .manage(discovery)
        .manage(insights)
        .manage(quota)
        .manage(storage)
        .manage(conversations)
        .manage(refresh)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let theme = app.state::<Arc<LifecycleState>>().theme_preference();
            let app_icon = app.state::<Arc<LifecycleState>>().app_icon_preference();
            setup_quota_popover(app)?;
            apply_native_theme(app.handle(), theme)?;
            apply_application_icon(app.handle(), app_icon)?;
            #[cfg(target_os = "macos")]
            let _ = refresh_app_menu(app.handle());
            let tray_result = setup_tray(app);
            let tray_available = tray_result.is_ok();
            #[cfg(target_os = "linux")]
            let tray_available = tray_available && linux_tray_host_available();
            app.state::<Arc<LifecycleState>>()
                .set_tray_available(tray_available);
            #[cfg(not(target_os = "linux"))]
            tray_result?;
            #[cfg(target_os = "linux")]
            if let Err(error) = tray_result {
                eprintln!("AgentKib system tray is unavailable: {error}");
            }
            app.state::<Arc<HubController>>().start()?;
            seed_refresh_freshness(app.handle());
            start_refresh_schedulers(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| handle_app_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => handle_close_request(window, api),
                    WindowEvent::Focused(true) => {
                        let app = window.app_handle();
                        let coordinator = app.state::<Arc<RefreshCoordinator>>().inner().clone();
                        for (kind, minutes) in
                            [(RefreshKind::Discovery, 15), (RefreshKind::Insights, 30)]
                        {
                            coordinator.request_if_stale(
                                app.clone(),
                                kind,
                                chrono::Duration::minutes(minutes),
                            );
                        }
                        if remote_gateways_configured() {
                            coordinator.request_if_stale(
                                app.clone(),
                                RefreshKind::Gateways,
                                chrono::Duration::minutes(15),
                            );
                        }
                        request_quota_if_due(app);
                    }
                    _ => {}
                }
            } else if window.label() == "quota-popover"
                && matches!(event, WindowEvent::Focused(false))
            {
                let popover = window.clone();
                tauri::async_runtime::spawn(async move {
                    // A tray click blurs the popover before the tray Up event toggles it.
                    // Deferring the blur hide keeps a second left click from reopening it.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if !popover.is_focused().unwrap_or(false) {
                        let _ = popover.hide();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_workspace,
            prepare_manifest,
            validate_workspace,
            request_refresh,
            get_refresh_status,
            get_storage_overview,
            cancel_storage_scan,
            discover_workspaces,
            list_workspaces,
            get_workspace,
            get_workspace_git_summary,
            list_workspace_git_history,
            list_git_commit_files,
            get_git_diff,
            list_workspace_openers,
            open_workspace_with_app,
            list_workspace_sessions,
            refresh_workspace_sessions,
            read_session_events,
            get_workspace_session_status,
            clear_session_index,
            set_session_index_enabled,
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
            list_remote_gateways,
            save_remote_gateway,
            refresh_remote_gateway,
            remove_remote_gateway,
            search_catalog_assets,
            list_global_memories,
            list_activity,
            refresh_insights,
            get_insights_view,
            get_insights_summary,
            get_insights_heatmap,
            get_agent_usage_breakdown,
            get_model_usage_breakdown,
            get_workspace_usage_breakdown,
            get_repository_commit_breakdown,
            list_achievements,
            get_insights_status,
            get_quota_snapshot,
            refresh_quota,
            get_quota_collector_status,
            get_quota_popover_preferences,
            set_quota_popover_preferences,
            open_quota_dashboard,
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
            open_files_and_folders_settings,
            quit_app,
            set_close_behavior,
            set_locale,
            set_theme_preference,
            set_app_icon_preference,
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
        tauri::RunEvent::ExitRequested { api, .. } => {
            let lifecycle = app.state::<Arc<LifecycleState>>();
            if !lifecycle.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_guarded_exit(app);
            }
        }
        #[cfg(target_os = "macos")]
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
                app_icon_preference: AppIconPreference::Black,
                mcp_network: McpNetworkSettings::default(),
                quota_popover: QuotaPopoverPreferences {
                    hidden_providers: vec!["claude".into()],
                    hidden_windows: vec![QuotaWindowSelector {
                        provider_id: "codex".into(),
                        account_id: Some("work".into()),
                        kind: "weekly".into(),
                        label: "Weekly".into(),
                    }],
                },
                workspace_openers: WorkspaceOpenerPreferences::default(),
                session_index_enabled: false,
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
        assert_eq!(
            load_preferences(&path).unwrap().app_icon_preference,
            AppIconPreference::Black
        );
        assert_eq!(
            load_preferences(&path)
                .unwrap()
                .quota_popover
                .hidden_providers,
            ["claude"]
        );
        assert!(!load_preferences(&path).unwrap().session_index_enabled);
    }

    #[test]
    fn missing_preferences_asks_on_first_close() {
        let dir = tempdir().unwrap();
        let preferences = load_preferences(&dir.path().join("missing.json")).unwrap();
        assert_eq!(preferences.close_behavior, None);
        assert!(preferences.session_index_enabled);
    }

    #[test]
    fn workspace_opener_prefers_workspace_then_recent_then_file_manager() {
        let applications = vec![
            WorkspaceApplication {
                id: "finder".into(),
                name: "Finder".into(),
                category: WorkspaceApplicationCategory::FileManager,
            },
            WorkspaceApplication {
                id: "pycharm".into(),
                name: "PyCharm".into(),
                category: WorkspaceApplicationCategory::Editor,
            },
        ];
        let mut preferences = WorkspaceOpenerPreferences {
            global_recent: Some("pycharm".into()),
            by_workspace: BTreeMap::new(),
        };
        assert_eq!(
            preferred_opener(&applications, &preferences, "workspace").as_deref(),
            Some("pycharm")
        );
        preferences
            .by_workspace
            .insert("workspace".into(), "finder".into());
        assert_eq!(
            preferred_opener(&applications, &preferences, "workspace").as_deref(),
            Some("finder")
        );
        preferences
            .by_workspace
            .insert("workspace".into(), "removed-app".into());
        preferences.global_recent = Some("removed-app".into());
        assert_eq!(
            preferred_opener(&applications, &preferences, "workspace").as_deref(),
            Some("finder")
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
        assert_eq!(preferences.app_icon_preference, AppIconPreference::White);
        assert!(preferences.session_index_enabled);
        assert_eq!(
            preferences.quota_popover,
            QuotaPopoverPreferences::default()
        );
    }

    #[test]
    fn storage_scan_rejects_root_and_home_but_accepts_workspace() {
        let workspace = tempdir().unwrap();
        assert!(!storage_path_is_too_broad(workspace.path()));
        assert!(storage_path_is_too_broad(Path::new("/")));
        if let Some(home) = dirs::home_dir() {
            assert!(storage_path_is_too_broad(&home));
        }
    }

    #[test]
    fn quota_popover_preferences_drop_invalid_and_duplicate_selectors() {
        let valid = QuotaWindowSelector {
            provider_id: "codex".into(),
            account_id: None,
            kind: "weekly".into(),
            label: "Weekly".into(),
        };
        let mut preferences = QuotaPopoverPreferences {
            hidden_providers: vec!["codex".into(), "".into(), "codex".into()],
            hidden_windows: vec![
                valid.clone(),
                valid.clone(),
                QuotaWindowSelector {
                    provider_id: "codex".into(),
                    kind: "".into(),
                    label: "Broken".into(),
                    account_id: None,
                },
            ],
        };

        normalize_quota_popover_preferences(&mut preferences);

        assert_eq!(preferences.hidden_providers, ["codex"]);
        assert_eq!(preferences.hidden_windows, [valid]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quota_popover_position_stays_inside_the_active_monitor() {
        let position = quota_popover_position(
            -3820.0,
            0.0,
            24.0,
            24.0,
            Some((-3840.0, 0.0, 3840.0, 2160.0)),
            2.0,
        );

        assert_eq!(position.x, -3832);
        assert_eq!(position.y, 36);
    }

    #[test]
    fn theme_preferences_map_to_native_themes() {
        assert_eq!(ThemePreference::System.native(), None);
        assert_eq!(ThemePreference::Light.native(), Some(Theme::Light));
        assert_eq!(ThemePreference::Dark.native(), Some(Theme::Dark));
    }

    #[test]
    fn quota_reset_is_due_once_after_the_reset_window() {
        let now = Utc::now();
        let reset = now - chrono::Duration::minutes(2);
        let snapshot: QuotaSnapshot = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "backend": "codex-bar-cli",
            "generated_at": now,
            "fetched_at": now,
            "stale_after_seconds": 300,
            "freshness": "fresh",
            "providers": [{
                "id": "codex",
                "name": "Codex",
                "enabled": true,
                "windows": [{
                    "kind": "session",
                    "label": "5 hour",
                    "used_percent": 20.0,
                    "remaining_percent": 80.0,
                    "reset_at": reset
                }],
                "accounts": []
            }]
        }))
        .unwrap();
        assert!(quota_reset_due(
            &snapshot,
            Some(now - chrono::Duration::minutes(10)),
            now,
        ));
        assert!(!quota_reset_due(&snapshot, Some(now), now));
    }

    #[test]
    fn tray_refresh_labels_match_the_active_jobs() {
        assert_eq!(active_refresh_translation_key(&[]), None);
        assert_eq!(
            active_refresh_translation_key(&[RefreshKind::Discovery]),
            Some("tray.refreshDiscovery")
        );
        assert_eq!(
            active_refresh_translation_key(&[RefreshKind::Insights]),
            Some("tray.refreshInsights")
        );
        assert_eq!(
            active_refresh_translation_key(&[RefreshKind::Quota]),
            Some("tray.refreshQuota")
        );
        assert_eq!(
            active_refresh_translation_key(&[RefreshKind::Discovery, RefreshKind::Quota]),
            Some("tray.refreshMultiple")
        );
    }

    #[test]
    fn lifecycle_tracks_runtime_tray_capability() {
        let lifecycle = LifecycleState::new(&DesktopPreferences::default());
        assert!(!lifecycle.tray_available());
        lifecycle.set_tray_available(true);
        assert!(lifecycle.tray_available());
    }

    #[test]
    fn parses_status_notifier_watcher_response_strictly() {
        assert!(linux_tray_watcher_response(b"(true,)\n"));
        assert!(!linux_tray_watcher_response(b"(false,)\n"));
        assert!(!linux_tray_watcher_response(b"unexpected"));
    }
}
