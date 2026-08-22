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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, Award, Bot, Boxes, Brain, Check, ChevronRight, CircleAlert, Code2, Copy, ExternalLink, FileCode2, FolderGit2, Gauge, GitCommitHorizontal, GitCompareArrows, History, Home, LayoutDashboard, Library, MessageSquareText, MoreHorizontal, Pencil, PlugZap, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../core/api";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../components/AgentIcon";
import { AppSidebar, type SidebarEntry } from "../components/AppSidebar";
import { SettingsSidebar, type SettingsSection } from "../components/SettingsSidebar";
import { WindowToolbar } from "../components/WindowToolbar";
import { ObsidianSettingsCard, WorkspaceObsidianCard } from "../components/ObsidianIntegration";
import { RemoteGatewaysSettings } from "../components/RemoteGateways";
import { QuotaDiagnostics } from "../components/QuotaDiagnostics";
import { WorkspaceStoragePage } from "../components/WorkspaceStoragePage";
import { WorkspaceSessionsPage } from "../components/WorkspaceSessionsPage";
import { WorkspaceDoctorPage } from "../components/WorkspaceDoctorPage";
import { WorkspaceGitPage, type GitSubview } from "../components/WorkspaceGitPage";
import { WorkspaceOpenWith } from "../components/WorkspaceOpenWith";
import { AssetCatalogPage } from "../components/AssetCatalogPage";
import { useAppDialogs } from "../components/AppDialogProvider";
import type { InsightsSection } from "../components/InsightsPage";
import { groupCatalogAssets, groupWorkspaceAssets, workspaceAssetCounts, type CatalogAssetGroup } from "../core/catalog";
import { diffLines } from "../core/diff";
import { changeLocale, formatCompactNumber, formatDateTime, formatRelativeTime, localizeMessage, tr } from "../core/i18n";
import { applyTheme } from "../core/theme";
import { normalizePlatform, primaryShortcutModifier, usesSystemTrayWording } from "../core/platform";
import type { ActivityRecord, AgentInstallation, AgentKind, AppIconPreference, AppMenuCommandRequest, AppNavigationRequest, CatalogAsset, ChangeSet, CloseBehavior, ConnectionDefinition, ContextDoctorSummary, ContextPreview, DiscoveryReport, EffectiveTheme, ExcludedWorkspace, GitIdentitySummary, InsightsStatus, InsightsSummary, LocalePreference, Manifest, McpInstallation, McpRegistryEntry, McpRuntimeStatus, McpServerConfig, MemoryRecord, MemoryType, QuotaCollectorStatus, QuotaWindowSelector, RefreshJobStatus, RefreshKind, RemoteGatewaySummary, RuntimeInfo, ScanRoot, SessionHandoffLaunchRequest, ThemePreference, WorkspaceScan, WorkspaceSummary } from "../core/types";

type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
type AppMode = "main" | "settings";
type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
type WorkspaceAssetSection = "instructions" | "skills" | "mcp" | "native";
type WorkspaceView = "list" | "storage";
type ChangeSetOrigin = "standard" | "doctor" | "handoff";

