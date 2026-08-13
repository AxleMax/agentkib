use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use agentkib_adapters::{HomeTargets, default_manifest, plan_workspace_changes};
use agentkib_core::{
    ActivityRecord, AgentInstallation, AgentKind, ApplyOptions, CatalogAsset, ChangeSet,
    ContextPreview, DiscoveryReport, ExcludedWorkspace, Manifest, MemoryProposal, MemoryRecord,
    MemoryStatus, ScanRoot, WorkspaceScan, WorkspaceSummary,
    apply_changeset as apply_core_changeset, load_manifest,
    resolve_context as resolve_core_context, scan_workspace as scan_core_workspace,
    validate_workspace as validate_core_workspace,
};
use agentkib_discovery::discover as discover_local_workspaces;
use agentkib_insights::{
    Achievement, AgentUsageBreakdown, GitIdentitySummary, HeatmapPoint, InsightsQuery,
    InsightsStatus, InsightsSummary, ModelUsageBreakdown, RepositoryCommitBreakdown,
    WorkspaceUsageBreakdown, collect_git, collect_usage,
};
use agentkib_store::{Store, default_backup_dir, default_data_dir};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

type CommandResult<T> = Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CloseBehavior {
    MinimizeToTray,
    Quit,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DesktopPreferences {
    close_behavior: Option<CloseBehavior>,
}

#[derive(Debug)]
struct LifecycleState {
    close_behavior: Mutex<Option<CloseBehavior>>,
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
    fn new(close_behavior: Option<CloseBehavior>) -> Self {
        Self {
            close_behavior: Mutex::new(close_behavior),
            close_prompt_open: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }

    fn close_behavior(&self) -> Option<CloseBehavior> {
        *self.close_behavior.lock().expect("关闭行为状态锁已损坏")
    }

    fn set_close_behavior(&self, value: Option<CloseBehavior>) {
        *self.close_behavior.lock().expect("关闭行为状态锁已损坏") = value;
    }
}

#[derive(Serialize)]
struct RuntimeInfo {
    data_dir: PathBuf,
    database_path: PathBuf,
    mcp_install_path: PathBuf,
    mcp_installed: bool,
    openclaw_config: Option<PathBuf>,
    hermes_config: Option<PathBuf>,
    close_behavior: Option<CloseBehavior>,
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
) -> CommandResult<ChangeSet> {
    ensure_agentkib_connection(Path::new(&project), &mut manifest).map_err(format_error)?;
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
    let approved_home_files: Vec<_> = [known_home.openclaw_config, known_home.hermes_config]
        .into_iter()
        .flatten()
        .collect();
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
    resolve_core_context(
        Path::new(&project),
        Path::new(&cwd),
        agent,
        manifest.as_ref(),
        memories,
    )
    .map_err(format_error)
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
fn runtime_info(state: tauri::State<'_, Arc<LifecycleState>>) -> CommandResult<RuntimeInfo> {
    let data_dir = default_data_dir().map_err(format_error)?;
    let mcp_install_path = data_dir.join("bin/agentkib-mcp");
    Ok(RuntimeInfo {
        database_path: data_dir.join("agentkib.db"),
        data_dir,
        mcp_installed: mcp_install_path.is_file(),
        mcp_install_path,
        openclaw_config: default_home_targets().openclaw_config,
        hermes_config: default_home_targets().hermes_config,
        close_behavior: state.close_behavior(),
    })
}

#[tauri::command]
fn set_close_behavior(
    behavior: Option<CloseBehavior>,
    state: tauri::State<'_, Arc<LifecycleState>>,
) -> CommandResult<()> {
    save_close_behavior(behavior).map_err(format_error)?;
    state.set_close_behavior(behavior);
    Ok(())
}

#[tauri::command]
fn install_mcp(app: AppHandle) -> CommandResult<PathBuf> {
    let source = locate_mcp_binary(&app)
        .ok_or_else(|| "找不到随应用构建的 agentkib-mcp，请先运行 build:mcp".to_string())?;
    let target = default_data_dir()
        .map_err(format_error)?
        .join("bin/agentkib-mcp");
    fs::create_dir_all(target.parent().expect("MCP 安装路径必须有父目录")).map_err(format_error)?;
    let temp = target.with_extension("tmp");
    fs::copy(source, &temp).map_err(format_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)).map_err(format_error)?;
    }
    fs::rename(temp, &target).map_err(format_error)?;
    Ok(target)
}

fn ensure_agentkib_connection(project: &Path, manifest: &mut Manifest) -> anyhow::Result<()> {
    let binary = default_data_dir()?.join("bin/agentkib-mcp");
    let definition = agentkib_core::ConnectionDefinition {
        name: "agentkib".into(),
        transport: agentkib_core::ConnectionTransport::Stdio {
            command: binary.display().to_string(),
            args: vec![
                "--project".into(),
                project.canonicalize()?.display().to_string(),
            ],
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
    Ok(())
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

fn locate_mcp_binary(app: &AppHandle) -> Option<PathBuf> {
    let executable_dir = app.path().executable_dir().ok()?;
    [
        executable_dir.join("agentkib-mcp"),
        executable_dir.join("../Resources/agentkib-mcp"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn preferences_path() -> anyhow::Result<PathBuf> {
    Ok(default_data_dir()?.join("preferences.json"))
}

fn load_close_behavior() -> Option<CloseBehavior> {
    let path = preferences_path().ok()?;
    load_preferences(&path).ok()?.close_behavior
}

fn load_preferences(path: &Path) -> anyhow::Result<DesktopPreferences> {
    if !path.is_file() {
        return Ok(DesktopPreferences::default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn save_close_behavior(behavior: Option<CloseBehavior>) -> anyhow::Result<()> {
    let path = preferences_path()?;
    save_preferences(
        &path,
        &DesktopPreferences {
            close_behavior: behavior,
        },
    )
}

fn save_preferences(path: &Path, preferences: &DesktopPreferences) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("偏好设置路径缺少父目录"))?;
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
    app.dialog()
        .message("AgentKib 可以隐藏到菜单栏并继续在后台运行。以后可在 Settings 中修改此行为。")
        .title("关闭 AgentKib")
        .parent(window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "最小化到菜单栏".into(),
            "退出 AgentKib".into(),
            "取消".into(),
        ))
        .show_with_result(move |result| {
            lifecycle.close_prompt_open.store(false, Ordering::SeqCst);
            match result {
                MessageDialogResult::Custom(label) if label == "最小化到菜单栏" => {
                    lifecycle.set_close_behavior(Some(CloseBehavior::MinimizeToTray));
                    let _ = save_close_behavior(Some(CloseBehavior::MinimizeToTray));
                    hide_to_tray(&app);
                }
                MessageDialogResult::Custom(label) if label == "退出 AgentKib" => {
                    lifecycle.set_close_behavior(Some(CloseBehavior::Quit));
                    let _ = save_close_behavior(Some(CloseBehavior::Quit));
                    request_real_exit(&app, &lifecycle);
                }
                _ => {}
            }
        });
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;

    let menu = MenuBuilder::new(app)
        .text("show", "打开 AgentKib")
        .text("status", "正在发现工作区…")
        .text("refresh", "立即刷新")
        .separator()
        .text("quit", "退出 AgentKib")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("agentkib-status")
        .menu(&menu)
        .tooltip("AgentKib · 本地 Agent 资产")
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
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn perform_discovery(app: &AppHandle, state: &DiscoveryRuntime) -> CommandResult<DiscoveryReport> {
    if state.running.swap(true, Ordering::SeqCst) {
        return state
            .last_report
            .lock()
            .expect("发现状态锁已损坏")
            .clone()
            .ok_or_else(|| "工作区发现正在运行".to_string());
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
            *state.last_report.lock().expect("发现状态锁已损坏") = Some(report.clone());
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
    let menu = MenuBuilder::new(app)
        .text("show", "打开 AgentKib")
        .text(
            "status",
            format!("{} 个工作区 · {} 项待处理", workspaces.len(), attention),
        )
        .text("refresh", "立即刷新")
        .separator()
        .text("quit", "退出 AgentKib")
        .build()?;
    if let Some(tray) = app.tray_by_id("agentkib-status") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn perform_insights(app: &AppHandle, state: &InsightsRuntime) -> CommandResult<InsightsSummary> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("成就统计正在刷新".to_string());
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

fn format_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let lifecycle = Arc::new(LifecycleState::new(load_close_behavior()));
    let discovery = Arc::new(DiscoveryRuntime::default());
    let insights = Arc::new(InsightsRuntime::default());
    let app = tauri::Builder::default()
        .manage(lifecycle)
        .manage(discovery)
        .manage(insights)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            setup_tray(app)?;
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
            install_mcp
        ])
        .build(tauri::generate_context!())
        .expect("构建 AgentKib 失败");
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
            },
        )
        .unwrap();
        assert_eq!(
            load_preferences(&path).unwrap().close_behavior,
            Some(CloseBehavior::MinimizeToTray)
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
}
