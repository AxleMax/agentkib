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
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Activity, Award, Bot, Boxes, Brain, Check, ChevronRight, CircleAlert, Code2, Copy, ExternalLink, FileCode2, FolderGit2, Gauge, GitCommitHorizontal, GitCompareArrows, History, Home, LayoutDashboard, Library, MessageSquareText, MoreHorizontal, Pencil, PlugZap, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../core/api";
import { cn } from "@/lib/utils";
import { AppSidebar, type SidebarEntry } from "../components/AppSidebar";
import { type SettingsSection } from "../components/SettingsSidebar";
import { WindowToolbar } from "../components/WindowToolbar";
import type { GitSubview } from "../components/WorkspaceGitPage";
import { useAppDialogs } from "../components/AppDialogProvider";
import { groupCatalogAssets, workspaceAssetCounts } from "../core/catalog";
import { changeLocale, formatCompactNumber, formatDateTime, formatRelativeTime, localizeMessage, tr } from "../core/i18n";
import { applyTheme } from "../core/theme";
import { normalizePlatform } from "../core/platform";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { ActivityRecord, AgentInstallation, AgentKind, AppMenuCommandRequest, AppNavigationRequest, ContextDoctorSummary, DiscoveryReport, EffectiveTheme, InsightsStatus, InsightsSummary, Manifest, MemoryRecord, QuotaCollectorStatus, QuotaWindowSelector, RefreshJobStatus, RefreshKind, RemoteGatewaySummary, RuntimeInfo, ScanRoot, WorkspaceSummary } from "../core/types";

export type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";

const buildPlatform = import.meta.env.TAURI_ENV_PLATFORM;
const appPlatform = normalizePlatform(buildPlatform);

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

type RoutePage = Page | "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";

type AppSearch = {
  assetSection?: AssetSection;
  settingsSection?: SettingsSection;
  quotaProvider?: string;
  quotaWindow?: QuotaWindowSelector;
  gitSubview?: GitSubview;
};