const AgentsPageLazy = lazy(() => import("../components/AgentsPage").then(({ AgentsPage }) => ({ default: AgentsPage })));
const InsightsPageLazy = lazy(() => import("../components/InsightsPage").then(({ InsightsPage }) => ({ default: InsightsPage })));
const QuotaPageLazy = lazy(() => import("../components/QuotaPage").then(({ QuotaPage }) => ({ default: QuotaPage })));
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
  const [isFullscreen, setIsFullscreen] = useState(false);
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
    if (appPlatform !== "macos") return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (!disposed) setIsFullscreen(fullscreen);
      } catch {
        if (!disposed) setIsFullscreen(false);
      }
    };

    void syncFullscreen();
    void appWindow.onResized(() => { void syncFullscreen(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
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
  const insightsRefreshing = refreshJobs.some((job) => job.kind === "insights" && (job.state === "queued" || job.state === "running"));

  const navigation = globalNav.map((entry) => entry.id === "catalog" ? { ...entry, badge: globalMemories.filter((item) => item.status === "pending").length } : entry);
  const shellClass = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden !grid-cols-[var(--sidebar-width)_minmax(0,1fr)] !grid-rows-[minmax(0,1fr)] !transition-[grid-template-columns] !duration-150",
    sidebarCollapsed && "sidebar-collapsed !grid-cols-[0_minmax(0,1fr)]",
  );
  const mainClass = "!col-start-2 !row-start-1 !min-h-0 !min-w-0 !h-full !overflow-x-hidden !overflow-y-auto !overscroll-contain !text-sm";
  const pageHeaderClass = cn(
    "page-header !sticky !top-0 !z-10 !flex !min-h-[58px] !h-[58px] !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
    sidebarCollapsed ? "!pl-[132px]" : "!pl-7",
  );
  const contentClass = "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";
  if (appMode === "settings") return (
    <div className={shellClass}>
      <WindowToolbar platform={appPlatform} fullscreen={isFullscreen} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <SettingsSidebar active={settingsSection} collapsed={sidebarCollapsed} platform={appPlatform} onSelect={setSettingsSection} onBack={() => setAppMode("main")} />
      {!sidebarCollapsed && <Button className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main className={cn(mainClass, `settings-section-${settingsSection}`)}>
        <header className={pageHeaderClass} data-tauri-drag-region />
        {message && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={17} />{message}</div>}
        <section className={cn("mx-auto grid w-full max-w-[1180px] gap-5 px-7 pb-10 pt-[22px] max-[900px]:px-[18px]", settingsSection === "general" && "pt-4")}>
          <GlobalSettings section={settingsSection} runtime={runtime} workspaces={workspaces} discovery={discovery} insightsStatus={insightsStatus} quotaStatus={quotaStatus} remoteGateways={remoteGateways} scanRoots={scanRoots} excluded={excluded} activity={activity} onAddRoot={addScanRootFromDialog} onRemoveRoot={async (id) => { await api.removeScanRoot(id); await loadGlobal(); await refreshDiscovery(); }} onRestore={async (path) => { await api.restoreExcludedWorkspace(path); await loadGlobal(); await refreshDiscovery(); }} onCloseBehaviorChanged={async (behavior) => { await api.setCloseBehavior(behavior); await loadGlobal(); }} onLocaleChanged={setRuntime} onRemoteGatewaysChanged={loadGlobal} />
        </section>
      </main>
    </div>
  );
  if (selectedWorkspace && project && scan) return (
    <div className={shellClass}>
      <WindowToolbar platform={appPlatform} fullscreen={isFullscreen} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <AppSidebar active="workspaces" entries={navigation} collapsed={sidebarCollapsed} platform={appPlatform} onNavigate={navigateGlobal} onSettings={openSettings} />
      {!sidebarCollapsed && <Button className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main className={mainClass}>
        <header className={pageHeaderClass} data-tauri-drag-region />
        {message && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={17} />{message}</div>}
        <div className={cn(contentClass, "grid gap-4 pt-5")}>
          <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground text-background"><FolderGit2 size={21} /></span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{selectedWorkspace.name}</h1>
                  <Badge variant={selectedWorkspace.status === "attention" ? "destructive" : "secondary"}>{workspaceStatusLabel(selectedWorkspace.status)}</Badge>
                </div>
                <button type="button" className="mt-1 flex max-w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(selectedWorkspace.path)} title={tr("workspace.copyPath")}>
                  <code className="truncate">{selectedWorkspace.path}</code><Copy size={13} className="shrink-0" />
                </button>
              </div>
            </div>
            <WorkspaceActions workspace={selectedWorkspace} onError={setMessage} onScan={() => load(project, manifest)} busy={busy} onReview={() => plan(false)} reviewDisabled={busy || !hasUnsavedDraft} />
          </section>
          <nav className="rounded-xl border border-border/70 bg-card px-2 shadow-sm" aria-label={selectedWorkspace.name}>
            <Tabs value={page} onValueChange={(id) => { if (id !== "git") setGitSubview(undefined); setPage(id as Page); }}>
              <TabsList className="w-full justify-start gap-1 overflow-x-auto rounded-none border-0 bg-transparent px-0" variant="line">
                {workspaceTabs.map(([id, label, Icon]) => <TabsTrigger className="min-h-11 flex-none rounded-none px-3 text-xs sm:text-sm" key={id} value={id}><Icon size={15} />{tr(label)}{id === "changes" && changeSet?.changes.length ? <em>{changeSet.changes.length}</em> : null}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </nav>
          <section className={cn("min-w-0", page === "git" && "min-h-[calc(100vh-170px)]")}>
          {page === "overview" && manifest && <Overview workspace={selectedWorkspace} scan={scan} manifest={manifest} />}
          {page === "sessions" && <WorkspaceSessionsPage workspace={selectedWorkspace} enabled={runtime?.session_index_enabled !== false} targetAgents={Array.from(new Set([...scan.agents.filter((agent) => agent.detected).map((agent) => agent.agent), ...installations.filter((agent) => agent.installed).map((agent) => agent.agent)]))} onRuntimeChanged={async (enabled) => { setRuntime(await api.setSessionIndexEnabled(enabled)); }} onHandoffPlanned={(planned) => { setChangeSet(planned.change_set); setHandoffLaunchRequest(planned.launch_request); setChangeSetOrigin("handoff"); setPage("changes"); }} />}
          {page === "git" && <WorkspaceGitPage workspace={selectedWorkspace} subview={gitSubview} onSubviewChange={setGitSubview} />}
          {page === "assets" && manifest && <Assets section={workspaceAssetSection} onSection={setWorkspaceAssetSection} scan={scan} manifest={manifest} onChange={setManifest} />}
          {page === "context" && <ContextPage project={project} onOpenInstructions={() => { setWorkspaceAssetSection("instructions"); setPage("assets"); }} />}
          {page === "doctor" && <WorkspaceDoctorPage workspace={selectedWorkspace} onRepair={planDoctorRepairs} />}
          {page === "changes" && <Changes changeSet={changeSet} origin={changeSetOrigin} launchRequest={handoffLaunchRequest} onPlanHome={() => plan(true)} onApplied={async (keepLaunchRequest) => { setChangeSet(undefined); if (!keepLaunchRequest) setHandoffLaunchRequest(undefined); await load(); await loadGlobal(); }} onLaunchCompleted={() => setHandoffLaunchRequest(undefined)} onRejected={() => { setChangeSet(undefined); setHandoffLaunchRequest(undefined); }} onApplyingChange={setApplyingChanges} />}
          </section>
        </div>
      </main>
    </div>
  );

  const discoveryFailure = refreshJobs.find((job) => job.kind === "discovery" && job.state === "failed");
  return <div className={shellClass}><WindowToolbar platform={appPlatform} fullscreen={isFullscreen} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} /><AppSidebar active={globalPage} entries={navigation} collapsed={sidebarCollapsed} platform={appPlatform} onNavigate={navigateGlobal} onSettings={openSettings} />{!sidebarCollapsed && <Button className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}<main className={mainClass}><header className={pageHeaderClass} data-tauri-drag-region />{message && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={17} />{message}</div>}{globalPage === "workspaces" && discoveryFailure?.error && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={17} />{discoveryFailure.error}</div>}<section className={cn(contentClass, "")}>
    {globalPage === "home" && <GlobalHome workspaces={workspaces} doctorSummaries={doctorSummaries} installations={installations} memories={globalMemories} discovery={discovery} activity={activity} insights={insightsSummary} uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length} assetCounts={assetCounts} onShowInsights={() => setGlobalPage("insights")} onShowWorkspaces={() => setGlobalPage("workspaces")} onShowAgents={() => setGlobalPage("agents")} onOpen={openWorkspace} onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")} onOpenAssets={(section) => { setAssetSection(section); setGlobalPage("catalog"); }} onAddRoot={async () => { await addScanRootFromDialog(); }} />}
    {globalPage === "workspaces" && <WorkspacesPage view={workspaceView} storageJob={refreshJobs.find((job) => job.kind === "storage")} workspaces={workspaces} assetCounts={assetCounts} discoveryRefreshing={discoveryRefreshing} onAddWorkspace={() => void selectProject()} onViewChange={setWorkspaceView} onOpen={openWorkspace} onRefreshDiscovery={refreshDiscovery} onRefreshWorkspace={async (id) => { await api.refreshWorkspace(id); await loadGlobal(); }} onExclude={async (id) => { if (!await dialogs.confirm({ description: tr("workspace.ignoreConfirm"), tone: "destructive" })) return; await api.excludeWorkspace(id); await loadGlobal(); }} />}
    {globalPage === "agents" && <DeferredPage><AgentsPageLazy installations={installations} assets={catalog.filter((asset) => asset.scope === "agent-home")} workspaces={workspaces} remoteGateways={remoteGateways} insightsStatus={insightsStatus} onOpen={openWorkspace} /></DeferredPage>}
    {globalPage === "catalog" && <GlobalAssetsPage section={assetSection} onSection={setAssetSection} assets={catalog} workspaces={workspaces} memories={globalMemories} runtime={runtime} onReload={loadGlobal} onRuntimeChanged={setRuntime} onOpen={(id) => { const workspace = workspaces.find((item) => item.id === id); if (workspace) void openWorkspace(workspace); }} onMigrationPlanned={async (workspacePath, planned) => { const workspace = workspaces.find((item) => item.path === workspacePath); if (!workspace) return; await openWorkspace(workspace); setChangeSet(planned); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setPage("changes"); }} />}
    {globalPage === "quota" && <DeferredPage><QuotaPageLazy initialProvider={quotaProvider} initialWindow={quotaWindow} configurePopoverRequest={quotaConfigureRequest} /></DeferredPage>}
    {globalPage === "insights" && <div className="relative grid gap-5 pb-8" data-view={insightsSection}><div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3 shadow-sm"><Tabs value={insightsSection} onValueChange={(section) => setInsightsSection(section as InsightsSection)} className="min-w-0"><TabsList className="w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent pr-2" variant="line" aria-label={tr("nav.insights")}>{(["overview", "tokens", "commits", "milestones", "sources"] as InsightsSection[]).map((section) => <TabsTrigger className="flex-none rounded-none px-3" key={section} value={section}>{tr(`insights.section.${section}`)}</TabsTrigger>)}</TabsList></Tabs><Button variant="outline" size="icon" className="size-9 shrink-0 rounded-xl" aria-label={tr("insights.refresh")} title={tr("insights.refresh")} onClick={() => void refreshCurrentView()} disabled={insightsRefreshing}><RefreshCw size={15} className={insightsRefreshing ? "animate-spin" : ""} /></Button></div><DeferredPage><InsightsPageLazy section={insightsSection} workspaces={workspaces} onSummary={setInsightsSummary} /></DeferredPage></div>}
  </section></main></div>;

  async function addScanRootFromDialog() { const selected = await open({ directory: true, multiple: false, title: tr("dialog.addScanRoot") }); if (typeof selected === "string") { await api.addScanRoot(selected, 5); await loadGlobal(); await refreshDiscovery(); } }
}

function DeferredPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingState label={tr("common.loading")} />}>{children}</Suspense>;
}

function WorkspaceActions({ workspace, onError, onScan, busy, onReview, reviewDisabled }: { workspace: WorkspaceSummary; onError: (message: string) => void; onScan: () => void | Promise<void>; busy: boolean; onReview: () => void | Promise<void>; reviewDisabled: boolean }) {
  return <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
    {workspace.status === "attention" && <Badge variant="outline" className="mr-1 border-amber-500/30 bg-amber-500/5 text-amber-700">{workspaceStatusLabel("attention")}</Badge>}
    <WorkspaceOpenWith workspace={workspace} onError={onError} />
    <DropdownMenu><DropdownMenuTrigger className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title={tr("common.moreActions")} aria-label={tr("common.moreActions")}><MoreHorizontal size={16} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(workspace.path)}><Copy size={13} />{tr("workspace.copyPath")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <Button variant="outline" size="icon" className="size-9 rounded-lg" title={tr("common.scan")} aria-label={tr("common.scan")} onClick={() => void onScan()} disabled={busy}><RefreshCw size={15} className={busy ? "animate-spin" : ""} /></Button>
    <Button className="h-9 rounded-lg px-3" onClick={() => void onReview()} disabled={reviewDisabled}><GitCompareArrows size={15} />{tr("workspace.reviewChanges")}</Button>
  </div>;
}

function GlobalHome({ workspaces, doctorSummaries, installations, memories, discovery, activity, insights, uniqueAssetCount, assetCounts, onShowInsights, onShowWorkspaces, onShowAgents, onOpen, onOpenDoctor, onOpenAssets, onAddRoot }: { workspaces: WorkspaceSummary[]; doctorSummaries: Record<string, ContextDoctorSummary>; installations: AgentInstallation[]; memories: MemoryRecord[]; discovery?: DiscoveryReport; activity: ActivityRecord[]; insights?: InsightsSummary; uniqueAssetCount: number; assetCounts: Map<string, number>; onShowInsights: () => void; onShowWorkspaces: () => void; onShowAgents: () => void; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>; onOpenAssets: (section: AssetSection) => void; onAddRoot: () => Promise<void> }) {
  const attention = workspaces.filter((item) => item.status === "attention" || (doctorSummaries[item.id]?.error_count ?? 0) + (doctorSummaries[item.id]?.warning_count ?? 0) > 0);
  const pending = memories.filter((item) => item.status === "pending").length;
  const doctorIssueCount = Object.values(doctorSummaries).reduce((total, summary) => total + summary.error_count + summary.warning_count, 0);
  const legacyAttentionCount = attention.filter((workspace) => !doctorSummaries[workspace.id]).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const importantActions = new Set(["changeset.apply", "changeset.apply_failed", "memory.propose", "memory.review", "workspace.exclude"]);
  const importantActivity = activity.filter((item) => importantActions.has(item.action)).slice(0, 5);
  const installedAgentCount = installations.filter((item) => item.installed).length;
  const metrics = [
    { label: tr("home.workspaceMetric"), value: workspaces.length, icon: FolderGit2, onClick: onShowWorkspaces },
    { label: tr("home.assetMetric"), value: uniqueAssetCount, icon: Library, onClick: () => onOpenAssets("instructions") },
    { label: tr("home.installedAgents"), value: installedAgentCount, icon: Bot, onClick: onShowAgents },
    { label: tr("home.pendingMemory"), value: pending, icon: Brain, onClick: () => onOpenAssets("memory") },
  ];
  const insightCard = insights && <Button variant="bare" size="content" className="group relative block w-full overflow-hidden rounded-2xl bg-foreground p-5 text-left text-background shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-foreground active:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring" onClick={onShowInsights}><div className="absolute -right-8 -top-10 size-32 rounded-full border-[18px] border-background/10" /><div className="relative flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-background/10"><Award size={20} /></span><span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold tracking-[.14em] text-background/60">{tr("home.journey")}</span>{insights.total_tokens || insights.my_commits ? <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold"><strong>{formatCompact(insights.total_tokens)} Token</strong><strong>{insights.my_commits} {tr("insights.myCommits")}</strong></span> : <strong className="mt-2 block text-sm">{tr("home.insightsEmpty")}</strong>}<span className="mt-2 block text-xs leading-5 text-background/65">{tr("home.streak", { active: insights.active_days, current: insights.current_streak, longest: insights.longest_streak })}</span></span><ChevronRight className="mt-1 shrink-0 text-background/70 transition-transform group-hover:translate-x-0.5" size={17} /></div></Button>;
  return <div className="grid gap-6">
    <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card px-6 py-6 shadow-[0_18px_50px_-34px_rgba(15,23,42,.4)] md:px-7 md:py-7">
      <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full border-[32px] border-primary/[0.035]" />
      <div className="relative grid gap-6">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(({ label, value, icon: Icon, onClick }) => <Button variant="bare" size="content" className="group flex min-w-0 items-start gap-3 rounded-xl border border-border-subtle bg-muted/20 p-4 text-left transition-[transform,border-color,background-color] hover:-translate-y-0.5 hover:border-border hover:bg-muted/45" key={label} onClick={onClick}><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground"><Icon size={17} /></span><span className="min-w-0"><span className="block truncate text-xs font-medium text-muted-foreground">{label}</span><strong className="mt-1 block text-xl font-semibold tabular-nums tracking-[-.03em] text-foreground">{value}</strong></span></Button>)}
        </div>
      </div>
    </section>
    {issueCount > 0 ? <Card className="overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/[0.045] shadow-none"><div className="flex items-center justify-between gap-3 border-b border-amber-500/20 px-5 py-3.5"><span className="flex items-center gap-2 text-sm"><CircleAlert size={17} className="text-amber-600" /><strong>{tr("home.needsAttention")}</strong></span><Badge variant="secondary" className="bg-background/70 tabular-nums">{issueCount}</Badge></div><div className="grid divide-y divide-amber-500/15">{attention.slice(0, 4).map((workspace) => { const doctorCount = (doctorSummaries[workspace.id]?.error_count ?? 0) + (doctorSummaries[workspace.id]?.warning_count ?? 0); return <Button variant="bare" size="content" className="flex items-center gap-3 px-5 py-3.5 text-left hover:bg-amber-500/[0.08]" key={workspace.id} onClick={() => void onOpenDoctor(workspace)}><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700"><ShieldCheck size={15} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{workspace.name}</strong><small className="mt-0.5 block text-xs text-muted-foreground">{tr("home.workspaceWarnings", { count: doctorCount || workspace.warning_count })}</small></span><ChevronRight size={15} className="text-muted-foreground" /></Button>; })}{pending > 0 && <Button variant="bare" size="content" className="flex items-center gap-3 px-5 py-3.5 text-left hover:bg-amber-500/[0.08]" onClick={() => onOpenAssets("memory")}><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700"><Brain size={15} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{tr("home.pendingMemory")}</strong><small className="mt-0.5 block text-xs text-muted-foreground">{tr("home.pendingMemoryDetail", { count: pending })}</small></span><ChevronRight size={15} className="text-muted-foreground" /></Button>}</div></Card> : <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.045] px-5 py-3.5 text-sm"><span className="grid size-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700"><Check size={17} /></span><span><strong className="block">{tr("home.allClear")}</strong><small className="mt-0.5 block text-xs text-muted-foreground">{tr("home.allClearDescription")}</small></span></div>}
    {!workspaces.length ? <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.45fr)]"><Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-2xl border-dashed bg-card p-8 text-center"><span className="grid size-12 place-items-center rounded-2xl bg-primary/8 text-primary"><FolderGit2 size={24} /></span><h2 className="text-lg font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2><p className="max-w-md text-sm leading-6 text-muted-foreground">{tr("home.emptyText")}</p><Button onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</Button></Card>{insightCard}</div> : <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]"><Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm"><CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border-subtle px-5 py-4"><div><h2 className="text-base font-semibold tracking-[-.02em]">{tr("home.recentWorkspaces")}</h2><p className="mt-1 text-xs text-muted-foreground">{tr("home.workspaceSources")}</p></div><Badge variant="outline" className="shrink-0">{discovery ? tr("home.updated", { time: relativeTime(discovery.finished_at) }) : tr("home.discovering")}</Badge></CardHeader><CardContent className="p-0"><div className="grid">{workspaces.slice(0, 5).map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} />)}</div><Button variant="link" className="mx-5 my-3 px-0 text-xs text-muted-foreground" onClick={onShowWorkspaces}>{tr("nav.workspaces")}<ChevronRight size={13} /></Button></CardContent></Card><div className="grid content-start gap-4">{insightCard}{importantActivity.length > 0 ? <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm"><CardHeader className="border-b border-border-subtle px-5 py-4"><h2 className="text-base font-semibold tracking-[-.02em]">{tr("home.recentActivity")}</h2><p className="mt-1 text-xs text-muted-foreground">{tr("home.activityDescription")}</p></CardHeader><CardContent className="grid gap-2 p-3">{importantActivity.map((item) => <ActivityRow key={item.id} record={item} />)}</CardContent></Card> : <Card className="rounded-2xl border-dashed bg-card p-5"><div className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><History size={15} /></span><span><strong className="block text-sm">{tr("home.noImportantActivity")}</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">{tr("home.noImportantActivityText")}</p></span></div></Card>}</div></div>}
  </div>;
}

function WorkspacesPage({ view, storageJob, workspaces, assetCounts, discoveryRefreshing, onAddWorkspace, onViewChange, onOpen, onRefreshDiscovery, onRefreshWorkspace, onExclude }: { view: WorkspaceView; storageJob?: RefreshJobStatus; workspaces: WorkspaceSummary[]; assetCounts: Map<string, number>; discoveryRefreshing: boolean; onAddWorkspace: () => void; onViewChange: (view: WorkspaceView) => void; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onRefreshDiscovery: () => Promise<void>; onRefreshWorkspace: (id: string) => Promise<void>; onExclude: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all"); const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const filtered = workspaces.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || item.status === status) && (agent === "all" || item.sources.some((source) => source.agent === agent)));
  const groups = useMemo(() => { const values = new Map<string, WorkspaceSummary[]>(); for (const item of filtered) { const key = item.repository_group_id ?? `workspace:${item.id}`; values.set(key, [...(values.get(key) ?? []), item]); } return [...values.values()]; }, [filtered]);
  const attentionCount = workspaces.filter((item) => item.status === "attention").length;
  const assetTotal = workspaces.reduce((total, item) => total + (assetCounts.get(item.id) ?? item.asset_count), 0);
  const pageStats = [{ label: tr("nav.workspaces"), value: workspaces.length, icon: FolderGit2 }, { label: workspaceStatusLabel("attention"), value: attentionCount, icon: CircleAlert }, { label: tr("common.assets"), value: assetTotal, icon: Library }];
  const viewControls = <div className="flex flex-wrap items-center gap-2">
    <ToggleGroup spacing={0} variant="outline" size="sm" className="shrink-0" value={[view]} onValueChange={(values) => { const value = values[0]; if (value === "list" || value === "storage") onViewChange(value); }} aria-label={tr("workspace.viewLabel")}>
      <ToggleGroupItem value="list" className="min-w-[68px]">{tr("workspace.view.list")}</ToggleGroupItem>
      <ToggleGroupItem value="storage" className="min-w-[68px]">{tr("workspace.view.storage")}</ToggleGroupItem>
    </ToggleGroup>
    {view === "list" && <Button className="h-9 rounded-lg px-3.5" onClick={onAddWorkspace}><FolderGit2 size={15} />{tr("workspace.addManually")}</Button>}
  </div>;
  const pageIntro = <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
    <div className="flex min-w-0 items-center gap-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground text-background"><FolderGit2 size={20} /></span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-[-.03em] text-foreground">{tr("nav.workspaces")}</h1><Badge variant="secondary" className="rounded-md px-2 tabular-nums">{workspaces.length}</Badge></div>
        <span className="mt-1 block text-xs text-muted-foreground">{tr("workspace.resultCount", { count: filtered.length })}</span>
      </div>
    </div>
    {viewControls}
  </section>;
  const filterBar = <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
    <CardContent className="grid gap-3 p-4 sm:p-5">
      <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-center">
        <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_10%,transparent)]">
          <Search size={16} />
          <Input className="!h-8 !border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0" aria-label={tr("workspace.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("workspace.searchPlaceholder")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SelectControl aria-label={tr("workspace.allAgents")} className="h-10 min-w-[146px] rounded-xl border-input bg-background px-3 text-foreground shadow-xs hover:bg-muted/40 max-[520px]:min-w-0 max-[520px]:flex-1" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}>
            <option value="all">{tr("workspace.allAgents")}</option>
            {Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </SelectControl>
          <SelectControl aria-label={tr("workspace.allStatuses")} className="h-10 min-w-[146px] rounded-xl border-input bg-background px-3 text-foreground shadow-xs hover:bg-muted/40 max-[520px]:min-w-0 max-[520px]:flex-1" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">{tr("workspace.allStatuses")}</option>
            <option value="healthy">{workspaceStatusLabel("healthy")}</option>
            <option value="attention">{workspaceStatusLabel("attention")}</option>
          </SelectControl>
          <Badge variant="secondary" className="h-8 rounded-lg px-2.5 text-xs tabular-nums text-muted-foreground">{tr("workspace.resultCount", { count: filtered.length })}</Badge>
          <Button variant="outline" size="icon" className="size-10 rounded-xl" title={tr("workspace.refreshDiscovery")} aria-label={tr("workspace.refreshDiscovery")} aria-busy={discoveryRefreshing} onClick={() => void onRefreshDiscovery()} disabled={discoveryRefreshing}><RefreshCw size={15} className={discoveryRefreshing ? "animate-spin" : ""} /></Button>
        </div>
      </div>
    </CardContent>
  </Card>;
  if (view === "storage") return <div className="grid gap-5">{pageIntro}<WorkspaceStoragePage workspaces={workspaces} job={storageJob} /></div>;
  return (
    <div className="grid gap-5">
      {pageIntro}
      <div className="grid gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/70 sm:grid-cols-3">
        {pageStats.map(({ label, value, icon: Icon }) => <div className="flex items-center gap-3 bg-card px-4 py-4 sm:px-5" key={label}><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon size={17} /></span><span className="min-w-0"><span className="block truncate text-xs font-medium text-muted-foreground">{label}</span><strong className="mt-1 block text-lg font-semibold tabular-nums tracking-[-.02em] text-foreground">{value}</strong></span></div>)}
      </div>
      {filterBar}
      <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
        <CardContent className="p-0">
          <Table className="min-w-[900px] border-separate border-spacing-0 [&_th]:h-[44px] [&_th]:bg-muted/25 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[.08em] [&_th]:text-muted-foreground [&_th]:whitespace-nowrap [&_th:first-child]:pl-5 [&_td]:h-[70px] [&_td]:text-sm [&_tr]:transition-colors">
            <TableHeader><TableRow className="border-border-subtle hover:bg-transparent"><TableHead className="w-[44%]">{tr("workspace.projectColumn")}</TableHead><TableHead>{tr("workspace.agentColumn")}</TableHead><TableHead>{tr("workspace.assetsColumn")}</TableHead><TableHead>{tr("workspace.activityColumn")}</TableHead><TableHead className="w-16" /></TableRow></TableHeader>
            <TableBody>
              {groups.flatMap((group) => {
                const grouped = group.length > 1;
                const rows = group.map((workspace) => <WorkspaceTableRow key={workspace.id} workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} onRefresh={onRefreshWorkspace} onExclude={onExclude} />);
                return grouped ? [<TableRow className="bg-primary/[0.035] hover:bg-primary/[0.05]" key={`${group[0].id}:group`}><TableCell className="h-[38px] border-t border-border-subtle pl-5 text-xs text-muted-foreground" colSpan={5}><span className="inline-flex items-center"><FolderGit2 className="mr-1.5 text-primary" size={14} /><strong className="mr-2 font-semibold text-foreground">{group[0].name}</strong><span>{tr("workspace.worktrees", { count: group.length })}</span></span></TableCell></TableRow>, ...rows] : rows;
              })}
            </TableBody>
          </Table>
          {!groups.length && <Empty compact icon={FolderGit2} title={tr("workspace.noMatch")} text={tr("workspace.noMatchText")} />}
        </CardContent>
      </Card>
    </div>
  );
}

function WorkspaceTableRow({ workspace, assetCount, onOpen, onRefresh, onExclude }: { workspace: WorkspaceSummary; assetCount?: number; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onRefresh: (id: string) => Promise<void>; onExclude: (id: string) => Promise<void> }) {
  const sourceAgents = workspace.sources.map((source) => source.agent).filter((value): value is AgentKind => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index);
  const agents = sourceAgents.map((value) => agentLabels[value]).join(" · ") || (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return <TableRow className="group transition-colors hover:bg-primary/[0.04] focus-within:bg-primary/[0.06]">
    <TableCell className="pl-[22px]"><Button variant="bare" size="content" className="group/project grid w-full grid-cols-[auto_minmax(0,1fr)] items-center justify-items-start gap-2.5 text-left" aria-label={`${workspace.name} · ${workspace.path}`} onClick={() => void onOpen(workspace)}><span className="grid size-[34px] place-items-center rounded-[9px] border border-border/85 bg-primary/[0.07] text-muted-foreground transition-colors group-hover/project:border-primary/30 group-hover/project:bg-primary/[0.12] group-hover/project:text-foreground" aria-hidden="true"><FolderGit2 size={16} /></span><span className="grid min-w-0 justify-items-start gap-1"><strong className="text-[13px] font-semibold tracking-[-.01em] text-foreground">{workspace.name}</strong><small className="block max-w-[min(520px,38vw)] truncate text-xs text-muted-foreground" title={workspace.path}>{workspace.path}</small></span></Button></TableCell>
    <TableCell><div className="flex items-center gap-1.5" aria-label={agents}>{sourceAgents.length ? sourceAgents.map((value) => <Badge className="rounded-[7px] border-0 bg-primary/[0.08] text-xs font-semibold text-foreground" variant="secondary" key={value}>{agentLabels[value]}</Badge>) : <Badge className="rounded-[7px] border-0 bg-primary/[0.08] text-xs font-semibold text-foreground" variant="secondary">{agents}</Badge>}</div></TableCell>
    <TableCell><strong className={cn("tabular-nums text-foreground", !count && "text-muted-foreground")}>{count}</strong></TableCell>
    <TableCell className="text-muted-foreground">{workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</TableCell>
    <TableCell><div className="flex items-center justify-end gap-2">{workspace.status === "attention" && <Badge className="mr-0.5" variant="destructive">{workspaceStatusLabel("attention")}</Badge>}<DropdownMenu><DropdownMenuTrigger className="inline-flex size-9 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title={tr("common.moreActions")} aria-label={`${workspace.name} · ${tr("common.moreActions")}`}><MoreHorizontal size={15} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void onRefresh(workspace.id)}><RefreshCw size={13} />{tr("common.scan")}</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => void onExclude(workspace.id)}><Trash2 size={13} />{tr("workspace.ignore")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><ChevronRight className="text-muted-foreground opacity-55 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100" size={15} /></div></TableCell>
  </TableRow>;
}

function WorkspaceRow({ workspace, assetCount, onOpen }: { workspace: WorkspaceSummary; assetCount?: number; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  const sourceAgents = workspace.sources.map((source) => source.agent).filter((value): value is AgentKind => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index);
  const agents = sourceAgents.map((value) => agentLabels[value]).join(" · ") || (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return <Button variant="bare" size="content" className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/40" onClick={() => void onOpen(workspace)}><div className="grid size-9 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:bg-muted"><FolderGit2 size={18} /></div><div className="min-w-0"><strong className="block truncate text-sm font-semibold">{workspace.name}</strong><small className="block truncate text-xs text-muted-foreground" title={workspace.path}>{workspace.path}</small><span className="block truncate text-xs text-muted-foreground">{agents} · {tr("workspace.assetCount", { count })} · {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span></div>{workspace.status === "attention" && <span className="text-xs font-medium text-amber-700">{workspaceStatusLabel("attention")}</span>}<ChevronRight className="text-muted-foreground" size={15} /></Button>;
}

function GlobalAssetsPage({ section, onSection, assets, workspaces, memories, runtime, onReload, onRuntimeChanged, onOpen, onMigrationPlanned }: { section: AssetSection; onSection: (section: AssetSection) => void; assets: CatalogAsset[]; workspaces: WorkspaceSummary[]; memories: MemoryRecord[]; runtime?: RuntimeInfo; onReload: () => Promise<void>; onRuntimeChanged: (runtime: RuntimeInfo) => void; onOpen: (id: string) => void; onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const pending = memories.filter((item) => item.status === "pending").length;
  const workspaceAssets = useMemo(() => groupCatalogAssets(assets.filter((asset) => asset.scope === "workspace")), [assets]);
  const instructionAssets = workspaceAssets.filter((asset) => asset.kind === "instruction");
  const skillAssets = workspaceAssets.filter((asset) => asset.kind === "skill");
  const connectionAssets = workspaceAssets.filter((asset) => asset.kind === "connection");
  const otherAssets = workspaceAssets.filter((asset) => !["instruction", "skill", "connection", "memory"].includes(asset.kind));
  const pendingMemoryLabel = pending ? tr("memory.pendingCount", { count: pending }) : undefined;
  const CatalogPage = AssetCatalogPage;
  return <div className="relative grid gap-5 pb-8">
    <section className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm max-[900px]:p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground text-background"><Library size={19} /></span>
        <div className="min-w-0"><h1 className="truncate text-xl font-semibold tracking-tight">{tr("nav.assets")}</h1></div>
      </div>
      <div className="flex shrink-0 items-center gap-2"><Badge variant="secondary" className="tabular-nums">{workspaceAssets.length}</Badge><span className="hidden text-xs text-muted-foreground sm:inline">{tr("common.assets")}</span></div>
    </section>
    <section className="rounded-2xl border border-border bg-card px-3 shadow-sm">
      <Tabs value={section} onValueChange={(value) => onSection(value as AssetSection)}>
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0" variant="line" aria-label={tr("nav.assets")}>
          <TabsTrigger className="min-h-11 flex-none gap-2 rounded-none px-3 text-xs sm:text-sm" value="instructions"><FileCode2 size={15} />{tr("assets.instructions")}<Badge variant="secondary" className="min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]">{instructionAssets.length}</Badge></TabsTrigger>
          <TabsTrigger className="min-h-11 flex-none gap-2 rounded-none px-3 text-xs sm:text-sm" value="skills"><Sparkles size={15} />{tr("assets.skills")}<Badge variant="secondary" className="min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]">{skillAssets.length}</Badge></TabsTrigger>
          <TabsTrigger className="min-h-11 flex-none gap-2 rounded-none px-3 text-xs sm:text-sm" value="mcp"><PlugZap size={15} />MCP<Badge variant="secondary" className="min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]">{connectionAssets.length}</Badge></TabsTrigger>
          <TabsTrigger className="min-h-11 flex-none gap-2 rounded-none px-3 text-xs sm:text-sm" value="memory"><Brain size={15} />{tr("assets.memories")}<Badge variant="secondary" className={cn("min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]", pending && "border-amber-300 bg-amber-100 text-amber-800")} aria-label={pendingMemoryLabel} title={pendingMemoryLabel}>{memories.length}</Badge></TabsTrigger>
          <TabsTrigger className="min-h-11 flex-none gap-2 rounded-none px-3 text-xs sm:text-sm" value="other"><Boxes size={15} />{tr("assets.hooksProfiles")}<Badge variant="secondary" className="min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]">{otherAssets.length}</Badge></TabsTrigger>
        </TabsList>
      </Tabs>
    </section>
    {section === "instructions" && <CatalogPage assets={instructionAssets} workspaces={workspaces} onOpen={onOpen} />}
    {section === "skills" && <CatalogPage assets={skillAssets} workspaces={workspaces} onOpen={onOpen} />}
    {section === "other" && <CatalogPage assets={otherAssets} workspaces={workspaces} onOpen={onOpen} />}
    {section === "memory" && <GlobalMemoryInbox records={memories} workspaces={workspaces} onReload={onReload} />}
    {section === "mcp" && <McpHubPage runtime={runtime} workspaces={workspaces} onRuntimeChanged={onRuntimeChanged} onMigrationPlanned={onMigrationPlanned} />}
  </div>;
}


function GlobalMemoryInbox({ records, workspaces, onReload }: { records: MemoryRecord[]; workspaces: WorkspaceSummary[]; onReload: () => Promise<void> }) {
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { await api.reviewMemory(id, status, editedContent); await onReload(); };
  return <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden rounded-xl border border-border bg-card"><CardHeader className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><div><h2>{tr("memory.globalTitle")}</h2><p>{tr("memory.globalPending", { count: records.filter((item) => item.status === "pending").length })}</p></div></CardHeader><CardContent className="p-0"><div className="grid gap-4">{records.map((record) => <div key={record.id} className="grid gap-2"><span className="text-xs font-medium text-muted-foreground">{workspaces.find((item) => item.manifest_workspace_id === record.project_id)?.name ?? record.project_id.slice(0, 8)}</span><MemoryCard record={record} onReview={review} /></div>)}{!records.length && <Empty icon={Brain} title={tr("memory.empty")} text={tr("memory.globalEmptyText")} />}</div></CardContent></Card>;
}

function ActivityPage({ records }: { records: ActivityRecord[] }) { return <Card className="rounded-xl border border-border bg-card shadow-sm"><CardHeader className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><div><h2>{tr("activity.title")}</h2><p>{tr("activity.description")}</p></div></CardHeader><CardContent className="p-0"><div className="grid gap-4">{records.map((record) => <ActivityRow key={record.id} record={record} />)}{!records.length && <Empty icon={History} title={tr("home.noActivity")} text={tr("activity.emptyText")} />}</div></CardContent></Card>; }
function ActivityRow({ record }: { record: ActivityRecord }) { const key = `activity.action.${record.action}`; return <div className="flex items-start gap-3 rounded-lg border border-border p-3"><span className="mt-1 size-2 shrink-0 rounded-full bg-primary" /><div><strong>{tr(key, { defaultValue: record.action })}</strong><small title={record.detail}>{record.detail}</small></div><time>{formatDateTime(record.created_at)}</time></div>; }

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
  return <div className="grid gap-5">{error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={16} />{error}</div>}<div className="grid gap-4 rounded-2xl border border-border bg-card p-5 md:grid-cols-[minmax(0,1fr)_auto]"><div className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">STREAMABLE HTTP MCP HUB</span><h2>{tr("mcp.title")}</h2><p>{tr("mcp.description")}</p></div><div className="grid gap-1.5 text-right text-sm text-muted-foreground"><span className={cn("font-medium", runtime?.mcp_hub?.running ? "text-emerald-600" : "text-destructive")}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code><small>{tr("mcp.runtimeCount", { count: runtime?.mcp_hub?.runtime_count ?? 0 })}</small></div></div><div className="grid gap-5 rounded-2xl border border-border bg-card p-5 shadow-sm md:grid-cols-[minmax(0,1fr)_auto]"><div className="grid gap-1.5"><h2>{tr("mcp.network")}</h2><p>{tr("mcp.networkDescription")}</p></div><div className="flex flex-wrap items-end gap-4"><Label className="!grid gap-2"><span>{tr("mcp.port")}</span><Input className="w-32" type="number" min="1" max="65535" defaultValue={runtime?.mcp_network?.port ?? 47653} onBlur={(event) => void updatePort(Number(event.target.value))} /></Label><Label className="!grid gap-2"><span>{tr("mcp.lanMode")}</span><Switch checked={runtime?.mcp_network?.lan_enabled ?? false} onCheckedChange={(checked) => void updateNetwork(checked)} /></Label></div></div><div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.scope")}</h2><p>{tr("mcp.scopeDescription")}</p></div><SelectControl className="min-w-40 rounded-md border border-input bg-background px-3 py-2 text-sm" value={scope} onChange={(event) => setScope(event.target.value)}><option value="">{tr("mcp.globalScope")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.path}>{workspace.name}</option>)}</SelectControl></div></div><McpServerEditor project={project} onSaved={load} /><McpMigrationInventory project={project} onPlanned={onMigrationPlanned} /><div className="grid gap-5 lg:grid-cols-2"><div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.registry")}</h2><p>{tr("mcp.registryDescription")}</p></div></div><div className="flex items-center gap-2 p-5"><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRegistry(); }} placeholder={tr("mcp.searchPlaceholder")} /><Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void searchRegistry()}><Search size={14} />{tr("common.search")}</Button></div><div className="grid divide-y divide-border px-5">{registry.map((entry) => <article className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" key={`${entry.name}-${entry.version}`}><div className="grid gap-1"><strong>{entry.name}</strong><small>{entry.description}</small><span>{entry.package_kind} · {entry.version}{entry.required_env.length ? ` · ${tr("mcp.requiredEnv", { count: entry.required_env.length })}` : ""}</span></div><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void install(entry)}>{tr("mcp.install")}</Button></article>)}{!registry.length && <p className="py-6 text-sm text-muted-foreground">{tr("mcp.registryEmpty")}</p>}</div></div><div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.configured")}</h2><p>{tr("mcp.configuredDescription")}</p></div><Badge variant="outline">{servers.length}</Badge></div><div className="grid divide-y divide-border px-5">{servers.map((server) => <article className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" key={server.id}><div className="grid gap-1"><strong>{server.name}</strong><small>{server.transport === "stdio" ? server.command : server.url}</small><span>{server.targets.length ? server.targets.map((agent) => agentLabels[agent]).join(" · ") : tr("mcp.allAgents")}</span></div><div className="flex flex-wrap gap-2">{server.transport === "streamable-http" && <Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void authorize(server.id)}>{tr("mcp.authorize")}</Button>}<Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={async () => { try { await api.probeMcpRuntime(server.id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.probe")}</Button><Button className="text-destructive hover:bg-destructive/10" onClick={async () => { await api.removeMcpServer(server.id, project); await load(); }}><Trash2 size={14} /></Button></div></article>)}{!servers.length && <p className="py-6 text-sm text-muted-foreground">{tr("mcp.configuredEmpty")}</p>}</div></div></div><div className="grid gap-5 lg:grid-cols-2"><div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.installations")}</h2><p>{runtime?.mcp_package_root}</p></div><Badge variant="outline">{installations.length}</Badge></div><div className="grid divide-y divide-border px-5">{installations.map((item) => { const update = registry.find((entry) => entry.package_kind === item.package_kind && entry.identifier === item.identifier && entry.version !== item.version); return <article className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" key={item.id}><div className="grid gap-1"><strong>{item.name}</strong><small>{item.identifier}</small><span>{item.package_kind} · {item.version ?? "—"}</span></div><div className="flex flex-wrap gap-2">{update && <Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" disabled={busy} onClick={() => void updateInstallation(item, update)}>{tr("mcp.update")}</Button>}<Button className="text-destructive hover:bg-destructive/10" onClick={async () => { if (!await dialogs.confirm({ description: tr("mcp.uninstallConfirm", { name: item.name }), tone: "destructive" })) return; await api.uninstallMcp(item.id); await load(); }}><Trash2 size={14} /></Button></div></article>; })}{!installations.length && <p className="py-6 text-sm text-muted-foreground">{tr("mcp.installationsEmpty")}</p>}</div></div><div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.runtimes")}</h2><p>{tr("mcp.lazyRuntime")}</p></div><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void load()}><RefreshCw size={13} />{tr("common.refresh")}</Button></div><div className="grid divide-y divide-border px-5">{runtimes.map((item) => <article className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" key={item.config_hash}><div className="grid gap-1"><strong>{item.server_name}</strong><small>{item.config_hash.slice(0, 16)}…</small><span className={cn("inline-flex items-center gap-1 rounded-md text-xs font-medium", item.state === "running" ? "text-emerald-600" : "text-destructive")}>{tr(`mcp.runtime.${item.state}`)}</span></div><div className="flex flex-wrap gap-2"><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={async () => { try { await api.restartMcpRuntime(item.server_id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.restart")}</Button><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={async () => { await api.stopMcpRuntime(item.server_id); await load(); }}>{tr("mcp.stop")}</Button></div></article>)}{!runtimes.length && <p className="py-6 text-sm text-muted-foreground">{tr("mcp.runtimesEmpty")}</p>}</div></div></div></div>;
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
  return <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.editor")}</h2><p>{tr("mcp.editorDescription")}</p></div><Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={saving} onClick={() => void save()}>{tr("common.save")}</Button></div>{error && <div className="mx-5 mt-5 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={16} />{error}</div>}<div className="grid gap-5 p-5 lg:grid-cols-2"><Label className="!grid !items-stretch gap-2.5"><span className="text-sm font-medium">{tr("mcp.publicJson")}</span><Textarea className="min-h-[230px]" value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} /></Label><div className="grid gap-5"><Label className="!grid !items-stretch gap-2.5"><span className="text-sm font-medium">{tr("mcp.environmentSecrets")}</span><Textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder="API_TOKEN=…" spellCheck={false} /></Label><Label className="!grid !items-stretch gap-2.5"><span className="text-sm font-medium">{tr("mcp.headerSecrets")}</span><Textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder="Authorization=Bearer …" spellCheck={false} /></Label><small className="text-sm leading-6 text-muted-foreground">{tr("mcp.secretDescription")}</small></div></div></Card>;
}

function McpMigrationInventory({ project, onPlanned }: { project?: string; onPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const dialogs = useAppDialogs();
  const [candidates, setCandidates] = useState<import("../core/types").McpMigrationCandidate[]>([]);
  const [scanned, setScanned] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scan = async () => { setCandidates(await api.nativeMcpCandidates(project)); setScanned(true); };
  const plan = async () => { if (!project || !selected.length) return; if (!await dialogs.confirm(tr("mcp.migrationConfirm", { count: selected.length }))) return; setBusy(true); setError(""); try { await onPlanned(project, await api.planMcpMigration(project, selected)); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const toggle = (id: string, checked: boolean) => setSelected((current) => checked ? [...current, id] : current.filter((value) => value !== id));
  return <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5"><div className="grid gap-1.5"><h2>{tr("mcp.migration")}</h2><p>{tr("mcp.migrationDescription")}</p></div><div className="flex flex-wrap gap-2"><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void scan()}><Search size={13} />{tr("common.scan")}</Button><Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={!project || !selected.length || busy} onClick={() => void plan()}>{tr("mcp.planMigration")}</Button></div></div><div className="grid gap-3 px-5 py-5">{!project && <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm text-amber-700"><CircleAlert size={14} />{tr("mcp.projectRequired")}</div>}{error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"><CircleAlert size={16} />{error}</div>}</div>{scanned && <div className="grid divide-y divide-border px-5 pb-5">{candidates.map((candidate) => <article className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" key={candidate.id}><Label className="!grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3"><Checkbox className="mt-0.5" disabled={!candidate.supported || !project} checked={selected.includes(candidate.id)} onCheckedChange={(checked) => toggle(candidate.id, checked)} /><span className="grid gap-1"><strong>{candidate.name}</strong><small>{agentLabels[candidate.agent]} · {candidate.source_path}</small><em>{candidate.transport} · {candidate.endpoint}{candidate.has_secret_values ? ` · ${tr("mcp.secretReentry")}` : ""}</em></span></Label><span className={cn("inline-flex items-center gap-1 rounded-md text-xs font-medium", candidate.supported ? "text-emerald-600" : "text-destructive")}>{tr(candidate.supported ? "mcp.importable" : "mcp.unsupported")}</span></article>)}{!candidates.length && <p className="py-5 text-sm text-muted-foreground">{tr("mcp.migrationEmpty")}</p>}</div>}</Card>;
}

function GlobalSettings({ section, runtime, workspaces, discovery, insightsStatus, quotaStatus, remoteGateways, scanRoots, excluded, activity, onAddRoot, onRemoveRoot, onRestore, onCloseBehaviorChanged, onLocaleChanged, onRemoteGatewaysChanged }: { section: SettingsSection; runtime?: RuntimeInfo; workspaces: WorkspaceSummary[]; discovery?: DiscoveryReport; insightsStatus?: InsightsStatus; quotaStatus?: QuotaCollectorStatus; remoteGateways: RemoteGatewaySummary[]; scanRoots: ScanRoot[]; excluded: ExcludedWorkspace[]; activity: ActivityRecord[]; onAddRoot: () => Promise<void>; onRemoveRoot: (id: string) => Promise<void>; onRestore: (path: string) => Promise<void>; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>; onLocaleChanged: (runtime: RuntimeInfo) => void; onRemoteGatewaysChanged: () => Promise<void> }) {
  if (section === "general") return <div className="grid gap-5"><SettingGroup title={tr("settings.interface")}><ThemeSetting runtime={runtime} onChanged={onLocaleChanged} /><AppIconSetting runtime={runtime} onChanged={onLocaleChanged} /><LanguageSetting runtime={runtime} onChanged={onLocaleChanged} /><SettingsRow><SettingsCopy><strong>{tr("settings.closeBehavior")}</strong></SettingsCopy><CloseBehaviorSelect value={runtime?.close_behavior} trayAvailable={runtime?.tray_available !== false} onChange={onCloseBehaviorChanged} /></SettingsRow>{runtime?.tray_available === false && <SettingDetail variant="warning" role="status"><CircleAlert size={14} />{tr("settings.trayUnavailable")}</SettingDetail>}</SettingGroup></div>;
  if (section === "discovery") return <div className="grid gap-5"><SettingGroup title={tr("settings.discovery")}><SettingsRow><SettingsCopy><strong>{tr("settings.discoveryStatus")}</strong></SettingsCopy><span className={cn("font-medium", discovery?.errors.length ? "text-destructive" : "text-emerald-600")}>{discovery ? tr("settings.workspaceCount", { count: discovery.discovered_count }) : tr("home.discovering")}</span></SettingsRow>{discovery?.errors.map((error) => <SettingDetail variant="error" key={error}>{error}</SettingDetail>)}</SettingGroup><SettingGroup title={tr("settings.scanRoots")}><div className="flex justify-end border-b border-border/60 px-5 py-3"><Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void onAddRoot()}>{tr("settings.addFolder")}</Button></div><SettingsListEmptyState items={scanRoots.length} emptyText={tr("settings.noScanRoots")}><div className="divide-y divide-border/60">{scanRoots.map((root) => <div className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3" key={root.id}><FolderGit2 size={17} className="text-muted-foreground" /><span className="min-w-0"><strong className="block break-all text-sm font-medium">{root.path}</strong><small className="mt-1 block text-xs text-muted-foreground">{tr("settings.maxDepth", { depth: root.max_depth })}</small></span><Button size="icon" variant="ghost" className="text-destructive hover:bg-destructive/10" aria-label={tr("common.remove")} onClick={() => void onRemoveRoot(root.id)}><Trash2 size={15} /></Button></div>)}</div></SettingsListEmptyState></SettingGroup><SettingGroup title={tr("settings.excluded")}><SettingsListEmptyState items={excluded.length} emptyText={tr("settings.noExcluded")}><div className="divide-y divide-border/60">{excluded.map((item) => <div className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3" key={item.path}><X size={17} className="text-muted-foreground" /><span className="min-w-0"><strong className="block break-all text-sm font-medium">{item.path}</strong><small className="mt-1 block text-xs text-muted-foreground">{formatDateTime(item.created_at)}</small></span><Button size="sm" variant="outline" onClick={() => void onRestore(item.path)}>{tr("common.restore")}</Button></div>)}</div></SettingsListEmptyState></SettingGroup></div>;
  if (section === "integrations") return <div className="grid gap-5"><SettingGroup title="AgentKib MCP Hub"><SettingsRow border={false}><SettingsCopy><strong>{tr("mcp.network")}</strong><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code></SettingsCopy><StatusText active={Boolean(runtime?.mcp_hub?.running)}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</StatusText></SettingsRow></SettingGroup><RemoteGatewaysSettings gateways={remoteGateways} onChanged={onRemoteGatewaysChanged} /><ObsidianSettingsCard /></div>;
  if (section === "privacy") return <div className="grid gap-5"><SettingGroup title={tr("settings.localData")}><SettingsRow border={false}><SettingsCopy><strong>{tr("settings.dataLocation")}</strong><code>{runtime?.data_dir ?? "—"}</code></SettingsCopy><StatusText active><Check size={14} />{tr("common.localOnly")}</StatusText></SettingsRow>{hasFileAccessSettings && <FileAccessSettingsRow />}</SettingGroup><ConversationPrivacySettings runtime={runtime} workspaces={workspaces} onChanged={onLocaleChanged} /><GitIdentitySettings /></div>;
  return <div className="grid gap-5"><div className="grid gap-5 xl:grid-cols-2"><SettingGroup title={tr("quota.diagnostics")}><QuotaDiagnostics status={quotaStatus} /></SettingGroup><SettingGroup title={tr("settings.providerStatus")}>{insightsStatus?.providers.map((provider) => <SettingsRow key={provider.agent}><div className="flex items-center gap-3"><AgentIcon agent={provider.agent} /><strong className="text-sm font-medium">{agentLabels[provider.agent]}</strong></div><StatusText active={provider.available}>{tr(provider.available ? "quota.available" : "insights.noData")}</StatusText></SettingsRow>)}{!insightsStatus?.providers.length && <div className="px-5 py-4 text-sm text-muted-foreground">{tr("insights.noData")}</div>}</SettingGroup></div><ActivityPage records={activity} /></div>;
}

function SettingsRow({ children, border = true }: { children: ReactNode; border?: boolean }) { return <div className={cn("flex min-h-16 flex-wrap items-center justify-between gap-4 px-5 py-3", border && "border-b border-border/60")}>{children}</div>; }
function SettingsCopy({ children }: { children: ReactNode }) { return <div className="grid min-w-0 gap-1 [&_code]:max-w-full [&_code]:truncate [&_code]:font-mono [&_code]:text-xs [&_code]:text-muted-foreground [&_strong]:text-sm [&_strong]:font-medium">{children}</div>; }
function SettingDetail({ children, variant = "default", role }: { children: ReactNode; variant?: "default" | "error" | "warning"; role?: "alert" | "status" }) { return <div className={cn("mx-5 my-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs", variant === "default" && "border-border/60 bg-muted/20 text-muted-foreground", variant === "error" && "border-destructive/30 bg-destructive/5 text-destructive", variant === "warning" && "border-amber-500/30 bg-amber-500/5 text-amber-700")} role={role}>{children}</div>; }

function SettingGroup({ title, children }: { title: string; children: ReactNode }) { return <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm"><CardHeader className="border-b border-border/60 bg-muted/20 px-5 py-4"><CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle></CardHeader><CardContent className="p-0">{children}</CardContent></Card>; }
function SettingsListEmptyState({ items, emptyText, children }: { items: number; emptyText: string; children: ReactNode }) { return items ? <>{children}</> : <p className="px-5 py-5 text-sm text-muted-foreground">{emptyText}</p>; }
function StatusText({ active, children }: { active: boolean; children: ReactNode }) { return <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", active ? "text-emerald-600" : "text-muted-foreground")}>{active && <span className="size-1.5 rounded-full bg-current" />}{children}</span>; }

function FileAccessSettingsRow() {
  const [error, setError] = useState("");
  const openSettings = async () => {
    setError("");
    try { await api.openFilesAndFoldersSettings(); }
    catch (reason) { setError(localizeMessage(reason)); }
  };
  return <><SettingsRow border={false}><SettingsCopy><strong>{tr("settings.appDataAccess")}</strong></SettingsCopy><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" type="button" onClick={() => void openSettings()}><ExternalLink size={14} />{tr("settings.openFilesAndFolders")}</Button></SettingsRow>{error && <SettingDetail variant="error" role="alert">{error}</SettingDetail>}</>;
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
    <SettingsRow><SettingsCopy><strong>{tr("conversations.indexSetting")}</strong></SettingsCopy><Label className="inline-flex items-center"><Switch checked={runtime?.session_index_enabled !== false} disabled={busy} onCheckedChange={(checked) => void toggle(checked)} /></Label></SettingsRow>
    <SettingsRow><SettingsCopy><strong>{tr("conversations.indexedWorkspaces", { count: indexedCount })}</strong></SettingsCopy><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" disabled={busy || indexedCount === 0} onClick={() => void clear()}><Trash2 size={14} />{tr("conversations.clearIndex")}</Button></SettingsRow>
    {error && <SettingDetail variant="error" role="alert">{error}</SettingDetail>}
  </SettingGroup>;
}

function LanguageSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: LocalePreference) => {
    const nextRuntime = await api.setLocale(preference);
    await changeLocale(nextRuntime.effective_locale);
    onChanged(nextRuntime);
  };
  return <SettingsRow><SettingsCopy><strong>{tr("settings.language")}</strong></SettingsCopy><SelectControl aria-label={tr("settings.language")} className="h-9 min-w-40 rounded-lg border-input bg-background px-3 text-sm shadow-sm" value={runtime?.locale_preference ?? "system"} onChange={(event) => void update(event.target.value as LocalePreference)}>{(["system", "zh-CN", "zh-TW", "ja-JP", "en-US"] as LocalePreference[]).map((locale) => <option key={locale} value={locale}>{tr(`settings.language.${locale}`)}</option>)}</SelectControl></SettingsRow>;
}

function ThemeSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: ThemePreference) => {
    const nextRuntime = await api.setThemePreference(preference);
    applyTheme(nextRuntime.effective_theme);
    onChanged(nextRuntime);
  };
  const selected = runtime?.theme_preference ?? "system";
  return <SettingsRow><SettingsCopy><strong>{tr("settings.theme")}</strong></SettingsCopy><ToggleGroup spacing={0} variant="outline" className="shrink-0 rounded-lg shadow-sm" value={[selected]} onValueChange={(values) => { const theme = values[0]; if (theme === "light" || theme === "dark" || theme === "system") void update(theme); }} aria-label={tr("settings.theme")}>{(["light", "dark", "system"] as ThemePreference[]).map((theme) => <ToggleGroupItem key={theme} value={theme} className="h-9 min-w-[66px] px-3 text-sm">{tr(`settings.theme.${theme}`)}</ToggleGroupItem>)}</ToggleGroup></SettingsRow>;
}

function AppIconSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: AppIconPreference) => {
    onChanged(await api.setAppIconPreference(preference));
  };
  const selected = runtime?.app_icon_preference ?? "white";
  return <SettingsRow><SettingsCopy><strong>{tr("settings.appIcon")}</strong></SettingsCopy><ToggleGroup spacing={0} variant="outline" className="shrink-0 rounded-lg shadow-sm" value={[selected]} onValueChange={(values) => { const icon = values[0]; if (icon === "white" || icon === "black") void update(icon); }} aria-label={tr("settings.appIcon")}>{(["white", "black"] as AppIconPreference[]).map((icon) => <ToggleGroupItem key={icon} value={icon} className="inline-flex h-9 min-w-[90px] items-center justify-center gap-1.5 px-3 text-sm">{icon === "white" ? <span className="size-4 rounded border border-border bg-white" aria-hidden="true" /> : <span className="size-4 rounded border border-border bg-black" aria-hidden="true" />}{tr(`settings.appIcon.${icon}`)}</ToggleGroupItem>)}</ToggleGroup></SettingsRow>;
}

function CloseBehaviorSelect({ value, trayAvailable = true, onChange }: { value?: CloseBehavior; trayAvailable?: boolean; onChange: (behavior?: CloseBehavior) => Promise<void> }) {
  const modifier = primaryShortcutModifier(buildPlatform);
  const trayKey = usesSystemTrayWording(buildPlatform) ? "settings.close.systemTray" : "settings.close.tray";
  const selected = value ?? "ask";
  return <SelectControl aria-label={tr("settings.closeBehavior")} className="h-9 min-w-40 rounded-lg border-input bg-background px-3 text-sm shadow-sm" title={tr("settings.close.quitShortcut", { modifier })} value={selected} onChange={(event) => void onChange(event.target.value === "ask" ? undefined : event.target.value as CloseBehavior)}><option value="ask">{tr("settings.close.ask")}</option><option value="minimize-to-tray" disabled={!trayAvailable}>{tr(trayKey)}</option><option value="quit">{tr("settings.close.quit")}</option></SelectControl>;
}

