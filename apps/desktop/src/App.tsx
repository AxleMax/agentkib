import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, Award, Bot, Boxes, Brain, Check, ChevronRight, CircleAlert, Code2, Copy, ExternalLink, FileCode2, FolderGit2, Gauge, GitCommitHorizontal, GitCompareArrows, History, Home, LayoutDashboard, Library, MessageSquareText, MoreHorizontal, Pencil, PlugZap, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { api } from "./api";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./components/AgentIcon";
import { AppSidebar, type SidebarEntry } from "./components/AppSidebar";
import { SettingsSidebar, settingsSectionLabel, type SettingsSection } from "./components/SettingsSidebar";
import { WindowToolbar } from "./components/WindowToolbar";
import { ObsidianSettingsCard, WorkspaceObsidianCard } from "./components/ObsidianIntegration";
import { RemoteGatewaysSettings } from "./components/RemoteGateways";
import { QuotaDiagnostics } from "./components/QuotaDiagnostics";
import { WorkspaceStoragePage } from "./components/WorkspaceStoragePage";
import { WorkspaceSessionsPage } from "./components/WorkspaceSessionsPage";
import { WorkspaceDoctorPage } from "./components/WorkspaceDoctorPage";
import { WorkspaceGitPage, type GitSubview } from "./components/WorkspaceGitPage";
import { WorkspaceOpenWith } from "./components/WorkspaceOpenWith";
import { useAppDialogs } from "./components/AppDialogProvider";
import type { InsightsSection } from "./components/InsightsPage";
import { groupCatalogAssets, groupWorkspaceAssets, workspaceAssetCounts, type CatalogAssetGroup } from "./catalog";
import { diffLines } from "./diff";
import { changeLocale, formatCompactNumber, formatDateTime, formatRelativeTime, localizeMessage, tr } from "./i18n";
import { applyTheme } from "./theme";
import { normalizePlatform, primaryShortcutModifier, usesSystemTrayWording } from "./platform";
import type { ActivityRecord, AgentInstallation, AgentKind, AppIconPreference, AppMenuCommandRequest, AppNavigationRequest, CatalogAsset, ChangeSet, CloseBehavior, ConnectionDefinition, ContextDoctorSummary, ContextPreview, DiscoveryReport, EffectiveTheme, ExcludedWorkspace, GitIdentitySummary, InsightsStatus, InsightsSummary, LocalePreference, Manifest, McpInstallation, McpRegistryEntry, McpRuntimeStatus, McpServerConfig, MemoryRecord, MemoryType, QuotaCollectorStatus, QuotaWindowSelector, RefreshJobStatus, RefreshKind, RemoteGatewaySummary, RuntimeInfo, ScanRoot, SessionHandoffLaunchRequest, ThemePreference, WorkspaceScan, WorkspaceSummary } from "./types";

type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
type AppMode = "main" | "settings";
type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
type WorkspaceAssetSection = "instructions" | "skills" | "mcp" | "native";
type WorkspaceView = "list" | "storage";
type ChangeSetOrigin = "standard" | "doctor" | "handoff";

const AgentsPageLazy = lazy(() => import("./components/AgentsPage").then(({ AgentsPage }) => ({ default: AgentsPage })));
const InsightsPageLazy = lazy(() => import("./components/InsightsPage").then(({ InsightsPage }) => ({ default: InsightsPage })));
const QuotaPageLazy = lazy(() => import("./components/QuotaPage").then(({ QuotaPage }) => ({ default: QuotaPage })));
const buildPlatform = import.meta.env.TAURI_ENV_PLATFORM;
const appPlatform = normalizePlatform(buildPlatform);
const hasFileAccessSettings = ["macos", "windows"].includes(appPlatform);

const agentLabels: Record<AgentKind, string> = { codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", "open-claw": "OpenClaw", hermes: "Hermes", "deepseek-harness": "DeepSeek Harness" };
const writableAgentKinds: AgentKind[] = ["codex", "claude-code", "cursor", "open-claw", "hermes"];
const workspaceTabs = [
  ["overview", "nav.overview", LayoutDashboard], ["sessions", "nav.sessions", MessageSquareText], ["git", "nav.git", GitCommitHorizontal], ["assets", "nav.assets", Boxes],
  ["context", "nav.context", Code2], ["doctor", "nav.doctor", ShieldCheck], ["changes", "nav.changes", GitCompareArrows],
] as const;
const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "workspaces", label: "nav.workspaces", icon: FolderGit2 },
  { id: "catalog", label: "nav.assets", icon: Library },
  { id: "agents", label: "nav.agents", icon: Bot },
  { id: "quota", label: "nav.quota", icon: Gauge },
  { id: "insights", label: "nav.insights", icon: Award },
];