export function AppShell() {
  useTranslation();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false }) as AppSearch;
  const route = parseRoute(location.pathname);
  const workspaceRouteId = route.kind === "workspace" ? route.workspaceId : undefined;
  const workspaceRoutePage = route.kind === "workspace" ? route.page : undefined;
  const page = route.kind === "workspace" ? route.page : "overview";
  const routeGlobalPage = route.kind === "global" ? route.page : "home";
  const [pendingGlobalPage, setPendingGlobalPage] = useState<GlobalPage>();
  const globalPage = pendingGlobalPage ?? routeGlobalPage;
  const appMode = route.kind === "settings" ? "settings" : "main";
  const gitSubview = search.gitSubview;
  const settingsSection = search.settingsSection ?? "general";
  const quotaProvider = search.quotaProvider;
  const quotaWindow = search.quotaWindow;
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    sidebarCollapsed, setSidebarCollapsed, isFullscreen, setIsFullscreen, runtime, setRuntime,
    workspaces, setWorkspaces, installations, setInstallations, doctorSummaries, setDoctorSummaries,
    catalog, setCatalog, globalMemories, setGlobalMemories, activity, setActivity, scanRoots, setScanRoots,
    excluded, setExcluded, discovery, setDiscovery, remoteGateways, setRemoteGateways,
    insightsSummary, setInsightsSummary, insightsStatus, setInsightsStatus, quotaStatus, setQuotaStatus,
    navigationRequest, setNavigationRequest, menuCommand, setMenuCommand, refreshJobs, setRefreshJobs, setQuotaConfigureRequest,
  } = appStore;
  const {
    project, setProject, selectedWorkspace, setSelectedWorkspace, scan, setScan, manifest, setManifest,
    setChangeSet, setChangeSetOrigin, setHandoffLaunchRequest,
    baselineManifest, setBaselineManifest, workspaceDrafts, setWorkspaceDrafts, message, setMessage,
    busy, setBusy, applyingChanges,
  } = workspaceStore;
  const pendingRefreshKinds = useRef(new Set<string>());
  const quitPromptOpen = useRef(false);
  const groupedCatalog = useMemo(() => groupCatalogAssets(catalog), [catalog]);
  const assetCounts = useMemo(() => workspaceAssetCounts(groupedCatalog), [groupedCatalog]);

  const updateSearch = (patch: Partial<AppSearch>) => {
    void navigate({ to: location.pathname as never, search: (current) => ({ ...current, ...patch }) as never });
  };
  const navigateGlobalPage = (nextPage: GlobalPage) => {
    setPendingGlobalPage(nextPage);
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never });
  };
  const navigateWorkspacePageFor = (workspaceId: string, nextPage: Page) => {
    const path = nextPage === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${nextPage}`;
    void navigate({ to: path as never, params: { workspaceId } as never });
  };
  const setGlobalPage = (nextPage: GlobalPage) => navigateGlobalPage(nextPage);
  const setAppMode = (nextMode: "main" | "settings") => {
    if (nextMode === "settings") void navigate({ to: "/settings", search: (current) => current });
    else navigateGlobalPage(globalPage);
  };
  const setGitSubview = (nextSubview: GitSubview | undefined) => updateSearch({ gitSubview: nextSubview });
  const setSettingsSection = (nextSection: SettingsSection) => updateSearch({ settingsSection: nextSection });
  const setQuotaProvider = (nextProvider: string | undefined) => updateSearch({ quotaProvider: nextProvider });
  const setQuotaWindow = (nextWindow: QuotaWindowSelector | undefined) => updateSearch({ quotaWindow: nextWindow });

  useEffect(() => {
    if (pendingGlobalPage === routeGlobalPage) setPendingGlobalPage(undefined);
  }, [pendingGlobalPage, routeGlobalPage]);

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
    const nextRuntimePromise = useAppStore.getState().runtime ? Promise.resolve(useAppStore.getState().runtime) : api.runtime();
    const [nextWorkspaces, nextInstallations, nextCatalog, nextMemories, nextActivity, nextRoots, nextExcluded, nextRuntime, nextRemoteGateways] = await Promise.all([
      api.workspaces(), api.agentInstallations(), api.catalogAssets(), api.globalMemories(), api.activity(), api.scanRoots(), api.excludedWorkspaces(), nextRuntimePromise, api.remoteGateways(),
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
      void navigate({ to: "/settings", search: { settingsSection: navigationRequest.settings_section ?? "general" } as never });
      setNavigationRequest(undefined);
      return;
    }
    if (navigationRequest.page === "quota") {
      navigateGlobalWithSearch("quota", { quotaProvider: navigationRequest.provider, quotaWindow: navigationRequest.window });
      if (navigationRequest.configure_popover) setQuotaConfigureRequest((value) => value + 1);
    } else {
      navigateGlobal(navigationRequest.page);
    }
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
      const runtimePromise = useAppStore.getState().runtime ? Promise.resolve(useAppStore.getState().runtime) : api.runtime();
      const [nextScan, nextRuntime] = await Promise.all([api.scan(workspace.path), runtimePromise]);
      let nextManifest: Manifest | undefined;
      try { nextManifest = await api.manifest(workspace.path); }
      catch (error) { setMessage(localizeMessage(error)); }
      setGitSubview(undefined); setChangeSet(undefined); setChangeSetOrigin("standard"); setHandoffLaunchRequest(undefined); setProject(workspace.path); setScan(nextScan);
      setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined); setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : ""); setRuntime(nextRuntime);
      // Commit the route last so the workspace list remains visible while native scanning runs.
      setSelectedWorkspace(workspace);
      navigateWorkspacePageFor(workspace.id, nextManifest ? initialPage : "doctor");
    } catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (route.kind !== "workspace" || selectedWorkspace?.id === workspaceRouteId || !workspaces.length || !workspaceRouteId) return;
    const workspace = workspaces.find((item) => item.id === workspaceRouteId);
    if (workspace) void openWorkspace(workspace, workspaceRoutePage ?? "overview");
    else setMessage(tr("workspace.notFound"));
  }, [route.kind, workspaceRouteId, workspaceRoutePage, selectedWorkspace?.id, workspaces]);
  const closeWorkspace = () => void leaveWorkspace(() => setGlobalPage("workspaces"));
  const navigateGlobalWithSearch = (nextPage: GlobalPage, patch: Partial<AppSearch> = {}) => {
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never, search: (current) => ({ ...current, ...patch }) as never });
  };
  const navigateGlobal = (nextPage: GlobalPage, preserveQuotaSelection = false) => {
    const next = () => navigateGlobalWithSearch(nextPage, preserveQuotaSelection ? { quotaProvider, quotaWindow } : { quotaProvider: undefined, quotaWindow: undefined });
    selectedWorkspace ? void leaveWorkspace(next) : next();
  };
  const openSettings = () => setAppMode("settings");

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
  const mainClass = "!col-start-2 !row-start-1 !min-h-0 !min-w-0 !h-full !overflow-x-hidden !overflow-y-auto !overscroll-contain !text-sm";
  const pageHeaderClass = cn(
    "page-header !sticky !top-0 !z-10 !flex !min-h-[58px] !h-[58px] !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
    sidebarCollapsed ? "!pl-[132px]" : "!pl-7",
  );
  const contentClass = "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";
  if (route.kind === "workspace" || appMode === "settings") return <Outlet />;

  const discoveryFailure = refreshJobs.find((job) => job.kind === "discovery" && job.state === "failed");
  return <div className={shellClass}><WindowToolbar platform={appPlatform} fullscreen={isFullscreen} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} /><AppSidebar active={globalPage} entries={navigation} collapsed={sidebarCollapsed} platform={appPlatform} onNavigate={navigateGlobal} onSettings={openSettings} />{!sidebarCollapsed && <Button className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}<main className={mainClass}><header className={pageHeaderClass} data-tauri-drag-region />{message && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><CircleAlert size={17} />{message}</div>}{globalPage === "workspaces" && discoveryFailure?.error && <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{discoveryFailure.error}</div>}<section className={cn(contentClass, "")}><Outlet /></section></main></div>;

  async function addScanRootFromDialog() { const selected = await open({ directory: true, multiple: false, title: tr("dialog.addScanRoot") }); if (typeof selected === "string") { await api.addScanRoot(selected, 5); await loadGlobal(); await refreshDiscovery(); } }
}

type ParsedRoute =
  | { kind: "settings" }
  | { kind: "global"; page: GlobalPage }
  | { kind: "workspace"; workspaceId: string; page: Page };

function parseRoute(pathname: string): ParsedRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "settings") return { kind: "settings" };
  if (segments[0] === "workspace" && segments[1]) {
    const page = segments[2];
    const workspacePage: Page = page === "sessions" || page === "git" || page === "assets" || page === "context" || page === "doctor" || page === "changes" ? page : "overview";
    return { kind: "workspace", workspaceId: segments[1], page: workspacePage };
  }
  const page = segments[0];
  const globalPage: GlobalPage = page === "workspaces" || page === "catalog" || page === "agents" || page === "quota" || page === "insights" ? page : "home";
  return { kind: "global", page: globalPage };
}

export function GlobalHome({ workspaces, doctorSummaries, installations, memories, discovery, activity, insights, uniqueAssetCount, assetCounts, onShowInsights, onShowWorkspaces, onShowAgents, onOpen, onOpenDoctor, onOpenAssets, onAddRoot }: { workspaces: WorkspaceSummary[]; doctorSummaries: Record<string, ContextDoctorSummary>; installations: AgentInstallation[]; memories: MemoryRecord[]; discovery?: DiscoveryReport; activity: ActivityRecord[]; insights?: InsightsSummary; uniqueAssetCount: number; assetCounts: Map<string, number>; onShowInsights: () => void; onShowWorkspaces: () => void; onShowAgents: () => void; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>; onOpenAssets: (section: AssetSection) => void; onAddRoot: () => Promise<void> }) {
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

function WorkspaceRow({ workspace, assetCount, onOpen }: { workspace: WorkspaceSummary; assetCount?: number; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  const sourceAgents = workspace.sources.map((source) => source.agent).filter((value): value is AgentKind => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index);
  const agents = sourceAgents.map((value) => agentLabels[value]).join(" · ") || (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return <Button variant="bare" size="content" className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/40" onClick={() => void onOpen(workspace)}><div className="grid size-9 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:bg-muted"><FolderGit2 size={18} /></div><div className="min-w-0"><strong className="block truncate text-sm font-semibold">{workspace.name}</strong><small className="block truncate text-xs text-muted-foreground" title={workspace.path}>{workspace.path}</small><span className="block truncate text-xs text-muted-foreground">{agents} · {tr("workspace.assetCount", { count })} · {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span></div>{workspace.status === "attention" && <span className="text-xs font-medium text-amber-700">{workspaceStatusLabel("attention")}</span>}<ChevronRight className="text-muted-foreground" size={15} /></Button>;
}

function ActivityRow({ record }: { record: ActivityRecord }) { const key = `activity.action.${record.action}`; return <div className="flex items-start gap-3 rounded-lg border border-border p-3"><span className="mt-1 size-2 shrink-0 rounded-full bg-primary" /><div><strong>{tr(key, { defaultValue: record.action })}</strong><small title={record.detail}>{record.detail}</small></div><time>{formatDateTime(record.created_at)}</time></div>; }

function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓库 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
function formatCompact(value: number) { return formatCompactNumber(value); }
function workspaceStatusLabel(status: WorkspaceSummary["status"]) { return tr(`status.workspace.${status}`); }
function relativeTime(value: string) { return formatRelativeTime(value); }