function GitIdentitySettings() {
  const [identities, setIdentities] = useState<GitIdentitySummary[]>([]); const [email, setEmail] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setIdentities(await api.gitIdentities()); } catch (reason) { setError(localizeMessage(reason)); } };
  useEffect(() => { void load(); }, []);
  const add = async () => { if (!email.trim()) return; try { setError(""); await api.addGitIdentityAlias(email); setEmail(""); await load(); } catch (reason) { setError(localizeMessage(reason)); } };
  return <SettingGroup title={tr("settings.gitIdentity")}>
    {error && <SettingDetail variant="error" role="alert">{error}</SettingDetail>}
    <div className="flex flex-col gap-2.5 border-b border-border/60 p-5 sm:flex-row">
      <Input className="min-w-0 flex-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void add(); }} placeholder={tr("settings.gitAliasPlaceholder")} />
      <Button className="shrink-0" onClick={() => void add()}>{tr("settings.addAlias")}</Button>
    </div>
    <div className="divide-y divide-border/60">
      {identities.map((identity) => <Label className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3" key={identity.id}>
        <GitCommitHorizontal size={15} className="text-muted-foreground" />
        <span className="min-w-0"><strong className="block break-all text-sm font-medium">{metadataLabel(identity.label)}</strong><small className="mt-1 block text-xs text-muted-foreground">{identity.source} · {identity.id.slice(0, 10)}…</small></span>
        <Switch checked={identity.enabled} onCheckedChange={async (checked) => { await api.setGitIdentityEnabled(identity.id, checked); await load(); }} />
      </Label>)}
      {!identities.length && <p className="px-5 py-5 text-sm text-muted-foreground">{tr("settings.gitIdentityEmpty")}</p>}
    </div>
  </SettingGroup>;
}