export function App() {
  useTranslation();
  const dialogs = useAppDialogs();
  const [page, setPage] = useState<Page>("overview"); const [globalPage, setGlobalPage] = useState<GlobalPage>("home");
  const [gitSubview, setGitSubview] = useState<GitSubview>();
  const [appMode, setAppMode] = useState<AppMode>("main");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("agentkib.sidebar.collapsed") === "true");
  const [project, setProject] = useState(""); const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSummary>();
  const selectedWorkspaceRef = useRef<{ id: string; path: string } | undefined>(undefined);
  selectedWorkspaceRef.current = selectedWorkspace ? { id: selectedWorkspace.id, path: selectedWorkspace.path } : undefined;
  const [scan, setScan] = useState<WorkspaceScan>();
  const [manifest, setManifest] = useState<Manifest>();
  const [changeSet, setChangeSet] = useState<ChangeSet>();
  const [changeSetOrigin, setChangeSetOrigin] = useState<ChangeSetOrigin>("standard");
  const [handoffLaunchRequest, setHandoffLaunchRequest] = useState<SessionHandoffLaunchRequest>();
  const [baselineManifest, setBaselineManifest] = useState("");
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, Manifest>>({});
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]); const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [doctorSummaries, setDoctorSummaries] = useState<Record<string, ContextDoctorSummary>>({});
  const [catalog, setCatalog] = useState<CatalogAsset[]>([]); const [globalMemories, setGlobalMemories] = useState<MemoryRecord[]>([]); const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [scanRoots, setScanRoots] = useState<ScanRoot[]>([]); const [excluded, setExcluded] = useState<ExcludedWorkspace[]>([]); const [discovery, setDiscovery] = useState<DiscoveryReport>();
  const [remoteGateways, setRemoteGateways] = useState<RemoteGatewaySummary[]>([]);
  const [insightsSummary, setInsightsSummary] = useState<InsightsSummary>();
  const [insightsStatus, setInsightsStatus] = useState<InsightsStatus>();
  const [quotaStatus, setQuotaStatus] = useState<QuotaCollectorStatus>();
  const [quotaProvider, setQuotaProvider] = useState<string>();
  const [quotaWindow, setQuotaWindow] = useState<QuotaWindowSelector>();
  const [quotaConfigureRequest, setQuotaConfigureRequest] = useState(0);
  const [navigationRequest, setNavigationRequest] = useState<AppNavigationRequest>();
  const [menuCommand, setMenuCommand] = useState<AppMenuCommandRequest>();
  const [refreshJobs, setRefreshJobs] = useState<RefreshJobStatus[]>([]);
  const [assetSection, setAssetSection] = useState<AssetSection>("instructions");
  const [workspaceAssetSection, setWorkspaceAssetSection] = useState<WorkspaceAssetSection>("instructions");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("list");
  const [insightsSection, setInsightsSection] = useState<InsightsSection>("overview");
  const pendingRefreshKinds = useRef(new Set<string>());
  const quitPromptOpen = useRef(false);
  const groupedCatalog = useMemo(() => groupCatalogAssets(catalog), [catalog]);
  const assetCounts = useMemo(() => workspaceAssetCounts(groupedCatalog), [groupedCatalog]);

  const load = async (path = project, draft?: Manifest) => {
    if (!path) return;
    setBusy(true); setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([api.scan(path), api.manifest(path), api.runtime()]);
      setProject(path); setScan(nextScan); setManifest(draft ?? nextManifest); setBaselineManifest(JSON.stringify(nextManifest)); setRuntime(nextRuntime);
    } catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };

  const loadGlobal = async () => {
    const [nextWorkspaces, nextInstallations, nextCatalog, nextMemories, nextActivity, nextRoots, nextExcluded, nextRuntime, nextRemoteGateways] = await Promise.all([
      api.workspaces(), api.agentInstallations(), api.catalogAssets(), api.globalMemories(), api.activity(), api.scanRoots(), api.excludedWorkspaces(), api.runtime(), api.remoteGateways(),
    ]);
    setWorkspaces(nextWorkspaces); setInstallations(nextInstallations); setCatalog(nextCatalog); setGlobalMemories(nextMemories); setActivity(nextActivity); setScanRoots(nextRoots); setExcluded(nextExcluded); setRuntime(nextRuntime); setRemoteGateways(nextRemoteGateways);
    try {
      const summaries = await api.workspaceDoctorSummaries(nextWorkspaces.map((workspace) => workspace.id));
      setDoctorSummaries(Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary])));
    } catch { setDoctorSummaries({}); }
    try {
      const [summary, status] = await Promise.all([api.insightsSummary(), api.insightsStatus()]);
      setInsightsSummary(summary); setInsightsStatus(status);
    } catch { /* 首次迁移或后台采集尚未完成时显示空状态。 */ }
    try { setQuotaStatus(await api.quotaCollectorStatus()); } catch { /* Sidecar 尚未准备时由诊断页展示不可用状态。 */ }
  };

  const loadDiscoveryCache = async () => {
    const [nextWorkspaces, nextInstallations, nextCatalog] = await Promise.all([
      api.workspaces(), api.agentInstallations(), api.catalogAssets(),
    ]);
    setWorkspaces(nextWorkspaces);
    setInstallations(nextInstallations);
    setCatalog(nextCatalog);
    try {
      const summaries = await api.workspaceDoctorSummaries(nextWorkspaces.map((workspace) => workspace.id));
      setDoctorSummaries(Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary])));
    } catch { setDoctorSummaries({}); }
  };

  useEffect(() => {
    let disposed = false; let refreshReloadTimer: number | undefined; let unlisten: (() => void) | undefined; let unlistenRefresh: (() => void) | undefined; let unlistenInsights: (() => void) | undefined; let unlistenGateways: (() => void) | undefined; let unlistenQuota: (() => void) | undefined; let unlistenNavigate: (() => void) | undefined; let unlistenMenuCommand: (() => void) | undefined; let unlistenTheme: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<DiscoveryReport>("agentkib:discovery-updated", (event) => { setDiscovery(event.payload); });
        unlistenRefresh = await listen<RefreshJobStatus>("agentkib:refresh-state", (event) => {
          setRefreshJobs((current) => [...current.filter((job) => job.kind !== event.payload.kind), event.payload]);
          if (event.payload.kind === "discovery" && event.payload.state === "succeeded") {
            if (document.visibilityState !== "visible") {
              pendingRefreshKinds.current.add("discovery");
              return;
            }
            window.clearTimeout(refreshReloadTimer);
            refreshReloadTimer = window.setTimeout(() => { if (!disposed) void loadDiscoveryCache(); }, 100);
          }
        });
        unlistenInsights = await listen<InsightsSummary>("agentkib:insights-updated", (event) => { setInsightsSummary(event.payload); });
        unlistenGateways = await listen<RemoteGatewaySummary[]>("agentkib:remote-gateways-updated", (event) => { setRemoteGateways(event.payload); });
        unlistenQuota = await listen("agentkib:quota-updated", () => { void api.quotaCollectorStatus().then(setQuotaStatus); });
        unlistenNavigate = await listen<AppNavigationRequest>("agentkib:navigate", (event) => { setNavigationRequest(event.payload); });
        unlistenMenuCommand = await listen<AppMenuCommandRequest>("agentkib:app-command", (event) => { setMenuCommand(event.payload); });
        unlistenTheme = await listen<EffectiveTheme>("tauri://theme-changed", (event) => {
          setRuntime((current) => {
            if (!current || current.theme_preference !== "system") return current;
            applyTheme(event.payload);
            return { ...current, effective_theme: event.payload };
          });
        });
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          await api.addWorkspace(legacy);
          localStorage.removeItem("agentkib.project");
        }
        await loadGlobal();
        if (!disposed) setRefreshJobs(await api.refreshStatus());
      } catch (error) { if (!disposed) setMessage(localizeMessage(error)); }
    })();
    return () => { disposed = true; window.clearTimeout(refreshReloadTimer); unlisten?.(); unlistenRefresh?.(); unlistenInsights?.(); unlistenGateways?.(); unlistenQuota?.(); unlistenNavigate?.(); unlistenMenuCommand?.(); unlistenTheme?.(); };
  }, []);
  useEffect(() => { localStorage.setItem("agentkib.sidebar.collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => {
    const refreshRuntime = () => {
      if (pendingRefreshKinds.current.delete("discovery")) void loadDiscoveryCache();
      void api.runtime().then(async (nextRuntime) => { setRuntime(nextRuntime); applyTheme(nextRuntime.effective_theme); await changeLocale(nextRuntime.effective_locale); }).catch(() => undefined);
    };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, []);

  const selectProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: tr("dialog.addWorkspace") });
    if (typeof selected === "string") { const workspace = await api.addWorkspace(selected); await loadGlobal(); await openWorkspace(workspace); }
  };

  const hasUnsavedDraft = Boolean(manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest);
  const hasAnyUnsavedDraft = hasUnsavedDraft || Object.keys(workspaceDrafts).length > 0;
  const [applyingChanges, setApplyingChanges] = useState(false);
  const quitState = useRef({ hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges });
  quitState.current = { hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("agentkib:quit-requested", async () => {
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      try {
        if (quitState.current.applyingChanges) {
          await dialogs.notify(tr("dialog.quit.changesApplying"));
          return;
        }
        if (quitState.current.hasUnsavedDraft && !await dialogs.confirm({ description: tr("dialog.quit.discardDraft"), tone: "destructive" })) return;
        await api.quitApp();
      } finally {
        quitPromptOpen.current = false;
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => { disposed = true; unlisten?.(); };
  }, [dialogs]);
  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.page === "settings") {
      setSettingsSection(navigationRequest.settings_section ?? "general");
      setAppMode("settings");
      setNavigationRequest(undefined);
      return;
    }
    if (navigationRequest.page === "quota") {
      setQuotaProvider(navigationRequest.provider);
      setQuotaWindow(navigationRequest.window);
      if (navigationRequest.configure_popover) setQuotaConfigureRequest((value) => value + 1);
    }
    navigateGlobal(navigationRequest.page, navigationRequest.page === "quota");
    setAppMode("main");
    setNavigationRequest(undefined);
  }, [navigationRequest]);
  const persistWorkspaceDraft = () => {
    if (selectedWorkspace && manifest && hasUnsavedDraft) setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
  };
  const leaveWorkspace = async (next: () => void) => {
    if (hasUnsavedDraft && !await dialogs.confirm({ description: tr("workspace.leaveDraftConfirm"), tone: "destructive" })) return;
    if (selectedWorkspace) setWorkspaceDrafts((drafts) => { const nextDrafts = { ...drafts }; delete nextDrafts[selectedWorkspace.id]; return nextDrafts; });
    setGitSubview(undefined); setSelectedWorkspace(undefined); setProject(""); setScan(undefined); setManifest(undefined); setChangeSet(undefined); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setBaselineManifest(""); next();
  };
  const openWorkspace = async (workspace: WorkspaceSummary, initialPage: Page = "overview") => {
    persistWorkspaceDraft(); setBusy(true); setMessage("");
    try {
      const [nextScan, nextRuntime] = await Promise.all([api.scan(workspace.path), api.runtime()]);
      let nextManifest: Manifest | undefined;
      try { nextManifest = await api.manifest(workspace.path); }
      catch (error) { setMessage(localizeMessage(error)); }
      setPage(nextManifest ? initialPage : "doctor"); setGitSubview(undefined); setChangeSet(undefined); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setProject(workspace.path); setScan(nextScan);
      setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined); setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : ""); setRuntime(nextRuntime);
      // Commit the route last so the workspace list remains visible while native scanning runs.
      setSelectedWorkspace(workspace);
    } catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };
  const closeWorkspace = () => void leaveWorkspace(() => setGlobalPage("workspaces"));
  const navigateGlobal = (nextPage: GlobalPage, preserveQuotaSelection = false) => {
    if (nextPage === "quota" && !preserveQuotaSelection) { setQuotaProvider(undefined); setQuotaWindow(undefined); }
    selectedWorkspace ? void leaveWorkspace(() => setGlobalPage(nextPage)) : setGlobalPage(nextPage);
  };
  const openSettings = () => setAppMode("settings");

  const plan = async (includeHome = false) => {
    if (!project || !manifest) return;
    setBusy(true); setMessage("");
    try { const changes = await api.plan(project, manifest, includeHome); setChangeSet(changes); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setPage("changes"); }
    catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };
  const planDoctorRepairs = async () => {
    const workspaceId = selectedWorkspace?.id;
    const workspacePath = project;
    if (!workspaceId || !workspacePath) return;
    const isCurrentWorkspace = () => selectedWorkspaceRef.current?.id === workspaceId
      && selectedWorkspaceRef.current.path === workspacePath;
    const currentManifest = await api.manifest(workspacePath);
    if (!isCurrentWorkspace()) return;
    const changes = await api.plan(workspacePath, currentManifest, false);
    if (!isCurrentWorkspace()) return;
    setChangeSet(changes);
    setChangeSetOrigin("doctor");
    setHandoffLaunchRequest(undefined);
    setPage("changes");
  };
  const refreshDiscovery = async () => { setMessage(""); try { await api.requestRefresh("discovery", true); } catch (error) { setMessage(localizeMessage(error)); } };
  const requestRefreshKinds = async (kinds: RefreshKind[]) => {
    setMessage("");
    try { await Promise.all(kinds.map((kind) => api.requestRefresh(kind, true))); }
    catch (error) { setMessage(localizeMessage(error)); }
  };
  const refreshCurrentView = async () => {
    if (selectedWorkspace && project && manifest) {
      await load(project, manifest);
      return;
    }
    if (appMode === "settings") {
      if (settingsSection === "discovery") await requestRefreshKinds(["discovery"]);
      else if (settingsSection === "integrations") await requestRefreshKinds(["gateways"]);
      else if (settingsSection === "diagnostics") await requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      else await loadGlobal();
      return;
    }
    if (globalPage === "quota") await requestRefreshKinds(["quota"]);
    else if (globalPage === "insights") await requestRefreshKinds(["insights"]);
    else await requestRefreshKinds(["discovery"]);
  };
  useEffect(() => {
    if (!menuCommand) return;
    setMenuCommand(undefined);
    if (menuCommand.command === "add-workspace") void selectProject();
    else if (menuCommand.command === "add-scan-root") void addScanRootFromDialog();
    else if (menuCommand.command === "toggle-sidebar") setSidebarCollapsed((value) => !value);
    else if (menuCommand.command === "refresh-current") void refreshCurrentView();
    else if (menuCommand.command === "refresh-all") void dialogs.confirm(tr("menu.refreshAllConfirm")).then((confirmed) => {
      if (confirmed) void requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
    });
  }, [dialogs, menuCommand]);
  const discoveryRefreshing = refreshJobs.some((job) => job.kind === "discovery" && (job.state === "queued" || job.state === "running"));

  const navigation = globalNav.map((entry) => entry.id === "catalog" ? { ...entry, badge: globalMemories.filter((item) => item.status === "pending").length } : entry);
  const shellClass = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden !grid-cols-[var(--sidebar-width)_minmax(0,1fr)] !grid-rows-[minmax(0,1fr)] !transition-[grid-template-columns] !duration-150",
    sidebarCollapsed && "sidebar-collapsed !grid-cols-[0_minmax(0,1fr)]",
  );
  const mainClass = "!col-start-2 !row-start-1 !min-h-0 !min-w-0 !h-full !overflow-x-hidden !overflow-y-auto !overscroll-contain";
  const pageHeaderClass = cn(
    "page-header !sticky !top-0 !z-10 !flex !min-h-[58px] !h-[58px] !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
    sidebarCollapsed ? "!pl-[132px]" : "!pl-7",
  );
  const pageTitleClass = "page-title-row !flex !min-w-0 !items-center !gap-2.5";
  const headerActionsClass = "header-actions !flex !items-center !gap-[9px]";
  const contentClass = "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";
  if (appMode === "settings") return (
    <div className={`${shellClass} settings-shell`}>
      <WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <SettingsSidebar active={settingsSection} collapsed={sidebarCollapsed} onSelect={setSettingsSection} onBack={() => setAppMode("main")} />
      {!sidebarCollapsed && <Button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main className={mainClass}>
        <header className={pageHeaderClass} data-tauri-drag-region>
          <div className={pageTitleClass}><h1 className="!m-0 !text-[23px] !leading-none" data-tauri-drag-region>{settingsSectionLabel(settingsSection)}</h1></div>
        </header>
        {message && <div className="alert"><CircleAlert size={17} />{message}</div>}
        <section className={`${contentClass} settings-content${settingsSection === "general" ? " compact" : ""}`}>
          <GlobalSettings section={settingsSection} runtime={runtime} workspaces={workspaces} discovery={discovery} insightsStatus={insightsStatus} quotaStatus={quotaStatus} remoteGateways={remoteGateways} scanRoots={scanRoots} excluded={excluded} activity={activity} onAddRoot={addScanRootFromDialog} onRemoveRoot={async (id) => { await api.removeScanRoot(id); await loadGlobal(); await refreshDiscovery(); }} onRestore={async (path) => { await api.restoreExcludedWorkspace(path); await loadGlobal(); await refreshDiscovery(); }} onCloseBehaviorChanged={async (behavior) => { await api.setCloseBehavior(behavior); await loadGlobal(); }} onLocaleChanged={setRuntime} onRemoteGatewaysChanged={loadGlobal} />
        </section>
      </main>
    </div>
  );
  if (selectedWorkspace && project && scan) return (
    <div className={shellClass}>
      <WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <AppSidebar active="workspaces" entries={navigation} collapsed={sidebarCollapsed} onNavigate={navigateGlobal} onSettings={openSettings} />
      {!sidebarCollapsed && <Button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main className={cn(mainClass, page === "git" && "workspace-git-main")}>
        <header className={cn(pageHeaderClass, "workspace-header !h-[104px] !min-h-[104px]")} data-tauri-drag-region><div className={pageTitleClass}><Button className="breadcrumb" onClick={closeWorkspace}>{tr("nav.workspaces")}</Button><span className="breadcrumb-separator" data-tauri-drag-region>/</span><h1 className="!m-0 !text-[23px] !leading-none" data-tauri-drag-region>{selectedWorkspace.name}</h1>{page === "git" && gitSubview && <><span className="breadcrumb-separator" data-tauri-drag-region>/</span><Button className="breadcrumb" onClick={() => setGitSubview(undefined)}>{tr("nav.git")}</Button><span className="breadcrumb-separator" data-tauri-drag-region>/</span><span className="breadcrumb-current" data-tauri-drag-region>{gitSubview.kind === "commit" ? tr("git.commitBreadcrumb", { oid: gitSubview.oid.slice(0, 7) }) : tr("git.worktreeDetail")}</span></>}</div><div className={headerActionsClass}>{selectedWorkspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}<WorkspaceOpenWith workspace={selectedWorkspace} onError={setMessage} /><DropdownMenu><DropdownMenuTrigger className="row-menu-trigger header-menu" title={tr("common.moreActions")} aria-label={tr("common.moreActions")}><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(selectedWorkspace.path)}><Copy size={13} />{tr("workspace.copyPath")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button className="ghost icon-only" title={tr("common.scan")} aria-label={tr("common.scan")} onClick={() => load(project, manifest)} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} /></Button><Button className="primary" onClick={() => plan(false)} disabled={busy || !hasUnsavedDraft}><GitCompareArrows size={15} />{tr("workspace.reviewChanges")}</Button></div></header>
        {message && <div className="alert"><CircleAlert size={17} />{message}</div>}
        <Tabs value={page} onValueChange={(id) => { if (id !== "git") setGitSubview(undefined); setPage(id as Page); }}><TabsList className="workspace-tabs" variant="line" aria-label={selectedWorkspace.name}>{workspaceTabs.map(([id, label, Icon]) => <TabsTrigger key={id} value={id}><Icon size={15} />{tr(label)}{id === "changes" && changeSet?.changes.length ? <em>{changeSet.changes.length}</em> : null}</TabsTrigger>)}</TabsList></Tabs>
        <section className={`${contentClass} workspace-content${page === "git" ? " workspace-git-content" : ""}`}>
          {page === "overview" && manifest && <Overview workspace={selectedWorkspace} scan={scan} manifest={manifest} />}
          {page === "sessions" && <WorkspaceSessionsPage workspace={selectedWorkspace} enabled={runtime?.session_index_enabled !== false} targetAgents={Array.from(new Set([...scan.agents.filter((agent) => agent.detected).map((agent) => agent.agent), ...installations.filter((agent) => agent.installed).map((agent) => agent.agent)]))} onRuntimeChanged={async (enabled) => { setRuntime(await api.setSessionIndexEnabled(enabled)); }} onHandoffPlanned={(planned) => { setChangeSet(planned.change_set); setHandoffLaunchRequest(planned.launch_request); setChangeSetOrigin("handoff"); setPage("changes"); }} />}
          {page === "git" && <WorkspaceGitPage workspace={selectedWorkspace} subview={gitSubview} onSubviewChange={setGitSubview} />}
          {page === "assets" && manifest && <Assets section={workspaceAssetSection} onSection={setWorkspaceAssetSection} scan={scan} manifest={manifest} onChange={setManifest} />}
          {page === "context" && <ContextPage project={project} onOpenInstructions={() => { setWorkspaceAssetSection("instructions"); setPage("assets"); }} />}
          {page === "doctor" && <WorkspaceDoctorPage workspace={selectedWorkspace} onRepair={planDoctorRepairs} />}
          {page === "changes" && <Changes changeSet={changeSet} origin={changeSetOrigin} launchRequest={handoffLaunchRequest} onPlanHome={() => plan(true)} onApplied={async (keepLaunchRequest) => { setChangeSet(undefined); if (!keepLaunchRequest) setHandoffLaunchRequest(undefined); await load(); await loadGlobal(); }} onLaunchCompleted={() => setHandoffLaunchRequest(undefined)} onRejected={() => { setChangeSet(undefined); setHandoffLaunchRequest(undefined); }} onApplyingChange={setApplyingChanges} />}
        </section>
      </main>
    </div>
  );

  const discoveryFailure = refreshJobs.find((job) => job.kind === "discovery" && job.state === "failed");
  const headerAction = globalPage === "workspaces" ? <><ToggleGroup className="theme-segments workspace-view-switch" value={[workspaceView]} onValueChange={(values) => { const value = values[0]; if (value === "list" || value === "storage") setWorkspaceView(value); }} aria-label={tr("workspace.viewLabel")}><ToggleGroupItem value="list" className={workspaceView === "list" ? "active" : ""}>{tr("workspace.view.list")}</ToggleGroupItem><ToggleGroupItem value="storage" className={workspaceView === "storage" ? "active" : ""}>{tr("workspace.view.storage")}</ToggleGroupItem></ToggleGroup>{workspaceView === "list" && <Button className="primary" onClick={() => void selectProject()}><FolderGit2 size={15} />{tr("workspace.addManually")}</Button>}</> : null;
  return <div className={`${shellClass} global-shell`}><WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} /><AppSidebar active={globalPage} entries={navigation} collapsed={sidebarCollapsed} onNavigate={navigateGlobal} onSettings={openSettings} />{!sidebarCollapsed && <Button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}<main className={mainClass}><header className={pageHeaderClass} data-tauri-drag-region><div className={pageTitleClass}><h1 className="!m-0 !text-[23px] !leading-none" data-tauri-drag-region>{tr(globalNav.find(({ id }) => id === globalPage)?.label ?? "nav.home")}</h1></div><div className={headerActionsClass}>{headerAction}</div></header>{message && <div className="alert"><CircleAlert size={17} />{message}</div>}{globalPage === "workspaces" && discoveryFailure?.error && <div className="alert"><CircleAlert size={17} />{discoveryFailure.error}</div>}<section className={`${contentClass} global-content`}>
    {globalPage === "home" && <GlobalHome workspaces={workspaces} doctorSummaries={doctorSummaries} installations={installations} memories={globalMemories} discovery={discovery} activity={activity} insights={insightsSummary} uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length} assetCounts={assetCounts} onShowInsights={() => setGlobalPage("insights")} onShowWorkspaces={() => setGlobalPage("workspaces")} onShowAgents={() => setGlobalPage("agents")} onOpen={openWorkspace} onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")} onOpenAssets={(section) => { setAssetSection(section); setGlobalPage("catalog"); }} onAddRoot={async () => { await addScanRootFromDialog(); }} />}
    {globalPage === "workspaces" && <WorkspacesPage view={workspaceView} storageJob={refreshJobs.find((job) => job.kind === "storage")} workspaces={workspaces} assetCounts={assetCounts} discoveryRefreshing={discoveryRefreshing} onOpen={openWorkspace} onRefreshDiscovery={refreshDiscovery} onRefreshWorkspace={async (id) => { await api.refreshWorkspace(id); await loadGlobal(); }} onExclude={async (id) => { if (!await dialogs.confirm({ description: tr("workspace.ignoreConfirm"), tone: "destructive" })) return; await api.excludeWorkspace(id); await loadGlobal(); }} />}
    {globalPage === "agents" && <DeferredPage><AgentsPageLazy installations={installations} assets={catalog.filter((asset) => asset.scope === "agent-home")} workspaces={workspaces} remoteGateways={remoteGateways} insightsStatus={insightsStatus} onOpen={openWorkspace} /></DeferredPage>}
    {globalPage === "catalog" && <GlobalAssetsPage section={assetSection} onSection={setAssetSection} assets={catalog} workspaces={workspaces} memories={globalMemories} runtime={runtime} onReload={loadGlobal} onRuntimeChanged={setRuntime} onOpen={(id) => { const workspace = workspaces.find((item) => item.id === id); if (workspace) void openWorkspace(workspace); }} onMigrationPlanned={async (workspacePath, planned) => { const workspace = workspaces.find((item) => item.path === workspacePath); if (!workspace) return; await openWorkspace(workspace); setChangeSet(planned); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setPage("changes"); }} />}
    {globalPage === "quota" && <DeferredPage><QuotaPageLazy initialProvider={quotaProvider} initialWindow={quotaWindow} configurePopoverRequest={quotaConfigureRequest} /></DeferredPage>}
    {globalPage === "insights" && <div className="insights-host" data-view={insightsSection}><Tabs value={insightsSection} onValueChange={(section) => setInsightsSection(section as InsightsSection)}><TabsList className="section-tabs insights-section-tabs" variant="line" aria-label={tr("nav.insights")}>{(["overview", "tokens", "commits", "milestones", "sources"] as InsightsSection[]).map((section) => <TabsTrigger key={section} value={section}>{tr(`insights.section.${section}`)}</TabsTrigger>)}</TabsList></Tabs><DeferredPage><InsightsPageLazy section={insightsSection} workspaces={workspaces} onSummary={setInsightsSummary} /></DeferredPage></div>}
  </section></main></div>;

  async function addScanRootFromDialog() { const selected = await open({ directory: true, multiple: false, title: tr("dialog.addScanRoot") }); if (typeof selected === "string") { await api.addScanRoot(selected, 5); await loadGlobal(); await refreshDiscovery(); } }
}

function DeferredPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="panel"><p>{tr("common.loading")}</p></div>}>{children}</Suspense>;
}

function GlobalHome({ workspaces, doctorSummaries, installations, memories, discovery, activity, insights, uniqueAssetCount, assetCounts, onShowInsights, onShowWorkspaces, onShowAgents, onOpen, onOpenDoctor, onOpenAssets, onAddRoot }: { workspaces: WorkspaceSummary[]; doctorSummaries: Record<string, ContextDoctorSummary>; installations: AgentInstallation[]; memories: MemoryRecord[]; discovery?: DiscoveryReport; activity: ActivityRecord[]; insights?: InsightsSummary; uniqueAssetCount: number; assetCounts: Map<string, number>; onShowInsights: () => void; onShowWorkspaces: () => void; onShowAgents: () => void; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>; onOpenAssets: (section: AssetSection) => void; onAddRoot: () => Promise<void> }) {
  const attention = workspaces.filter((item) => item.status === "attention" || (doctorSummaries[item.id]?.error_count ?? 0) + (doctorSummaries[item.id]?.warning_count ?? 0) > 0);
  const pending = memories.filter((item) => item.status === "pending").length;
  const doctorIssueCount = Object.values(doctorSummaries).reduce((total, summary) => total + summary.error_count + summary.warning_count, 0);
  const legacyAttentionCount = attention.filter((workspace) => !doctorSummaries[workspace.id]).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const importantActions = new Set(["changeset.apply", "changeset.apply_failed", "memory.propose", "memory.review", "workspace.exclude"]);
  const importantActivity = activity.filter((item) => importantActions.has(item.action)).slice(0, 5);
  const insightCard = insights && <Button variant="bare" size="content" className="panel home-achievement" onClick={onShowInsights}><div className="achievement-orb"><Award size={21} /></div><div><span>{tr("home.journey")}</span>{insights.total_tokens || insights.my_commits ? <div className="home-achievement-values"><strong>{formatCompact(insights.total_tokens)} Token</strong><strong>{insights.my_commits} {tr("insights.myCommits")}</strong></div> : <h2>{tr("home.insightsEmpty")}</h2>}<p>{tr("home.streak", { active: insights.active_days, current: insights.current_streak, longest: insights.longest_streak })}</p></div><ChevronRight size={16} /></Button>;
  return <div className="stack home-dashboard">
    {issueCount > 0 ? <section className="attention-panel has-issues"><div className="attention-heading"><span><CircleAlert size={18} /><strong>{tr("home.needsAttention")}</strong></span><em>{issueCount}</em></div><div className="attention-items">{attention.slice(0, 4).map((workspace) => { const doctorCount = (doctorSummaries[workspace.id]?.error_count ?? 0) + (doctorSummaries[workspace.id]?.warning_count ?? 0); return <Button variant="bare" size="content" key={workspace.id} onClick={() => void onOpenDoctor(workspace)}><ShieldCheck size={15} /><span><strong>{workspace.name}</strong><small>{tr("home.workspaceWarnings", { count: doctorCount || workspace.warning_count })}</small></span><ChevronRight size={14} /></Button>; })}{pending > 0 && <Button variant="bare" size="content" onClick={() => onOpenAssets("memory")}><Brain size={15} /><span><strong>{tr("home.pendingMemory")}</strong><small>{tr("home.pendingMemoryDetail", { count: pending })}</small></span><ChevronRight size={14} /></Button>}</div></section> : <div className="attention-clear compact"><Check size={18} /><strong>{tr("home.allClear")}</strong></div>}
    <div className="summary-strip three"><Button variant="bare" size="content" onClick={onShowWorkspaces}><span>{tr("home.workspaceMetric")}</span><strong>{workspaces.length}</strong></Button><Button variant="bare" size="content" onClick={() => onOpenAssets("instructions")}><span>{tr("home.assetMetric")}</span><strong>{uniqueAssetCount}</strong></Button><Button variant="bare" size="content" onClick={onShowAgents}><span>{tr("home.installedAgents")}</span><strong>{installations.filter((item) => item.installed).length}</strong></Button></div>
    {!workspaces.length ? <>{insightCard}<div className="panel empty-global"><FolderGit2 size={30} /><h2>{tr("home.emptyTitle")}</h2><p>{tr("home.emptyText")}</p><Button className="primary" onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</Button></div></> : <div className={`home-main-grid${!insightCard && !importantActivity.length ? " single-column" : ""}`}><div className="panel"><div className="panel-head"><h2>{tr("home.recentWorkspaces")}</h2><span className="badge">{discovery ? tr("home.updated", { time: relativeTime(discovery.finished_at) }) : tr("home.discovering")}</span></div><div className="workspace-list">{workspaces.slice(0, 5).map((workspace) => <WorkspaceRow key={workspace.id} mode="compact" workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} />)}</div></div>{(insightCard || importantActivity.length > 0) && <div className="home-side-stack">{insightCard}{importantActivity.length > 0 && <div className="panel"><div className="panel-head"><h2>{tr("home.recentActivity")}</h2></div><div className="activity-list compact">{importantActivity.map((item) => <ActivityRow key={item.id} record={item} />)}</div></div>}</div>}</div>}
  </div>;
}