function Overview({ workspace, scan, manifest }: { workspace: WorkspaceSummary; scan: WorkspaceScan; manifest: Manifest }) {
  const configuredAgents = scan.agents.filter((agent) => agent.detected || agent.warnings.length > 0);
  const unconfiguredAgents = scan.agents.filter((agent) => !agent.detected && agent.warnings.length === 0);
  const issueCount = scan.warnings.length + scan.agents.reduce((total, agent) => total + agent.warnings.length, 0);
  const sharedAssets = (manifest.instructions.shared.trim() ? 1 : 0) + manifest.instructions.scoped.length + manifest.skills.length + manifest.connections.length;
  const sources = workspace.sources.flatMap((source) => source.agent ? [agentLabels[source.agent]] : []).filter((value, index, values) => values.indexOf(value) === index).join(" · ") || tr("workspace.source.manual");
  const stats = [[tr("overview.health"), workspaceStatusLabel(issueCount ? "attention" : "healthy")], [tr("overview.sharedAssets"), sharedAssets], [tr("overview.projectAgentConfigs"), scan.agents.filter((agent) => agent.detected).length], [tr("overview.realIssues"), issueCount]] as const;
  const sourceRows = [[tr("assets.sharedInstructions"), manifest.instructions.shared.trim() ? 1 : 0], [tr("overview.sharedSkills"), manifest.skills.length], ["MCP", manifest.connections.length], [tr("overview.scopedRules"), manifest.instructions.scoped.length]] as const;
  return <div className="grid gap-5">
    {scan.warnings.map((warning) => <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700" key={warning}><CircleAlert size={16} className="mt-0.5 shrink-0" /><span>{warning}</span></div>)}
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
      <button type="button" className="flex min-w-0 max-w-full items-center gap-2 text-left transition-colors hover:text-foreground" title={tr("workspace.copyPath")} onClick={() => void navigator.clipboard?.writeText(workspace.path)}><code className="truncate">{workspace.path}</code><Copy size={13} className="shrink-0" /></button>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1"><span><strong className="mr-1.5 font-medium text-foreground">{tr("workspace.discoverySources")}</strong>{sources}</span><span><strong className="mr-1.5 font-medium text-foreground">{tr("workspace.lastScanLabel")}</strong>{workspace.last_scanned_at ? relativeTime(workspace.last_scanned_at) : tr("common.never")}</span></div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map(([label, value], index) => <Card className="rounded-xl border-border/70 shadow-sm" key={label}><CardContent className="grid min-h-[92px] content-center gap-1 px-4 py-3"><span className="text-xs font-medium text-muted-foreground">{label}</span><strong className={cn("text-lg tracking-tight", index === 0 && issueCount > 0 && "text-amber-700")}>{value}</strong></CardContent></Card>)}</div>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,.8fr)_minmax(420px,1.2fr)]">
      <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm"><CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/70 px-5 py-4"><div><CardTitle className="text-base">{tr("overview.publicSource")}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{tr("workspace.discoverySources")}: {sources}</p></div>{scan.manifest_exists && <Badge variant="outline">Schema v{manifest.schema_version}</Badge>}</CardHeader><CardContent className="p-0"><div className="divide-y divide-border/70">{sourceRows.map(([label, value]) => <div className="flex items-center justify-between gap-4 px-5 py-3.5" key={label}><span className="text-sm text-muted-foreground">{label}</span><strong className="text-sm tabular-nums text-foreground">{value}</strong></div>)}</div></CardContent></Card>
      <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm"><CardHeader className="border-b border-border/70 px-5 py-4"><CardTitle className="text-base">{tr("overview.projectAgentConfigs")}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{tr("overview.nativeAssets", { count: configuredAgents.reduce((total, agent) => total + agent.asset_count, 0) })}</p></CardHeader><CardContent className="p-0"><div className="divide-y divide-border/70">{configuredAgents.map((agent) => <div className="flex items-center gap-3 px-5 py-3.5" key={agent.agent}><AgentIcon agent={agent.agent} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{agentLabels[agent.agent]}</strong><small className="mt-0.5 block text-xs text-muted-foreground">{tr("overview.nativeAssets", { count: agent.asset_count })}</small></span><Badge variant={agent.warnings.length ? "destructive" : "secondary"}>{tr(agent.warnings.length ? "status.workspace.attention" : "overview.detected")}</Badge></div>)}{!configuredAgents.length && <p className="px-5 py-5 text-xs text-muted-foreground">{tr("overview.noProjectAgentConfigs")}</p>}{unconfiguredAgents.length > 0 && <Collapsible className="px-5 py-3.5 text-xs text-muted-foreground"><CollapsibleTrigger>{tr("overview.otherAgents", { count: unconfiguredAgents.length })}</CollapsibleTrigger><CollapsibleContent className="mt-3 grid gap-2">{unconfiguredAgents.map((agent) => <div className="flex items-center gap-2" key={agent.agent}><AgentIcon agent={agent.agent} /><span>{agentLabels[agent.agent]}</span><span className="ml-auto">{tr("overview.noProjectConfig")}</span></div>)}</CollapsibleContent></Collapsible>}</div></CardContent></Card>
    </div>
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
  return <div className="grid gap-4"><Tabs value={section} onValueChange={(value) => onSection(value as WorkspaceAssetSection)}><TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0" variant="line" aria-label={tr("nav.assets")}>{tabs.map(([value, label, count]) => <TabsTrigger className="min-h-11 flex-none rounded-none px-3 text-xs sm:text-sm" value={value} key={value}>{label === "MCP" ? label : tr(label)}<em>{count}</em></TabsTrigger>)}</TabsList></Tabs>
    {section === "instructions" && <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">{!scan.manifest_exists && <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><ShieldCheck size={16} /><strong>{tr("assets.sharedLayerEmpty")}</strong></div>}<Label className="grid gap-2 p-4">{tr("assets.sharedInstructions")}<Textarea value={manifest.instructions.shared} onChange={(event) => onChange({ ...manifest, instructions: { ...manifest.instructions, shared: event.target.value } })} /></Label></Card>}
    {section === "skills" && <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"><div className="grid gap-4">{manifest.skills.map((skill) => <span className="flex items-center justify-between gap-3 rounded-lg border border-border p-3" key={skill.name}><span><strong>{skill.name}</strong><small>{skill.path}</small></span><Button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, skills: manifest.skills.filter((item) => item.name !== skill.name) })}><X size={13} /></Button></span>)}</div><div className="flex flex-wrap items-center gap-2 p-4"><Input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder={tr("assets.name")} /><Input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder=".agents/skills/name" /><Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={addSkill}>{tr("common.add")}</Button></div></Card>}
    {section === "mcp" && <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"><div className="grid gap-4">{manifest.connections.map((connection) => <span className="flex items-center justify-between gap-3 rounded-lg border border-border p-3" key={connection.name}><span><strong>{connection.name}</strong><small>{connection.transport === "stdio" ? connection.command : connection.url}</small></span><Button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, connections: manifest.connections.filter((item) => item.name !== connection.name) })}><X size={13} /></Button></span>)}</div><div className="flex flex-wrap items-center gap-2 p-4 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]"><Input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder={tr("assets.name")} /><SelectControl value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></SelectControl><Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"} /><Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={addConnection}>{tr("common.add")}</Button></div></Card>}
    {section === "native" && <Card className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"><div className="flex flex-wrap items-center gap-3 border-b border-border bg-card p-3"><div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><Search size={16} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("assets.searchPlaceholder")} /></div><span>{tr("overview.nativeAssets", { count: filtered.length })}</span></div><div className="overflow-hidden rounded-lg border border-border"><div className="grid grid-cols-[minmax(0,1.5fr)_minmax(160px,1fr)_minmax(120px,auto)_auto] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 bg-muted/40 text-xs font-medium text-muted-foreground"><span>{tr("assets.asset")}</span><span>{tr("catalog.visibleAgents")}</span><span>{tr("assets.type")}</span><span>{tr("assets.size")}</span></div>{filtered.map((asset) => { const allAgents = asset.agents.map((agent) => agentLabels[agent]).join(" · "); return <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(160px,1fr)_minmax(120px,auto)_auto] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0" key={asset.id}><span className="min-w-0"><FileCode2 size={16} /><div><strong>{asset.path.split("/").pop()}</strong><small>{shortPath(asset.path)}</small></div></span><span className="flex flex-wrap items-center gap-1.5" aria-label={allAgents} title={allAgents}>{asset.agents.map((agent) => <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground" key={agent}>{agentLabels[agent]}</span>)}</span><span><span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">{tr(`status.asset.${asset.kind}`)}</span></span><span>{formatBytes(asset.size)}</span></div>; })}</div></Card>}
  </div>;
}

function ContextPage({ project, onOpenInstructions }: { project: string; onOpenInstructions: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("codex"); const [cwd, setCwd] = useState(project); const [preview, setPreview] = useState<ContextPreview>(); const [error, setError] = useState(""); const [resolving, setResolving] = useState(false);
  const requestSequence = useRef(0);
  const run = async () => { const sequence = ++requestSequence.current; setResolving(true); setError(""); try { const next = await api.context(project, cwd, agent); if (sequence === requestSequence.current) setPreview(next); } catch (value) { if (sequence === requestSequence.current) setError(localizeMessage(value)); } finally { if (sequence === requestSequence.current) setResolving(false); } };
  useEffect(() => { const timeout = window.setTimeout(() => { void run(); }, 350); return () => window.clearTimeout(timeout); }, [project, cwd, agent]);
  const empty = preview && !preview.sections.length;
  return <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,.35fr)_minmax(0,1fr)]"><Card className="rounded-xl border border-border bg-card shadow-sm grid content-start gap-4 p-4"><h2>{tr("context.environment")}</h2><Label>Agent<SelectControl value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</SelectControl></Label><Label>{tr("context.workingDirectory")}<Input value={cwd} onChange={(event) => setCwd(event.target.value)} /></Label><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void run()} disabled={resolving}><RefreshCw size={14} className={resolving ? "animate-spin" : ""} />{tr("context.resolve")}</Button><Separator /><h3>{tr("context.capabilities")}</h3><Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} /><Pills values={preview?.visible_connections ?? []} empty={tr("context.noConnection")} /></Card><Card className="rounded-xl border border-border bg-card shadow-sm min-w-0"><div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><h2>{tr("context.effective")}</h2>{preview && <Badge variant="outline">{preview.sections.length} {tr("common.sections")}</Badge>}</div>{error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}{preview?.warnings.map((warning) => <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700" key={warning}><CircleAlert size={15} />{contextWarningLabel(warning)}</div>)}{empty && <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground"><FileCode2 size={18} /><span>{tr("context.noInstructions")}</span><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={onOpenInstructions}>{tr("context.openInstructions")}</Button></div>}<div className="grid gap-3 p-4">{preview?.sections.map((contextSection, index) => <article key={`${contextSection.source}-${index}`}><span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{index + 1}</span><div><header><strong>{shortPath(contextSection.source)}</strong><span>{contextSection.scope || tr("status.scope.project")}</span></header><Collapsible><CollapsibleTrigger>{tr("context.showContent")}</CollapsibleTrigger><CollapsibleContent><pre>{contextSection.content}</pre></CollapsibleContent></Collapsible></div></article>)}</div>{preview?.approved_memories.length ? <div className="grid gap-2 border-t border-border p-4 text-sm"><h3>{tr("context.approvedMemory")}</h3>{preview.approved_memories.map((item) => <p key={item}>{item}</p>)}</div> : null}</Card></div>;
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
  if (!changeSet && launchRequest && appliedLaunchFailure) return <Card className="rounded-xl border border-border bg-card shadow-sm grid items-center gap-4 p-5 md:grid-cols-[auto_minmax(0,1fr)_auto]"><CircleAlert size={24} /><div><h2>{tr("handoff.savedLaunchFailed")}</h2><p>{error || appliedLaunchFailure}</p><code>.agentkib/handoffs/{launchRequest.filename}</code></div><Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void runLocked(async () => { await api.launchSessionHandoff(launchRequest); if (!active.current) return; setAppliedLaunchFailure(""); onLaunchCompleted(); })}><ExternalLink size={15} />{tr(busy ? "handoff.opening" : "handoff.retryOpen", { agent: targetAgentName })}</Button></Card>;
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
  return <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,.35fr)_minmax(0,1fr)]"><div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"><div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><div><h2>ChangeSet</h2><p>{changeSet.id.slice(0, 8)} · {changeSet.changes.length} {tr("common.files")}</p></div></div>{origin === "handoff" && <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700"><CircleAlert size={14} />{tr("handoff.changeSetWarning")}</div>}{changeSet.changes.map((file, index) => <Button variant="bare" size="content" key={file.target} className={index === selected ? "bg-muted text-foreground" : ""} onClick={() => setSelected(index)}><FileCode2 size={16} /><div><strong>{file.target.split("/").pop()}</strong><span>{shortPath(file.target)}</span></div><span className={cn("inline-flex items-center rounded-md px-2 py-1 text-xs font-medium", file.risk === "high" ? "text-destructive" : file.risk === "medium" ? "text-amber-700" : "text-muted-foreground")}>{tr(`status.risk.${file.risk}`)}</span></Button>)}{origin === "standard" && <div className="grid gap-2 border-t border-border p-4"><p>{tr("changes.homeQuestion")}</p><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={onPlanHome}>{tr("changes.includeHome")}</Button>{changeSet.requires_home_approval && <Label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={homeApproved} onCheckedChange={setHomeApproved} />{tr("changes.homeApproval")}</Label>}</div>}</div><div className="rounded-xl border border-border bg-card shadow-sm min-w-0">{change ? <><div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><div><h2>{change.target.split("/").pop()}</h2><p>{change.target} · {tr(`status.scope.${change.scope}`)}</p></div><span className={cn("inline-flex items-center rounded-md px-2 py-1 text-xs font-medium", change.risk === "high" ? "text-destructive" : change.risk === "medium" ? "text-amber-700" : "text-muted-foreground")}>{tr(`status.risk.${change.risk}`)}</span></div><Diff before={change.before} after={change.after} /></> : <Empty icon={Check} title={tr("changes.synced")} text={tr("changes.syncedText")} />}{error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4"><div><ShieldCheck size={17} /><span>{tr("changes.hashValidation")}</span></div><div className=""><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={onRejected} disabled={busy}>{tr("changes.reject")}</Button>{origin === "handoff" && launchSupported && <Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void apply()} disabled={disabled}>{tr("handoff.applyOnly")}</Button>}<Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void (origin === "handoff" && launchSupported ? applyAndContinue() : apply())} disabled={disabled}>{origin === "handoff" && launchSupported ? <><ExternalLink size={15} />{tr(busy ? "changes.applying" : "handoff.applyAndContinue", { agent: targetAgentName })}</> : tr(busy ? "changes.applying" : "changes.apply", { count: changeSet.changes.length })}</Button></div></div></div></div>;
}

function MemoryInbox({ project, manifest }: { project: string; manifest: Manifest }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("project_fact"); const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const load = async (searchQuery = query) => { try { setError(""); setRecords(searchQuery.trim() ? await api.searchMemories(project, searchQuery) : await api.memories(project)); } catch (value) { setError(String(value)); } };
  useEffect(() => { void load(); }, [project]);
  const propose = async () => { if (!content.trim()) return; try { await api.proposeMemory(project, content, type); setContent(""); await load(); } catch (value) { setError(String(value)); } };
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { try { await api.reviewMemory(id, status, editedContent); await load(); } catch (value) { setError(String(value)); } };
  return <div className="grid gap-4 lg:grid-cols-[minmax(260px,.4fr)_minmax(0,1fr)]"><div className="rounded-xl border border-border bg-card shadow-sm grid content-start gap-3 p-4"><span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">{tr("memory.newProposal")}</span><h2>{tr("memory.captureFact")}</h2><p>{tr("memory.approvedDescription")}</p><Label>{tr("memory.type")}<SelectControl value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{["project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation","user_preference"].map((value) => <option key={value} value={value}>{tr(`status.memoryType.${value}`)}</option>)}</SelectControl></Label><Label>{tr("memory.content")}<Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={tr("memory.contentPlaceholder")} /></Label><Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={propose}>{tr("memory.submit")}</Button><small>Workspace: {manifest.workspace.id.slice(0, 8)}</small></div><div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden rounded-xl border border-border bg-card"><div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4"><div><h2>{tr("memory.inbox")}</h2><p>{query.trim() ? tr("memory.approvedSearchOnly") : tr("memory.pendingCount", { count: records.filter((r) => r.status === "pending").length })}</p></div><div className="flex items-center gap-2"><Search size={15} /><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder={tr("memory.searchPlaceholder")} /><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => void load()}>{tr("common.search")}</Button>{query && <Button className="text-primary underline-offset-4 hover:underline" onClick={() => { setQuery(""); void load(""); }}>{tr("common.clear")}</Button>}</div></div>{error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}<div className="grid gap-4">{records.map((record) => <MemoryCard key={record.id} record={record} onReview={review} />)}{!records.length && <Empty icon={Brain} title={query.trim() ? tr("memory.noSearchMatch") : tr("memory.empty")} text={query.trim() ? tr("memory.noSearchMatchText") : tr("memory.workspaceEmptyText")} />}</div></div></div>;
}