function WorkspacesPage({ view, storageJob, workspaces, assetCounts, discoveryRefreshing, onOpen, onRefreshDiscovery, onRefreshWorkspace, onExclude }: { view: WorkspaceView; storageJob?: RefreshJobStatus; workspaces: WorkspaceSummary[]; assetCounts: Map<string, number>; discoveryRefreshing: boolean; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onRefreshDiscovery: () => Promise<void>; onRefreshWorkspace: (id: string) => Promise<void>; onExclude: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all"); const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const filtered = workspaces.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || item.status === status) && (agent === "all" || item.sources.some((source) => source.agent === agent)));
  const groups = useMemo(() => { const values = new Map<string, WorkspaceSummary[]>(); for (const item of filtered) { const key = item.repository_group_id ?? `workspace:${item.id}`; values.set(key, [...(values.get(key) ?? []), item]); } return [...values.values()]; }, [filtered]);
  if (view === "storage") return <WorkspaceStoragePage workspaces={workspaces} job={storageJob} />;
  return <div className="workspace-index"><div className="panel workspace-table"><div className="toolbar sticky-toolbar workspace-list-toolbar"><div className="search"><Search size={16} /><Input aria-label={tr("workspace.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("workspace.searchPlaceholder")} /></div><div className="toolbar-filters"><SelectControl aria-label={tr("workspace.allAgents")} className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</SelectControl><SelectControl aria-label={tr("workspace.allStatuses")} className="setting-select" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">{tr("workspace.allStatuses")}</option><option value="healthy">{workspaceStatusLabel("healthy")}</option><option value="attention">{workspaceStatusLabel("attention")}</option></SelectControl></div><span className="result-count">{tr("workspace.resultCount", { count: filtered.length })}</span><Button className="ghost icon-only workspace-refresh" title={tr("workspace.refreshDiscovery")} aria-label={tr("workspace.refreshDiscovery")} aria-busy={discoveryRefreshing} onClick={() => void onRefreshDiscovery()} disabled={discoveryRefreshing}><RefreshCw size={15} className={discoveryRefreshing ? "spin" : ""} /></Button></div><div className="workspace-column-head" aria-hidden="true"><span>{tr("workspace.projectColumn")}</span><span>{tr("workspace.agentColumn")}</span><span>{tr("workspace.assetsColumn")}</span><span>{tr("workspace.activityColumn")}</span><span /></div><div className="repository-groups">{groups.map((group) => { const grouped = group.length > 1; return <section className={grouped ? "workspace-repository-group" : "single-workspace-group"} key={group[0].repository_group_id ?? group[0].id}>{grouped && <header><FolderGit2 size={15} /><strong>{group[0].name}</strong><span>{tr("workspace.worktrees", { count: group.length })}</span></header>}{group.map((workspace) => <div className="workspace-card" key={workspace.id}><WorkspaceRow mode="columns" workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} /><DropdownMenu><DropdownMenuTrigger className="row-menu-trigger" title={tr("common.moreActions")} aria-label={`${workspace.name} · ${tr("common.moreActions")}`}><MoreHorizontal size={15} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void onRefreshWorkspace(workspace.id)}><RefreshCw size={13} />{tr("common.scan")}</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => void onExclude(workspace.id)}><Trash2 size={13} />{tr("workspace.ignore")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>)}</section>; })}{!groups.length && <Empty compact icon={FolderGit2} title={tr("workspace.noMatch")} text={tr("workspace.noMatchText")} />}</div></div></div>;
}

function WorkspaceRow({ workspace, assetCount, mode = "compact", onOpen }: { workspace: WorkspaceSummary; assetCount?: number; mode?: "compact" | "columns"; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  const sourceAgents = workspace.sources.map((source) => source.agent).filter((value): value is AgentKind => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index);
  const agents = sourceAgents.map((value) => agentLabels[value]).join(" · ") || (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  if (mode === "columns") return <Button variant="bare" size="content" className="workspace-row workspace-row-columns" aria-label={`${workspace.name} · ${workspace.path} · ${agents}`} onClick={() => void onOpen(workspace)}><span className="workspace-primary"><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small></span><span className="workspace-agents" aria-label={agents}>{sourceAgents.length ? sourceAgents.map((value) => <span className="workspace-agent-tag" key={value}>{agentLabels[value]}</span>) : <span className="workspace-agent-tag neutral">{agents}</span>}</span><span className={`workspace-asset-count${count ? "" : " is-zero"}`}>{count}</span><span className="workspace-last-active">{workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span><span className="workspace-row-end">{workspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}<ChevronRight className="workspace-row-arrow" size={15} /></span></Button>;
  return <Button variant="bare" size="content" className="workspace-row" onClick={() => void onOpen(workspace)}><div className="workspace-icon"><FolderGit2 size={18} /></div><div><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small><span>{agents} · {tr("workspace.assetCount", { count })} · {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span></div>{workspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}<ChevronRight size={15} /></Button>;
}

function GlobalAssetsPage({ section, onSection, assets, workspaces, memories, runtime, onReload, onRuntimeChanged, onOpen, onMigrationPlanned }: { section: AssetSection; onSection: (section: AssetSection) => void; assets: CatalogAsset[]; workspaces: WorkspaceSummary[]; memories: MemoryRecord[]; runtime?: RuntimeInfo; onReload: () => Promise<void>; onRuntimeChanged: (runtime: RuntimeInfo) => void; onOpen: (id: string) => void; onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const pending = memories.filter((item) => item.status === "pending").length;
  const workspaceAssets = useMemo(() => groupCatalogAssets(assets.filter((asset) => asset.scope === "workspace")), [assets]);
  const instructionAssets = workspaceAssets.filter((asset) => asset.kind === "instruction");
  const skillAssets = workspaceAssets.filter((asset) => asset.kind === "skill");
  const connectionAssets = workspaceAssets.filter((asset) => asset.kind === "connection");
  const otherAssets = workspaceAssets.filter((asset) => !["instruction", "skill", "connection", "memory"].includes(asset.kind));
  const pendingMemoryLabel = pending ? tr("memory.pendingCount", { count: pending }) : undefined;
  return <div className="stack"><Tabs value={section} onValueChange={(value) => onSection(value as AssetSection)}><TabsList className="section-tabs asset-category-tabs" variant="line" aria-label={tr("nav.assets")}><TabsTrigger value="instructions"><FileCode2 size={15} />{tr("assets.instructions")}<em>{instructionAssets.length}</em></TabsTrigger><TabsTrigger value="skills"><Sparkles size={15} />{tr("assets.skills")}<em>{skillAssets.length}</em></TabsTrigger><TabsTrigger value="mcp"><PlugZap size={15} />MCP<em>{connectionAssets.length}</em></TabsTrigger><TabsTrigger value="memory"><Brain size={15} />{tr("assets.memories")}<em className={pending ? "attention-count" : ""} aria-label={pendingMemoryLabel} title={pendingMemoryLabel}>{memories.length}</em></TabsTrigger><TabsTrigger value="other"><Boxes size={15} />{tr("assets.hooksProfiles")}<em>{otherAssets.length}</em></TabsTrigger></TabsList></Tabs>{section === "instructions" && <CatalogPage assets={instructionAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "skills" && <CatalogPage assets={skillAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "other" && <CatalogPage assets={otherAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "memory" && <GlobalMemoryInbox records={memories} workspaces={workspaces} onReload={onReload} />}{section === "mcp" && <McpHubPage runtime={runtime} workspaces={workspaces} onRuntimeChanged={onRuntimeChanged} onMigrationPlanned={onMigrationPlanned} />}</div>;
}

function CatalogPage({ assets, workspaces, onOpen }: { assets: CatalogAssetGroup[]; workspaces: WorkspaceSummary[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [agent, setAgent] = useState<"all" | AgentKind>("all"); const [kind, setKind] = useState("all"); const [workspaceId, setWorkspaceId] = useState("all"); const [ownership, setOwnership] = useState<"all" | "shared" | "native">("all");
  const [selectedId, setSelectedId] = useState<string>();
  const kinds = [...new Set(assets.map((asset) => asset.kind))].sort();
  const showKind = kinds.length > 1;
  const filtered = assets.filter((asset) => `${asset.name} ${asset.path} ${asset.summary} ${localizedAssetSummary(asset)} ${asset.kind} ${asset.agents.map((value) => agentLabels[value]).join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (agent === "all" || asset.agents.includes(agent)) && (kind === "all" || asset.kind === kind) && (workspaceId === "all" || asset.workspace_id === workspaceId) && (ownership === "all" || (ownership === "shared" ? !asset.agents.length : asset.agents.length > 0)));
  const selected = assets.find((asset) => asset.id === selectedId);
  return <div className={`catalog-layout${selected ? " has-inspector" : ""}`}><div className="panel"><div className="toolbar catalog-toolbar"><div className="search"><Search size={16} /><Input aria-label={tr("catalog.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("catalog.searchPlaceholder")} /></div><div className="toolbar-filters"><SelectControl aria-label={tr("workspace.all")} className="setting-select" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="all">{tr("workspace.all")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</SelectControl><SelectControl aria-label={tr("workspace.allAgents")} className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectControl>{showKind && <SelectControl aria-label={tr("catalog.allTypes")} className="setting-select" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">{tr("catalog.allTypes")}</option>{kinds.map((value) => <option key={value} value={value}>{tr(`status.asset.${value}`)}</option>)}</SelectControl>}<SelectControl aria-label={tr("catalog.allOwnership")} className="setting-select" value={ownership} onChange={(event) => setOwnership(event.target.value as typeof ownership)}><option value="all">{tr("catalog.allOwnership")}</option><option value="shared">{tr("catalog.shared")}</option><option value="native">{tr("catalog.native")}</option></SelectControl></div><span>{filtered.length} {tr("common.assets")}</span></div><div className={`catalog-table${showKind ? " with-kind" : ""}`}><div className="catalog-row table-head"><span>{tr("catalog.asset")}</span>{showKind && <span>{tr("catalog.type")}</span>}<span>{tr("catalog.workspace")}</span><span>{tr("catalog.visibleAgents")}</span></div>{filtered.map((asset) => { const visibleAgents = asset.agents.slice(0, 2); const hiddenAgentCount = asset.agents.length - visibleAgents.length; const allAgents = asset.agents.map((value) => agentLabels[value]).join(", "); return <Button variant="bare" size="content" className={`catalog-row${selectedId === asset.id ? " selected" : ""}`} key={asset.id} onClick={() => setSelectedId(asset.id)}><span className="asset-name"><FileCode2 size={15} /><span><strong>{asset.name}</strong><small title={asset.path}>{shortPath(asset.path)}</small></span></span>{showKind && <span className="tag">{tr(`status.asset.${asset.kind}`)}</span>}<span>{asset.workspace_id ? workspaces.find((item) => item.id === asset.workspace_id)?.name : "—"}</span><span className="agent-tags" aria-label={allAgents || tr("catalog.shared")} title={allAgents}>{asset.agents.length ? <>{visibleAgents.map((value) => <span className="tag" key={value}>{agentLabels[value]}</span>)}{hiddenAgentCount > 0 && <span className="tag agent-overflow">+{hiddenAgentCount}</span>}</> : <span>{tr("catalog.shared")}</span>}</span></Button>; })}{!filtered.length && <Empty compact icon={Library} title={tr("catalog.noMatch")} text={tr("catalog.noMatchText")} />}</div></div>{selected && <aside className="panel asset-inspector"><div className="inspector-head"><FileCode2 size={18} /><h2>{selected.name}</h2><Button className="icon-button" onClick={() => setSelectedId(undefined)} aria-label={tr("common.close")}><X size={16} /></Button></div><dl><div><dt>{tr("catalog.type")}</dt><dd>{tr(`status.asset.${selected.kind}`)}</dd></div><div><dt>{tr("catalog.workspace")}</dt><dd>{selected.workspace_id ? workspaces.find((item) => item.id === selected.workspace_id)?.name : "—"}</dd></div><div><dt>{tr("catalog.visibleAgents")}</dt><dd>{selected.agents.length ? selected.agents.map((value) => agentLabels[value]).join(" · ") : tr("catalog.shared")}</dd></div><div><dt>{tr("catalog.path")}</dt><dd><code>{selected.path}</code></dd></div></dl>{selected.workspace_id && <Button className="primary inspector-action" onClick={() => onOpen(selected.workspace_id!)}>{tr("catalog.openWorkspace")}<ChevronRight size={14} /></Button>}</aside>}</div>;
}

function GlobalMemoryInbox({ records, workspaces, onReload }: { records: MemoryRecord[]; workspaces: WorkspaceSummary[]; onReload: () => Promise<void> }) {
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { await api.reviewMemory(id, status, editedContent); await onReload(); };
  return <div className="panel inbox"><div className="panel-head"><div><h2>{tr("memory.globalTitle")}</h2><p>{tr("memory.globalPending", { count: records.filter((item) => item.status === "pending").length })}</p></div></div><div className="memory-list">{records.map((record) => <div key={record.id} className="global-memory-item"><span className="workspace-memory-label">{workspaces.find((item) => item.manifest_workspace_id === record.project_id)?.name ?? record.project_id.slice(0, 8)}</span><MemoryCard record={record} onReview={review} /></div>)}{!records.length && <Empty icon={Brain} title={tr("memory.empty")} text={tr("memory.globalEmptyText")} />}</div></div>;
}

function ActivityPage({ records }: { records: ActivityRecord[] }) { return <div className="panel"><div className="panel-head"><div><h2>{tr("activity.title")}</h2><p>{tr("activity.description")}</p></div></div><div className="activity-list">{records.map((record) => <ActivityRow key={record.id} record={record} />)}{!records.length && <Empty icon={History} title={tr("home.noActivity")} text={tr("activity.emptyText")} />}</div></div>; }
function ActivityRow({ record }: { record: ActivityRecord }) { const key = `activity.action.${record.action}`; return <div className="activity-row"><span className="activity-dot" /><div><strong>{tr(key, { defaultValue: record.action })}</strong><small title={record.detail}>{record.detail}</small></div><time>{formatDateTime(record.created_at)}</time></div>; }

function McpHubPage({ runtime, workspaces, onRuntimeChanged, onMigrationPlanned }: { runtime?: RuntimeInfo; workspaces: WorkspaceSummary[]; onRuntimeChanged: (runtime: RuntimeInfo) => void; onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const dialogs = useAppDialogs();
  const [servers, setServers] = useState<McpServerConfig[]>([]); const [installations, setInstallations] = useState<McpInstallation[]>([]); const [runtimes, setRuntimes] = useState<McpRuntimeStatus[]>([]);
  const [registry, setRegistry] = useState<McpRegistryEntry[]>([]); const [query, setQuery] = useState(""); const [scope, setScope] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const project = scope || undefined;
  const load = async () => { const [nextServers, nextInstallations, nextRuntimes, nextRuntime] = await Promise.all([api.mcpServers(project), api.mcpInstallations(), api.mcpRuntimes(), api.runtime()]); setServers(nextServers); setInstallations(nextInstallations); setRuntimes(nextRuntimes); onRuntimeChanged(nextRuntime); };
  useEffect(() => { void load().catch((reason) => setError(localizeMessage(reason))); }, [scope]);
  const searchRegistry = async () => { setBusy(true); setError(""); try { setRegistry(await api.searchMcpRegistry(query)); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const install = async (entry: McpRegistryEntry) => { const command = entry.package_kind === "remote" ? entry.url : `${entry.package_kind === "npm" ? "npm" : "uv"} · ${entry.identifier}@${entry.version}`; if (!await dialogs.confirm(tr("mcp.installConfirm", { name: entry.name, command }))) return; const env = await dialogs.requestSecrets(entry.required_env); if (env === null) return; setBusy(true); setError(""); try { const result = await api.installMcp(entry, project); if (Object.keys(env).length) await api.saveMcpLocalValues(result.server.id, env, {}, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const updateInstallation = async (installation: McpInstallation, entry: McpRegistryEntry) => { if (!await dialogs.confirm(tr("mcp.updateConfirm", { name: installation.name, version: entry.version }))) return; const env = await dialogs.requestSecrets(entry.required_env); if (env === null) return; setBusy(true); setError(""); try { const result = await api.updateMcp(installation.id, entry, project); if (Object.keys(env).length) await api.saveMcpLocalValues(result.server.id, env, {}, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const updateNetwork = async (lanEnabled: boolean) => { if (lanEnabled && !await dialogs.confirm({ description: tr("mcp.lanWarning"), tone: "warning" })) return; try { await api.updateMcpNetwork({ port: runtime?.mcp_network?.port ?? 47653, lan_enabled: lanEnabled, lan_risk_accepted: lanEnabled }); onRuntimeChanged(await api.runtime()); } catch (reason) { setError(localizeMessage(reason)); } };
  const updatePort = async (port: number) => { if (!Number.isInteger(port) || port < 1 || port > 65535 || port === runtime?.mcp_network?.port) return; try { await api.updateMcpNetwork({ port, lan_enabled: runtime?.mcp_network?.lan_enabled ?? false, lan_risk_accepted: runtime?.mcp_network?.lan_risk_accepted ?? false }); onRuntimeChanged(await api.runtime()); } catch (reason) { setError(localizeMessage(reason)); } };
  const authorize = async (serverId: string) => { try { const result = await api.startMcpOAuth(serverId, project); await openUrl(result.authorization_url); } catch (reason) { setError(localizeMessage(reason)); } };
  return <div className="stack mcp-hub-page">{error && <div className="alert"><CircleAlert size={16} />{error}</div>}<div className="mcp-hero"><div><span className="eyebrow">STREAMABLE HTTP MCP HUB</span><h2>{tr("mcp.title")}</h2><p>{tr("mcp.description")}</p></div><div className="mcp-hub-address"><span className={runtime?.mcp_hub?.running ? "ready" : "status rejected"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code><small>{tr("mcp.runtimeCount", { count: runtime?.mcp_hub?.runtime_count ?? 0 })}</small></div></div><div className="panel mcp-network"><div><h2>{tr("mcp.network")}</h2><p>{tr("mcp.networkDescription")}</p></div><div className="mcp-network-controls"><Label><span>{tr("mcp.port")}</span><Input className="mcp-port" type="number" min="1" max="65535" defaultValue={runtime?.mcp_network?.port ?? 47653} onBlur={(event) => void updatePort(Number(event.target.value))} /></Label><Label><span>{tr("mcp.lanMode")}</span><Switch checked={runtime?.mcp_network?.lan_enabled ?? false} onCheckedChange={(checked) => void updateNetwork(checked)} /></Label></div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.scope")}</h2><p>{tr("mcp.scopeDescription")}</p></div><SelectControl className="setting-select" value={scope} onChange={(event) => setScope(event.target.value)}><option value="">{tr("mcp.globalScope")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.path}>{workspace.name}</option>)}</SelectControl></div></div><McpServerEditor project={project} onSaved={load} /><McpMigrationInventory project={project} onPlanned={onMigrationPlanned} /><div className="two-col mcp-columns"><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.registry")}</h2><p>{tr("mcp.registryDescription")}</p></div></div><div className="mcp-search"><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRegistry(); }} placeholder={tr("mcp.searchPlaceholder")} /><Button className="primary" disabled={busy} onClick={() => void searchRegistry()}><Search size={14} />{tr("common.search")}</Button></div><div className="mcp-list">{registry.map((entry) => <article key={`${entry.name}-${entry.version}`}><div><strong>{entry.name}</strong><small>{entry.description}</small><span>{entry.package_kind} · {entry.version}{entry.required_env.length ? ` · ${tr("mcp.requiredEnv", { count: entry.required_env.length })}` : ""}</span></div><Button className="ghost" onClick={() => void install(entry)}>{tr("mcp.install")}</Button></article>)}{!registry.length && <p>{tr("mcp.registryEmpty")}</p>}</div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.configured")}</h2><p>{tr("mcp.configuredDescription")}</p></div><span className="badge">{servers.length}</span></div><div className="mcp-list">{servers.map((server) => <article key={server.id}><div><strong>{server.name}</strong><small>{server.transport === "stdio" ? server.command : server.url}</small><span>{server.targets.length ? server.targets.map((agent) => agentLabels[agent]).join(" · ") : tr("mcp.allAgents")}</span></div><div className="mcp-actions">{server.transport === "streamable-http" && <Button className="ghost" onClick={() => void authorize(server.id)}>{tr("mcp.authorize")}</Button>}<Button className="ghost" onClick={async () => { try { await api.probeMcpRuntime(server.id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.probe")}</Button><Button className="icon-danger" onClick={async () => { await api.removeMcpServer(server.id, project); await load(); }}><Trash2 size={14} /></Button></div></article>)}{!servers.length && <p>{tr("mcp.configuredEmpty")}</p>}</div></div></div><div className="two-col mcp-columns"><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.installations")}</h2><p>{runtime?.mcp_package_root}</p></div><span className="badge">{installations.length}</span></div><div className="mcp-list">{installations.map((item) => { const update = registry.find((entry) => entry.package_kind === item.package_kind && entry.identifier === item.identifier && entry.version !== item.version); return <article key={item.id}><div><strong>{item.name}</strong><small>{item.identifier}</small><span>{item.package_kind} · {item.version ?? "—"}</span></div><div className="mcp-actions">{update && <Button className="ghost" disabled={busy} onClick={() => void updateInstallation(item, update)}>{tr("mcp.update")}</Button>}<Button className="icon-danger" onClick={async () => { if (!await dialogs.confirm({ description: tr("mcp.uninstallConfirm", { name: item.name }), tone: "destructive" })) return; await api.uninstallMcp(item.id); await load(); }}><Trash2 size={14} /></Button></div></article>; })}{!installations.length && <p>{tr("mcp.installationsEmpty")}</p>}</div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.runtimes")}</h2><p>{tr("mcp.lazyRuntime")}</p></div><Button className="ghost" onClick={() => void load()}><RefreshCw size={13} />{tr("common.refresh")}</Button></div><div className="mcp-list">{runtimes.map((item) => <article key={item.config_hash}><div><strong>{item.server_name}</strong><small>{item.config_hash.slice(0, 16)}…</small><span className={`status ${item.state}`}>{tr(`mcp.runtime.${item.state}`)}</span></div><div className="mcp-actions"><Button className="ghost" onClick={async () => { try { await api.restartMcpRuntime(item.server_id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.restart")}</Button><Button className="ghost" onClick={async () => { await api.stopMcpRuntime(item.server_id); await load(); }}>{tr("mcp.stop")}</Button></div></article>)}{!runtimes.length && <p>{tr("mcp.runtimesEmpty")}</p>}</div></div></div></div>;
}

function McpServerEditor({ project, onSaved }: { project?: string; onSaved: () => Promise<void> }) {
  const defaultConfig = JSON.stringify({ id: "my-server", name: "My Server", enabled: true, transport: "streamable-http", url: "https://example.com/mcp", targets: [], allow_tools: [], lan_allow_tools: [], supports_parallel_tool_calls: false }, null, 2);
  const [config, setConfig] = useState(defaultConfig);
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parseSecretLines = (value: string) => Object.fromEntries(value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const separator = line.indexOf("="); if (separator <= 0) throw new Error(tr("mcp.secretFormatError")); return [line.slice(0, separator).trim(), line.slice(separator + 1)]; }));
  const save = async () => {
    setSaving(true); setError("");
    try {
      const server = JSON.parse(config) as McpServerConfig;
      if (!server.id || !server.name || !server.transport) throw new Error(tr("mcp.configRequired"));
      if (server.transport === "sse") throw new Error(tr("mcp.sseImportOnly"));
      await api.saveMcpServer(server, project);
      await api.saveMcpLocalValues(server.id, parseSecretLines(env), parseSecretLines(headers), project);
      setEnv(""); setHeaders("");
      await onSaved();
    } catch (reason) { setError(localizeMessage(reason)); } finally { setSaving(false); }
  };
  return <div className="panel mcp-editor"><div className="panel-head"><div><h2>{tr("mcp.editor")}</h2><p>{tr("mcp.editorDescription")}</p></div><Button className="primary" disabled={saving} onClick={() => void save()}>{tr("common.save")}</Button></div>{error && <div className="alert"><CircleAlert size={16} />{error}</div>}<div className="mcp-editor-grid"><Label><span>{tr("mcp.publicJson")}</span><Textarea value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} /></Label><div><Label><span>{tr("mcp.environmentSecrets")}</span><Textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder="API_TOKEN=…" spellCheck={false} /></Label><Label><span>{tr("mcp.headerSecrets")}</span><Textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder="Authorization=Bearer …" spellCheck={false} /></Label><small>{tr("mcp.secretDescription")}</small></div></div></div>;
}

function McpMigrationInventory({ project, onPlanned }: { project?: string; onPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const dialogs = useAppDialogs();
  const [candidates, setCandidates] = useState<import("./types").McpMigrationCandidate[]>([]);
  const [scanned, setScanned] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scan = async () => { setCandidates(await api.nativeMcpCandidates(project)); setScanned(true); };
  const plan = async () => { if (!project || !selected.length) return; if (!await dialogs.confirm(tr("mcp.migrationConfirm", { count: selected.length }))) return; setBusy(true); setError(""); try { await onPlanned(project, await api.planMcpMigration(project, selected)); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const toggle = (id: string, checked: boolean) => setSelected((current) => checked ? [...current, id] : current.filter((value) => value !== id));
  return <div className="panel"><div className="panel-head"><div><h2>{tr("mcp.migration")}</h2><p>{tr("mcp.migrationDescription")}</p></div><div className="mcp-actions"><Button className="ghost" onClick={() => void scan()}><Search size={13} />{tr("common.scan")}</Button><Button className="primary" disabled={!project || !selected.length || busy} onClick={() => void plan()}>{tr("mcp.planMigration")}</Button></div></div>{!project && <div className="warning"><CircleAlert size={14} />{tr("mcp.projectRequired")}</div>}{error && <div className="alert"><CircleAlert size={16} />{error}</div>}{scanned && <div className="mcp-list migration-list">{candidates.map((candidate) => <article key={candidate.id}><Label><Checkbox disabled={!candidate.supported || !project} checked={selected.includes(candidate.id)} onCheckedChange={(checked) => toggle(candidate.id, checked)} /><span><strong>{candidate.name}</strong><small>{agentLabels[candidate.agent]} · {candidate.source_path}</small><em>{candidate.transport} · {candidate.endpoint}{candidate.has_secret_values ? ` · ${tr("mcp.secretReentry")}` : ""}</em></span></Label><span className={`status ${candidate.supported ? "approved" : "rejected"}`}>{tr(candidate.supported ? "mcp.importable" : "mcp.unsupported")}</span></article>)}{!candidates.length && <p>{tr("mcp.migrationEmpty")}</p>}</div>}</div>;
}

function GlobalSettings({ section, runtime, workspaces, discovery, insightsStatus, quotaStatus, remoteGateways, scanRoots, excluded, activity, onAddRoot, onRemoveRoot, onRestore, onCloseBehaviorChanged, onLocaleChanged, onRemoteGatewaysChanged }: { section: SettingsSection; runtime?: RuntimeInfo; workspaces: WorkspaceSummary[]; discovery?: DiscoveryReport; insightsStatus?: InsightsStatus; quotaStatus?: QuotaCollectorStatus; remoteGateways: RemoteGatewaySummary[]; scanRoots: ScanRoot[]; excluded: ExcludedWorkspace[]; activity: ActivityRecord[]; onAddRoot: () => Promise<void>; onRemoveRoot: (id: string) => Promise<void>; onRestore: (path: string) => Promise<void>; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>; onLocaleChanged: (runtime: RuntimeInfo) => void; onRemoteGatewaysChanged: () => Promise<void> }) {
  if (section === "general") return <div className="settings-groups"><section className="panel settings-section settings-general"><div className="setting-rows"><ThemeSetting runtime={runtime} onChanged={onLocaleChanged} /><AppIconSetting runtime={runtime} onChanged={onLocaleChanged} /><LanguageSetting runtime={runtime} onChanged={onLocaleChanged} /><div className="setting-row"><div><strong>{tr("settings.closeBehavior")}</strong></div><CloseBehaviorSelect value={runtime?.close_behavior} trayAvailable={runtime?.tray_available !== false} onChange={onCloseBehaviorChanged} /></div>{runtime?.tray_available === false && <div className="setting-detail warning" role="status"><CircleAlert size={14} />{tr("settings.trayUnavailable")}</div>}</div></section></div>;
  if (section === "discovery") return <div className="settings-groups"><SettingGroup title={tr("settings.discovery")}><div className="setting-row"><div><strong>{tr("settings.discoveryStatus")}</strong></div><span className={discovery?.errors.length ? "status rejected" : "ready"}>{discovery ? tr("settings.workspaceCount", { count: discovery.discovered_count }) : tr("home.discovering")}</span></div>{discovery?.errors.map((error) => <div className="setting-detail error" key={error}>{error}</div>)}</SettingGroup><div className="panel settings-section"><div className="panel-head"><h2>{tr("settings.scanRoots")}</h2><Button className="primary" onClick={() => void onAddRoot()}>{tr("settings.addFolder")}</Button></div><div className="settings-list">{scanRoots.map((root) => <div key={root.id}><FolderGit2 size={16} /><span><strong>{root.path}</strong><small>{tr("settings.maxDepth", { depth: root.max_depth })}</small></span><Button className="icon-danger" onClick={() => void onRemoveRoot(root.id)}><Trash2 size={15} /></Button></div>)}{!scanRoots.length && <p>{tr("settings.noScanRoots")}</p>}</div></div><div className="panel settings-section"><div className="panel-head"><h2>{tr("settings.excluded")}</h2></div><div className="settings-list">{excluded.map((item) => <div key={item.path}><X size={16} /><span><strong>{item.path}</strong><small>{formatDateTime(item.created_at)}</small></span><Button className="ghost" onClick={() => void onRestore(item.path)}>{tr("common.restore")}</Button></div>)}{!excluded.length && <p>{tr("settings.noExcluded")}</p>}</div></div></div>;
  if (section === "integrations") return <div className="settings-groups"><SettingGroup title="AgentKib MCP Hub"><div className="setting-row"><div><strong>{tr("mcp.network")}</strong><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code></div><span className={runtime?.mcp_hub?.running ? "ready" : "status neutral"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span></div></SettingGroup><RemoteGatewaysSettings gateways={remoteGateways} onChanged={onRemoteGatewaysChanged} /><ObsidianSettingsCard /></div>;
  if (section === "privacy") return <div className="settings-groups"><SettingGroup title={tr("settings.localData")}><div className="setting-row"><div><strong>{tr("settings.dataLocation")}</strong><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />{tr("common.localOnly")}</span></div>{hasFileAccessSettings && <FileAccessSettingsRow />}</SettingGroup><ConversationPrivacySettings runtime={runtime} workspaces={workspaces} onChanged={onLocaleChanged} /><GitIdentitySettings /></div>;
  return <div className="settings-groups"><SettingGroup title={tr("quota.diagnostics")}><QuotaDiagnostics status={quotaStatus} /></SettingGroup><SettingGroup title={tr("settings.providerStatus")}>{insightsStatus?.providers.map((provider) => <div className="setting-row" key={provider.agent}><div className="setting-agent"><AgentIcon agent={provider.agent} /><strong>{agentLabels[provider.agent]}</strong></div><span className="status neutral">{tr(provider.available ? "quota.available" : "insights.noData")}</span></div>)}{!insightsStatus?.providers.length && <div className="setting-empty">{tr("insights.noData")}</div>}</SettingGroup><ActivityPage records={activity} /></div>;
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="panel settings-section"><div className="panel-head"><h2>{title}</h2></div><div className="setting-rows">{children}</div></section>; }

function FileAccessSettingsRow() {
  const [error, setError] = useState("");
  const openSettings = async () => {
    setError("");
    try { await api.openFilesAndFoldersSettings(); }
    catch (reason) { setError(localizeMessage(reason)); }
  };
  return <><div className="setting-row"><div><strong>{tr("settings.appDataAccess")}</strong></div><Button className="ghost" type="button" onClick={() => void openSettings()}><ExternalLink size={14} />{tr("settings.openFilesAndFolders")}</Button></div>{error && <div className="setting-detail error" role="alert">{error}</div>}</>;
}

function ConversationPrivacySettings({ runtime, workspaces, onChanged }: { runtime?: RuntimeInfo; workspaces: WorkspaceSummary[]; onChanged: (runtime: RuntimeInfo) => void }) {
  const dialogs = useAppDialogs();
  const [indexedCount, setIndexedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadCount = async () => {
    const statuses = await Promise.all(workspaces.map((workspace) => api.workspaceSessionStatus(workspace.id)));
    setIndexedCount(statuses.filter((items) => items.some((item) => item.last_success_at)).length);
  };
  useEffect(() => {
    void loadCount().catch(() => undefined);
  }, [workspaces]);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError("");
    try {
      onChanged(await api.setSessionIndexEnabled(enabled));
      if (!enabled) setIndexedCount(0);
    } catch (reason) { setError(localizeMessage(reason)); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!await dialogs.confirm({ description: tr("conversations.clearConfirm"), tone: "destructive" })) return;
    setBusy(true); setError("");
    try { await api.clearSessionIndex(); setIndexedCount(0); }
    catch (reason) { setError(localizeMessage(reason)); }
    finally { setBusy(false); }
  };
  return <SettingGroup title={tr("conversations.settingsTitle")}>
    <div className="setting-row"><div><strong>{tr("conversations.indexSetting")}</strong></div><Label className="switch"><Switch checked={runtime?.session_index_enabled !== false} disabled={busy} onCheckedChange={(checked) => void toggle(checked)} /></Label></div>
    <div className="setting-row"><div><strong>{tr("conversations.indexedWorkspaces", { count: indexedCount })}</strong></div><Button className="ghost" disabled={busy || indexedCount === 0} onClick={() => void clear()}><Trash2 size={14} />{tr("conversations.clearIndex")}</Button></div>
    {error && <div className="setting-detail error" role="alert">{error}</div>}
  </SettingGroup>;
}

function LanguageSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: LocalePreference) => {
    const nextRuntime = await api.setLocale(preference);
    await changeLocale(nextRuntime.effective_locale);
    onChanged(nextRuntime);
  };
  return <div className="setting-row"><div><strong>{tr("settings.language")}</strong></div><SelectControl aria-label={tr("settings.language")} className="setting-select" value={runtime?.locale_preference ?? "system"} onChange={(event) => void update(event.target.value as LocalePreference)}>{(["system", "zh-CN", "zh-TW", "ja-JP", "en-US"] as LocalePreference[]).map((locale) => <option key={locale} value={locale}>{tr(`settings.language.${locale}`)}</option>)}</SelectControl></div>;
}

function ThemeSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: ThemePreference) => {
    const nextRuntime = await api.setThemePreference(preference);
    applyTheme(nextRuntime.effective_theme);
    onChanged(nextRuntime);
  };
  const selected = runtime?.theme_preference ?? "system";
  return <div className="setting-row"><div><strong>{tr("settings.theme")}</strong></div><ToggleGroup className="theme-segments" value={[selected]} onValueChange={(values) => { const theme = values[0]; if (theme === "light" || theme === "dark" || theme === "system") void update(theme); }} aria-label={tr("settings.theme")}>{(["light", "dark", "system"] as ThemePreference[]).map((theme) => <ToggleGroupItem key={theme} value={theme} className={selected === theme ? "active" : ""}>{tr(`settings.theme.${theme}`)}</ToggleGroupItem>)}</ToggleGroup></div>;
}

function AppIconSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: AppIconPreference) => {
    onChanged(await api.setAppIconPreference(preference));
  };
  const selected = runtime?.app_icon_preference ?? "white";
  return <div className="setting-row"><div><strong>{tr("settings.appIcon")}</strong></div><ToggleGroup className="theme-segments app-icon-segments" value={[selected]} onValueChange={(values) => { const icon = values[0]; if (icon === "white" || icon === "black") void update(icon); }} aria-label={tr("settings.appIcon")}>{(["white", "black"] as AppIconPreference[]).map((icon) => <ToggleGroupItem key={icon} value={icon} className={selected === icon ? "active" : ""}><span className={`app-icon-preview ${icon}`} aria-hidden="true" />{tr(`settings.appIcon.${icon}`)}</ToggleGroupItem>)}</ToggleGroup></div>;
}

function CloseBehaviorSelect({ value, trayAvailable = true, onChange }: { value?: CloseBehavior; trayAvailable?: boolean; onChange: (behavior?: CloseBehavior) => Promise<void> }) {
  const modifier = primaryShortcutModifier(buildPlatform);
  const trayKey = usesSystemTrayWording(buildPlatform) ? "settings.close.systemTray" : "settings.close.tray";
  const selected = value ?? "ask";
  return <SelectControl aria-label={tr("settings.closeBehavior")} className="setting-select" title={tr("settings.close.quitShortcut", { modifier })} value={selected} onChange={(event) => void onChange(event.target.value === "ask" ? undefined : event.target.value as CloseBehavior)}><option value="ask">{tr("settings.close.ask")}</option><option value="minimize-to-tray" disabled={!trayAvailable}>{tr(trayKey)}</option><option value="quit">{tr("settings.close.quit")}</option></SelectControl>;
}

function GitIdentitySettings() {
  const [identities, setIdentities] = useState<GitIdentitySummary[]>([]); const [email, setEmail] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setIdentities(await api.gitIdentities()); } catch (reason) { setError(localizeMessage(reason)); } };
  useEffect(() => { void load(); }, []);
  const add = async () => { if (!email.trim()) return; try { setError(""); await api.addGitIdentityAlias(email); setEmail(""); await load(); } catch (reason) { setError(localizeMessage(reason)); } };
  return <div className="panel"><div className="panel-head"><div><h2>{tr("settings.gitIdentity")}</h2><p>{tr("settings.gitIdentityDescription")}</p></div></div>{error && <div className="alert">{error}</div>}<div className="git-identity-form"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void add(); }} placeholder={tr("settings.gitAliasPlaceholder")} /><Button className="ghost" onClick={() => void add()}>{tr("settings.addAlias")}</Button></div><div className="settings-list">{identities.map((identity) => <Label key={identity.id}><GitCommitHorizontal size={15} /><span><strong>{metadataLabel(identity.label)}</strong><small>{identity.source} · {identity.id.slice(0, 10)}…</small></span><Switch checked={identity.enabled} onCheckedChange={async (checked) => { await api.setGitIdentityEnabled(identity.id, checked); await load(); }} /></Label>)}{!identities.length && <p>{tr("settings.gitIdentityEmpty")}</p>}</div></div>;
}

function Overview({ workspace, scan, manifest }: { workspace: WorkspaceSummary; scan: WorkspaceScan; manifest: Manifest }) {
  const configuredAgents = scan.agents.filter((agent) => agent.detected || agent.warnings.length > 0);
  const unconfiguredAgents = scan.agents.filter((agent) => !agent.detected && agent.warnings.length === 0);
  const issueCount = scan.warnings.length + scan.agents.reduce((total, agent) => total + agent.warnings.length, 0);
  const sharedAssets = (manifest.instructions.shared.trim() ? 1 : 0) + manifest.instructions.scoped.length + manifest.skills.length + manifest.connections.length;
  const sources = workspace.sources.flatMap((source) => source.agent ? [agentLabels[source.agent]] : []).filter((value, index, values) => values.indexOf(value) === index).join(" · ") || tr("workspace.source.manual");
  return <div className="stack">
    {scan.warnings.map((warning) => <div className="warning overview-warning" key={warning}><CircleAlert size={15} />{warning}</div>)}
    <div className="workspace-overview-meta"><Button type="button" title={tr("workspace.copyPath")} onClick={() => void navigator.clipboard?.writeText(workspace.path)}><code>{workspace.path}</code><Copy size={13} /></Button><span><strong>{tr("workspace.discoverySources")}</strong>{sources}</span><span><strong>{tr("workspace.lastScanLabel")}</strong>{workspace.last_scanned_at ? relativeTime(workspace.last_scanned_at) : tr("common.never")}</span></div>
    <div className="workspace-summary-bar"><div><span>{tr("overview.health")}</span><strong>{workspaceStatusLabel(issueCount ? "attention" : "healthy")}</strong></div><div><span>{tr("overview.sharedAssets")}</span><strong>{sharedAssets}</strong></div><div><span>{tr("overview.projectAgentConfigs")}</span><strong>{scan.agents.filter((agent) => agent.detected).length}</strong></div><div><span>{tr("overview.realIssues")}</span><strong>{issueCount}</strong></div></div>
    <div className="workspace-overview-grid"><section className="panel"><div className="panel-head"><h2>{tr("overview.publicSource")}</h2>{scan.manifest_exists && <span className="badge">Schema v{manifest.schema_version}</span>}</div><dl className="summary-list"><div><dt>{tr("assets.sharedInstructions")}</dt><dd>{manifest.instructions.shared.trim() ? 1 : 0}</dd></div><div><dt>{tr("overview.sharedSkills")}</dt><dd>{manifest.skills.length}</dd></div><div><dt>MCP</dt><dd>{manifest.connections.length}</dd></div><div><dt>{tr("overview.scopedRules")}</dt><dd>{manifest.instructions.scoped.length}</dd></div></dl></section><section className="panel"><div className="panel-head"><h2>{tr("overview.projectAgentConfigs")}</h2></div><div className="agent-readiness-list">{configuredAgents.map((agent) => <div key={agent.agent}><AgentIcon agent={agent.agent} /><strong>{agentLabels[agent.agent]}</strong><span>{tr("overview.nativeAssets", { count: agent.asset_count })}</span><span className={agent.warnings.length ? "status attention" : "ready"}>{tr(agent.warnings.length ? "status.workspace.attention" : "overview.detected")}</span></div>)}{!configuredAgents.length && <p className="neutral-empty">{tr("overview.noProjectAgentConfigs")}</p>}{unconfiguredAgents.length > 0 && <Collapsible className="unconfigured-agents"><CollapsibleTrigger>{tr("overview.otherAgents", { count: unconfiguredAgents.length })}</CollapsibleTrigger><CollapsibleContent>{unconfiguredAgents.map((agent) => <div key={agent.agent}><AgentIcon agent={agent.agent} /><strong>{agentLabels[agent.agent]}</strong><span>{tr("overview.noProjectConfig")}</span></div>)}</CollapsibleContent></Collapsible>}</div></section></div>
    <WorkspaceObsidianCard workspaceId={workspace.id} />
  </div>;
}

function Assets({ section, onSection, scan, manifest, onChange }: { section: WorkspaceAssetSection; onSection: (section: WorkspaceAssetSection) => void; scan: WorkspaceScan; manifest: Manifest; onChange: (manifest: Manifest) => void }) {
  const [query, setQuery] = useState("");
  const [skillName, setSkillName] = useState(""); const [skillPath, setSkillPath] = useState("");
  const [connectionName, setConnectionName] = useState(""); const [transport, setTransport] = useState<"stdio" | "http">("stdio"); const [endpoint, setEndpoint] = useState("");
  const nativeAssets = useMemo(() => groupWorkspaceAssets(scan.assets), [scan.assets]);
  const filtered = nativeAssets.filter((asset) => `${asset.agents.join(" ")} ${asset.kind} ${asset.path}`.toLowerCase().includes(query.toLowerCase()));
  const addSkill = () => { if (!skillName.trim() || !skillPath.trim()) return; onChange({ ...manifest, skills: [...manifest.skills.filter((skill) => skill.name !== skillName.trim()), { name: skillName.trim(), path: skillPath.trim(), targets: [] }] }); setSkillName(""); setSkillPath(""); };
  const addConnection = () => { if (!connectionName.trim() || !endpoint.trim()) return; const common = { name: connectionName.trim(), env: {}, allow_tools: [] as string[], targets: [] as AgentKind[] }; const connection: ConnectionDefinition = transport === "stdio" ? { ...common, transport, command: endpoint.trim(), args: [] } : { ...common, transport, url: endpoint.trim() }; onChange({ ...manifest, connections: [...manifest.connections.filter((item) => item.name !== connection.name), connection] }); setConnectionName(""); setEndpoint(""); };
  const tabs: Array<[WorkspaceAssetSection, string, number]> = [["instructions", "assets.instructions", manifest.instructions.shared.trim() ? 1 : 0], ["skills", "assets.skills", manifest.skills.length], ["mcp", "MCP", manifest.connections.length], ["native", "assets.nativeAssets", nativeAssets.length]];
  return <div className="stack workspace-assets"><Tabs value={section} onValueChange={(value) => onSection(value as WorkspaceAssetSection)}><TabsList className="section-tabs workspace-asset-tabs" variant="line" aria-label={tr("nav.assets")}>{tabs.map(([value, label, count]) => <TabsTrigger value={value} key={value}>{label === "MCP" ? label : tr(label)}<em>{count}</em></TabsTrigger>)}</TabsList></Tabs>
    {section === "instructions" && <div className="panel asset-task">{!scan.manifest_exists && <div className="shared-layer-note"><ShieldCheck size={16} /><strong>{tr("assets.sharedLayerEmpty")}</strong></div>}<Label className="instruction-editor">{tr("assets.sharedInstructions")}<Textarea value={manifest.instructions.shared} onChange={(event) => onChange({ ...manifest, instructions: { ...manifest.instructions, shared: event.target.value } })} /></Label></div>}
    {section === "skills" && <div className="panel asset-task"><div className="managed-list">{manifest.skills.map((skill) => <span className="managed-item" key={skill.name}><span><strong>{skill.name}</strong><small>{skill.path}</small></span><Button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, skills: manifest.skills.filter((item) => item.name !== skill.name) })}><X size={13} /></Button></span>)}</div><div className="inline-form"><Input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder={tr("assets.name")} /><Input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder=".agents/skills/name" /><Button className="primary" onClick={addSkill}>{tr("common.add")}</Button></div></div>}
    {section === "mcp" && <div className="panel asset-task"><div className="managed-list">{manifest.connections.map((connection) => <span className="managed-item" key={connection.name}><span><strong>{connection.name}</strong><small>{connection.transport === "stdio" ? connection.command : connection.url}</small></span><Button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, connections: manifest.connections.filter((item) => item.name !== connection.name) })}><X size={13} /></Button></span>)}</div><div className="inline-form connection-form"><Input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder={tr("assets.name")} /><SelectControl value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></SelectControl><Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"} /><Button className="primary" onClick={addConnection}>{tr("common.add")}</Button></div></div>}
    {section === "native" && <div className="panel asset-task"><div className="toolbar"><div className="search"><Search size={16} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("assets.searchPlaceholder")} /></div><span>{tr("overview.nativeAssets", { count: filtered.length })}</span></div><div className="asset-table"><div className="table-row table-head"><span>{tr("assets.asset")}</span><span>{tr("catalog.visibleAgents")}</span><span>{tr("assets.type")}</span><span>{tr("assets.size")}</span></div>{filtered.map((asset) => { const allAgents = asset.agents.map((agent) => agentLabels[agent]).join(" · "); return <div className="table-row" key={asset.id}><span className="asset-name"><FileCode2 size={16} /><div><strong>{asset.path.split("/").pop()}</strong><small>{shortPath(asset.path)}</small></div></span><span className="agent-tags" aria-label={allAgents} title={allAgents}>{asset.agents.map((agent) => <span className="tag" key={agent}>{agentLabels[agent]}</span>)}</span><span><span className="tag">{tr(`status.asset.${asset.kind}`)}</span></span><span>{formatBytes(asset.size)}</span></div>; })}</div></div>}
  </div>;
}

function ContextPage({ project, onOpenInstructions }: { project: string; onOpenInstructions: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("codex"); const [cwd, setCwd] = useState(project); const [preview, setPreview] = useState<ContextPreview>(); const [error, setError] = useState(""); const [resolving, setResolving] = useState(false);
  const requestSequence = useRef(0);
  const run = async () => { const sequence = ++requestSequence.current; setResolving(true); setError(""); try { const next = await api.context(project, cwd, agent); if (sequence === requestSequence.current) setPreview(next); } catch (value) { if (sequence === requestSequence.current) setError(localizeMessage(value)); } finally { if (sequence === requestSequence.current) setResolving(false); } };
  useEffect(() => { const timeout = window.setTimeout(() => { void run(); }, 350); return () => window.clearTimeout(timeout); }, [project, cwd, agent]);
  const empty = preview && !preview.sections.length;
  return <div className={`context-layout${empty ? " is-empty" : ""}`}><div className="panel config-panel"><h2>{tr("context.environment")}</h2><Label>Agent<SelectControl value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</SelectControl></Label><Label>{tr("context.workingDirectory")}<Input value={cwd} onChange={(event) => setCwd(event.target.value)} /></Label><Button className="ghost" onClick={() => void run()} disabled={resolving}><RefreshCw size={14} className={resolving ? "spin" : ""} />{tr("context.resolve")}</Button><div className="separator" /><h3>{tr("context.capabilities")}</h3><Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} /><Pills values={preview?.visible_connections ?? []} empty={tr("context.noConnection")} /></div><div className="panel context-preview"><div className="panel-head"><h2>{tr("context.effective")}</h2>{preview && <span className="badge">{preview.sections.length} {tr("common.sections")}</span>}</div>{error && <div className="alert">{error}</div>}{preview?.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={15} />{contextWarningLabel(warning)}</div>)}{empty && <div className="compact-state"><FileCode2 size={18} /><span>{tr("context.noInstructions")}</span><Button className="ghost" onClick={onOpenInstructions}>{tr("context.openInstructions")}</Button></div>}<div className="timeline">{preview?.sections.map((contextSection, index) => <article key={`${contextSection.source}-${index}`}><span className="step">{index + 1}</span><div><header><strong>{shortPath(contextSection.source)}</strong><span>{contextSection.scope || tr("status.scope.project")}</span></header><Collapsible><CollapsibleTrigger>{tr("context.showContent")}</CollapsibleTrigger><CollapsibleContent><pre>{contextSection.content}</pre></CollapsibleContent></Collapsible></div></article>)}</div>{preview?.approved_memories.length ? <div className="memory-context"><h3>{tr("context.approvedMemory")}</h3>{preview.approved_memories.map((item) => <p key={item}>{item}</p>)}</div> : null}</div></div>;
}

function Changes({ changeSet, origin, launchRequest, onPlanHome, onApplied, onLaunchCompleted, onRejected, onApplyingChange }: { changeSet?: ChangeSet; origin: ChangeSetOrigin; launchRequest?: SessionHandoffLaunchRequest; onPlanHome: () => void; onApplied: (keepLaunchRequest?: boolean) => void | Promise<void>; onLaunchCompleted: () => void; onRejected: () => void; onApplyingChange: (applying: boolean) => void }) {
  const [selected, setSelected] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [homeApproved, setHomeApproved] = useState(false); const [appliedLaunchFailure, setAppliedLaunchFailure] = useState("");
  const applying = useRef(false);
  const active = useRef(true);
  const change = changeSet?.changes[selected];
  const launchSupported = launchRequest?.target_agent === "codex" || launchRequest?.target_agent === "claude-code";
  const targetAgentName = launchRequest ? agentLabels[launchRequest.target_agent] : "";
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => { if (changeSet) setAppliedLaunchFailure(""); }, [changeSet?.id]);
  const runLocked = async (operation: () => Promise<void>) => {
    if (applying.current) return;
    applying.current = true;
    setBusy(true); setError(""); onApplyingChange(true);
    try { await operation(); }
    catch (value) { if (active.current) setError(localizeMessage(value)); }
    finally { applying.current = false; onApplyingChange(false); if (active.current) setBusy(false); }
  };
  if (!changeSet && launchRequest && appliedLaunchFailure) return <div className="panel handoff-launch-result"><CircleAlert size={24} /><div><h2>{tr("handoff.savedLaunchFailed")}</h2><p>{error || appliedLaunchFailure}</p><code>.agentkib/handoffs/{launchRequest.filename}</code></div><Button className="primary" disabled={busy} onClick={() => void runLocked(async () => { await api.launchSessionHandoff(launchRequest); if (!active.current) return; setAppliedLaunchFailure(""); onLaunchCompleted(); })}><ExternalLink size={15} />{tr(busy ? "handoff.opening" : "handoff.retryOpen", { agent: targetAgentName })}</Button></div>;
  if (!changeSet) return <Empty compact icon={GitCompareArrows} title={tr("changes.empty")} text={tr("changes.emptyText")} />;
  const apply = async () => {
    await runLocked(async () => { await api.apply(changeSet, homeApproved); if (active.current) await onApplied(false); });
  };
  const applyAndContinue = async () => {
    if (!launchRequest || !launchSupported) return;
    await runLocked(async () => {
      const result = await api.continueSessionHandoff(changeSet, launchRequest);
      if (!active.current) return;
      if (result.status === "launched") {
        await onApplied(false);
      } else {
        setAppliedLaunchFailure(localizeMessage(result.error));
        await onApplied(true);
      }
    });
  };
  const disabled = busy || !changeSet.changes.length || (changeSet.requires_home_approval && !homeApproved);
  return <div className="changes-layout"><div className="panel file-list"><div className="panel-head"><div><h2>ChangeSet</h2><p>{changeSet.id.slice(0, 8)} · {changeSet.changes.length} {tr("common.files")}</p></div></div>{origin === "handoff" && <div className="warning"><CircleAlert size={14} />{tr("handoff.changeSetWarning")}</div>}{changeSet.changes.map((file, index) => <Button variant="bare" size="content" key={file.target} className={index === selected ? "active" : ""} onClick={() => setSelected(index)}><FileCode2 size={16} /><div><strong>{file.target.split("/").pop()}</strong><span>{shortPath(file.target)}</span></div><span className={`risk ${file.risk}`}>{tr(`status.risk.${file.risk}`)}</span></Button>)}{origin === "standard" && <div className="home-toggle"><p>{tr("changes.homeQuestion")}</p><Button className="ghost" onClick={onPlanHome}>{tr("changes.includeHome")}</Button>{changeSet.requires_home_approval && <Label className="home-approval"><Checkbox checked={homeApproved} onCheckedChange={setHomeApproved} />{tr("changes.homeApproval")}</Label>}</div>}</div><div className="panel diff-panel">{change ? <><div className="panel-head"><div><h2>{change.target.split("/").pop()}</h2><p>{change.target} · {tr(`status.scope.${change.scope}`)}</p></div><span className={`risk ${change.risk}`}>{tr(`status.risk.${change.risk}`)}</span></div><Diff before={change.before} after={change.after} /></> : <Empty icon={Check} title={tr("changes.synced")} text={tr("changes.syncedText")} />}{error && <div className="alert">{error}</div>}<div className="apply-bar"><div><ShieldCheck size={17} /><span>{tr("changes.hashValidation")}</span></div><div className="apply-actions"><Button className="ghost" onClick={onRejected} disabled={busy}>{tr("changes.reject")}</Button>{origin === "handoff" && launchSupported && <Button className="ghost" onClick={() => void apply()} disabled={disabled}>{tr("handoff.applyOnly")}</Button>}<Button className="primary" onClick={() => void (origin === "handoff" && launchSupported ? applyAndContinue() : apply())} disabled={disabled}>{origin === "handoff" && launchSupported ? <><ExternalLink size={15} />{tr(busy ? "changes.applying" : "handoff.applyAndContinue", { agent: targetAgentName })}</> : tr(busy ? "changes.applying" : "changes.apply", { count: changeSet.changes.length })}</Button></div></div></div></div>;
}

function MemoryInbox({ project, manifest }: { project: string; manifest: Manifest }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("project_fact"); const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const load = async (searchQuery = query) => { try { setError(""); setRecords(searchQuery.trim() ? await api.searchMemories(project, searchQuery) : await api.memories(project)); } catch (value) { setError(String(value)); } };
  useEffect(() => { void load(); }, [project]);
  const propose = async () => { if (!content.trim()) return; try { await api.proposeMemory(project, content, type); setContent(""); await load(); } catch (value) { setError(String(value)); } };
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { try { await api.reviewMemory(id, status, editedContent); await load(); } catch (value) { setError(String(value)); } };
  return <div className="memory-layout"><div className="panel compose"><span className="eyebrow">{tr("memory.newProposal")}</span><h2>{tr("memory.captureFact")}</h2><p>{tr("memory.approvedDescription")}</p><Label>{tr("memory.type")}<SelectControl value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{["project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation","user_preference"].map((value) => <option key={value} value={value}>{tr(`status.memoryType.${value}`)}</option>)}</SelectControl></Label><Label>{tr("memory.content")}<Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={tr("memory.contentPlaceholder")} /></Label><Button className="primary" onClick={propose}>{tr("memory.submit")}</Button><small>Workspace: {manifest.workspace.id.slice(0, 8)}</small></div><div className="panel inbox"><div className="panel-head"><div><h2>{tr("memory.inbox")}</h2><p>{query.trim() ? tr("memory.approvedSearchOnly") : tr("memory.pendingCount", { count: records.filter((r) => r.status === "pending").length })}</p></div><div className="memory-search"><Search size={15} /><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder={tr("memory.searchPlaceholder")} /><Button className="ghost" onClick={() => void load()}>{tr("common.search")}</Button>{query && <Button className="link" onClick={() => { setQuery(""); void load(""); }}>{tr("common.clear")}</Button>}</div></div>{error && <div className="alert">{error}</div>}<div className="memory-list">{records.map((record) => <MemoryCard key={record.id} record={record} onReview={review} />)}{!records.length && <Empty icon={Brain} title={query.trim() ? tr("memory.noSearchMatch") : tr("memory.empty")} text={query.trim() ? tr("memory.noSearchMatchText") : tr("memory.workspaceEmptyText")} />}</div></div></div>;
}

function MemoryCard({ record, onReview }: { record: MemoryRecord; onReview: (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  return <article><div><span className={`status ${record.status}`}>{tr(`status.memory.${record.status}`)}</span><span className="tag">{tr(`status.memoryType.${record.memory_type}`)}</span><time>{formatDateTime(record.created_at)}</time></div>{editing ? <Textarea className="memory-edit" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p>{record.content}</p>}{record.source_agent && <small>{tr("memory.source", { source: record.source_agent })}</small>}{record.status === "pending" && <footer><Button className="approve" onClick={() => onReview(record.id, "approved", editing ? draft : undefined)}><Check size={15} />{editing ? tr("memory.saveApprove") : tr("common.approve")}</Button><Button className="ghost" onClick={() => setEditing((value) => !value)}>{editing ? <X size={14} /> : <Pencil size={14} />}{editing ? tr("memory.cancelEdit") : tr("common.edit")}</Button><Button className="reject" onClick={() => onReview(record.id, "rejected")}>{tr("common.reject")}</Button></footer>}{record.status === "approved" && <footer><Button className="reject" onClick={() => onReview(record.id, "invalidated")}>{tr("memory.invalidate")}</Button></footer>}</article>;
}

function SettingsPage({ runtime, manifest, onManifestChange, onCloseBehaviorChanged, onLocaleChanged }: { runtime?: RuntimeInfo; manifest: Manifest; onManifestChange: (manifest: Manifest) => void; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>; onLocaleChanged: (runtime: RuntimeInfo) => void }) {
  const setAdapterEnabled = (agent: AgentKind, enabled: boolean) => onManifestChange({ ...manifest, adapters: { ...manifest.adapters, [agent]: { enabled, generated_hashes: manifest.adapters[agent]?.generated_hashes ?? {} } } });
  const systemTray = usesSystemTrayWording(buildPlatform);
  return <div className="settings-grid"><LanguageSetting runtime={runtime} onChanged={onLocaleChanged} /><div className="panel setting-card"><div className="setting-icon"><PlugZap /></div><div><h2>AgentKib MCP Hub</h2><p>{tr(systemTray ? "settings.mcpDescriptionSystemTray" : "settings.mcpDescription")}</p><code>{runtime?.mcp_hub ? `127.0.0.1:${runtime.mcp_hub.port}` : "—"}</code></div><span className={runtime?.mcp_hub?.running ? "ready" : "status rejected"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span></div><div className="panel setting-card"><div className="setting-icon"><Activity /></div><div><h2>{tr("settings.closeBehavior")}</h2><p>{runtime?.tray_available === false ? tr("settings.trayUnavailable") : tr(systemTray ? "settings.closeBehaviorWorkspaceDescriptionSystemTray" : "settings.closeBehaviorWorkspaceDescription")}</p></div><CloseBehaviorSelect value={runtime?.close_behavior} trayAvailable={runtime?.tray_available !== false} onChange={onCloseBehaviorChanged} /></div><div className="panel setting-card"><div className="setting-icon"><ShieldCheck /></div><div><h2>{tr("settings.localData")}</h2><p>{tr("settings.localDataWorkspaceDescription")}</p><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />{tr("common.localOnly")}</span></div><div className="panel adapter-settings"><div className="panel-head"><div><h2>{tr("settings.adapters")}</h2><p>{tr("settings.adaptersDescription")}</p></div></div><div className="adapter-toggle-grid">{writableAgentKinds.map((agent) => <Label key={agent}><AgentIcon agent={agent} /><span><strong>{agentLabels[agent]}</strong><small>{tr(manifest.adapters[agent]?.enabled === false ? "common.disabled" : "common.enabled")}</small></span><Switch checked={manifest.adapters[agent]?.enabled !== false} onCheckedChange={(checked) => setAdapterEnabled(agent, checked)} /></Label>)}</div></div><div className="panel paths"><h2>{tr("settings.agentHomes")}</h2><p>{tr("settings.agentHomesDescription")}</p><dl><div><dt>OpenClaw</dt><dd>{runtime?.openclaw_config ?? tr("settings.homeNotFound")}</dd></div><div><dt>Hermes</dt><dd>{runtime?.hermes_config ?? tr("settings.homeNotFound")}</dd></div></dl></div></div>;
}

function Pills({ values, empty }: { values: string[]; empty: string }) { return <div className="pills">{values.length ? values.map((value) => <span key={value}>{value}</span>) : <small>{empty}</small>}</div>; }
function Empty({ icon: Icon, title, text, compact = false }: { icon: typeof Brain; title: string; text: string; compact?: boolean }) { return <div className={`empty${compact ? " compact" : ""}`}><Icon size={28} /><h3>{title}</h3>{text && <p>{text}</p>}</div>; }
function Diff({ before, after }: { before: string; after: string }) { return <pre className="diff">{diffLines(before, after).map((line, index) => <div className={line.type} key={`${index}-${line.content}`}><span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>{line.content || " "}</div>)}</pre>; }
function shortPath(path: string) { const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }
function localizedAssetSummary(asset: CatalogAsset | CatalogAssetGroup | WorkspaceScan["assets"][number]) { return asset.summary_key ? tr(asset.summary_key, { ...asset.summary_params, defaultValue: asset.summary }) : asset.summary; }
function contextWarningLabel(warning: string) {
  if (warning === "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules") return tr("context.deepseekCustomRules");
  if (warning === "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import") return tr("context.deepseekClaudeImport");
  return warning;
}
function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓库 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function formatCompact(value: number) { return formatCompactNumber(value); }
function workspaceStatusLabel(status: WorkspaceSummary["status"]) { return tr(`status.workspace.${status}`); }
function relativeTime(value: string) { return formatRelativeTime(value); }