function MemoryCard({ record, onReview }: { record: MemoryRecord; onReview: (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  return <article><div><span className={cn("inline-flex items-center gap-1 rounded-md text-xs font-medium", record.status === "approved" ? "text-emerald-600" : record.status === "pending" ? "text-amber-700" : "text-muted-foreground")}>{tr(`status.memory.${record.status}`)}</span><span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">{tr(`status.memoryType.${record.memory_type}`)}</span><time>{formatDateTime(record.created_at)}</time></div>{editing ? <Textarea className="min-h-24 resize-y" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p>{record.content}</p>}{record.source_agent && <small>{tr("memory.source", { source: record.source_agent })}</small>}{record.status === "pending" && <footer><Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => onReview(record.id, "approved", editing ? draft : undefined)}><Check size={15} />{editing ? tr("memory.saveApprove") : tr("common.approve")}</Button><Button className="border border-transparent bg-transparent text-foreground hover:bg-muted" onClick={() => setEditing((value) => !value)}>{editing ? <X size={14} /> : <Pencil size={14} />}{editing ? tr("memory.cancelEdit") : tr("common.edit")}</Button><Button className="border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10" onClick={() => onReview(record.id, "rejected")}>{tr("common.reject")}</Button></footer>}{record.status === "approved" && <footer><Button className="border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10" onClick={() => onReview(record.id, "invalidated")}>{tr("memory.invalidate")}</Button></footer>}</article>;
}


function Pills({ values, empty }: { values: string[]; empty: string }) { return <div className="grid gap-4">{values.length ? values.map((value) => <span key={value}>{value}</span>) : <small>{empty}</small>}</div>; }
function Empty({ icon: Icon, title, text, compact = false }: { icon: typeof Brain; title: string; text: string; compact?: boolean }) { return <div className={cn("grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground", compact && "min-h-[92px] grid-cols-[auto_minmax(0,auto)] items-center gap-x-2.5 gap-y-1 p-4 text-left")}><Icon className={compact ? "row-span-2" : "mb-1.5"} size={28} /><h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>{text && <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>}</div>; }
function Diff({ before, after }: { before: string; after: string }) { return <pre className="overflow-auto rounded-lg border border-border bg-muted/30">{diffLines(before, after).map((line, index) => <div className={cn("grid grid-cols-[1.5rem_minmax(0,1fr)] px-3 py-0.5", line.type === "added" && "bg-emerald-50 text-emerald-800", line.type === "removed" && "bg-red-50 text-red-800")} key={`${index}-${line.content}`}><span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>{line.content || " "}</div>)}</pre>; }
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
