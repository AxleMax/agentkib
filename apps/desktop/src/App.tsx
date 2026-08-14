import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity, Award, Bot, Boxes, Brain, CalendarCheck2, CalendarDays, Check, ChevronRight, CircleAlert, Code2, Copy, FileCode2, Flame, FolderGit2, Gauge, GitCommitHorizontal, GitCompareArrows, History, Home, LayoutDashboard, Library, LockKeyhole, MessageSquareText, Moon, MoreHorizontal, Network, Pencil, PlugZap, RefreshCw, RotateCcw, Search, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import { api } from "./api";
import { achievementReached, buildAchievementTracks, buildSpecialAchievements, type AchievementCategory, type AchievementTrack, type SpecialAchievement } from "./achievements";
import { AgentIcon } from "./components/AgentIcon";
import { AppSidebar, type SidebarEntry } from "./components/AppSidebar";
import { SettingsSidebar, settingsSectionLabel, type SettingsSection } from "./components/SettingsSidebar";
import { WindowToolbar } from "./components/WindowToolbar";
import { ObsidianSettingsCard, WorkspaceObsidianCard } from "./components/ObsidianIntegration";
import { RemoteGatewaysSettings } from "./components/RemoteGateways";
import { QuotaDiagnostics, QuotaPage } from "./components/QuotaPage";
import { groupCatalogAssets, workspaceAssetCounts, type CatalogAssetGroup } from "./catalog";
import { diffLines } from "./diff";
import { changeLocale, formatCompactNumber, formatDateTime, formatRelativeTime, localizeMessage, tr } from "./i18n";
import { buildHeatmapMonthMarkers } from "./insights";
import { applyTheme } from "./theme";
import type { Achievement, ActivityRecord, AgentInstallation, AgentKind, AgentUsageBreakdown, CatalogAsset, ChangeSet, CloseBehavior, ConnectionDefinition, ContextPreview, DiscoveryReport, EffectiveTheme, ExcludedWorkspace, GitIdentitySummary, HeatmapPoint, InsightsQuery, InsightsStatus, InsightsSummary, LocalePreference, Manifest, McpInstallation, McpRegistryEntry, McpRuntimeStatus, McpServerConfig, MemoryRecord, MemoryType, ModelUsageBreakdown, QuotaCollectorStatus, RefreshJobStatus, RemoteGatewaySummary, RepositoryCommitBreakdown, RuntimeInfo, ScanRoot, ThemePreference, UsageQuality, WorkspaceScan, WorkspaceSummary, WorkspaceUsageBreakdown } from "./types";

type Page = "overview" | "assets" | "context" | "changes";
type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
type AppMode = "main" | "settings";
type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
type WorkspaceAssetSection = "instructions" | "skills" | "mcp" | "native";
type AgentDetailSection = "overview" | "assets" | "workspaces" | "usage";

const agentLabels: Record<AgentKind, string> = { codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", "open-claw": "OpenClaw", hermes: "Hermes" };
const workspaceTabs = [
  ["overview", "nav.overview", LayoutDashboard], ["assets", "nav.assets", Boxes],
  ["context", "nav.context", Code2], ["changes", "nav.changes", GitCompareArrows],
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
  const [page, setPage] = useState<Page>("overview"); const [globalPage, setGlobalPage] = useState<GlobalPage>("home");
  const [appMode, setAppMode] = useState<AppMode>("main");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("agentkib.sidebar.collapsed") === "true");
  const [project, setProject] = useState(""); const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSummary>();
  const [scan, setScan] = useState<WorkspaceScan>();
  const [manifest, setManifest] = useState<Manifest>();
  const [changeSet, setChangeSet] = useState<ChangeSet>();
  const [baselineManifest, setBaselineManifest] = useState("");
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Record<string, Manifest>>({});
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]); const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [catalog, setCatalog] = useState<CatalogAsset[]>([]); const [globalMemories, setGlobalMemories] = useState<MemoryRecord[]>([]); const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [scanRoots, setScanRoots] = useState<ScanRoot[]>([]); const [excluded, setExcluded] = useState<ExcludedWorkspace[]>([]); const [discovery, setDiscovery] = useState<DiscoveryReport>();
  const [remoteGateways, setRemoteGateways] = useState<RemoteGatewaySummary[]>([]);
  const [insightsSummary, setInsightsSummary] = useState<InsightsSummary>();
  const [insightsStatus, setInsightsStatus] = useState<InsightsStatus>();
  const [quotaStatus, setQuotaStatus] = useState<QuotaCollectorStatus>();
  const [quotaProvider, setQuotaProvider] = useState<string>();
  const [navigationRequest, setNavigationRequest] = useState<{ page: string; provider?: string }>();
  const [refreshJobs, setRefreshJobs] = useState<RefreshJobStatus[]>([]);
  const [assetSection, setAssetSection] = useState<AssetSection>("instructions");
  const [workspaceAssetSection, setWorkspaceAssetSection] = useState<WorkspaceAssetSection>("instructions");
  const [insightsSection, setInsightsSection] = useState<InsightsSection>("overview");
  const pendingRefreshKinds = useRef(new Set<string>());
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
  };

  useEffect(() => {
    let disposed = false; let refreshReloadTimer: number | undefined; let unlisten: (() => void) | undefined; let unlistenRefresh: (() => void) | undefined; let unlistenInsights: (() => void) | undefined; let unlistenGateways: (() => void) | undefined; let unlistenQuota: (() => void) | undefined; let unlistenNavigate: (() => void) | undefined; let unlistenTheme: (() => void) | undefined;
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
        unlistenNavigate = await listen<{ page: string; provider?: string }>("agentkib:navigate", (event) => { setNavigationRequest(event.payload); });
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
        await api.requestRefresh("discovery");
      } catch (error) { if (!disposed) setMessage(localizeMessage(error)); }
    })();
    return () => { disposed = true; window.clearTimeout(refreshReloadTimer); unlisten?.(); unlistenRefresh?.(); unlistenInsights?.(); unlistenGateways?.(); unlistenQuota?.(); unlistenNavigate?.(); unlistenTheme?.(); };
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
  useEffect(() => {
    if (navigationRequest?.page !== "quota") return;
    if (selectedWorkspace && manifest && hasUnsavedDraft) {
      setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
    }
    setSelectedWorkspace(undefined); setProject(""); setScan(undefined); setManifest(undefined); setChangeSet(undefined); setBaselineManifest("");
    setQuotaProvider(navigationRequest.provider); setGlobalPage("quota"); setAppMode("main"); setNavigationRequest(undefined);
  }, [navigationRequest]);
  const persistWorkspaceDraft = () => {
    if (selectedWorkspace && manifest && hasUnsavedDraft) setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
  };
  const leaveWorkspace = (next: () => void) => {
    if (hasUnsavedDraft && !window.confirm(tr("workspace.leaveDraftConfirm"))) return;
    if (selectedWorkspace) setWorkspaceDrafts((drafts) => { const nextDrafts = { ...drafts }; delete nextDrafts[selectedWorkspace.id]; return nextDrafts; });
    setSelectedWorkspace(undefined); setProject(""); setScan(undefined); setManifest(undefined); setChangeSet(undefined); setBaselineManifest(""); next();
  };
  const openWorkspace = async (workspace: WorkspaceSummary) => {
    persistWorkspaceDraft(); setBusy(true); setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([api.scan(workspace.path), api.manifest(workspace.path), api.runtime()]);
      setPage("overview"); setChangeSet(undefined); setProject(workspace.path); setScan(nextScan);
      setManifest(workspaceDrafts[workspace.id] ?? nextManifest); setBaselineManifest(JSON.stringify(nextManifest)); setRuntime(nextRuntime);
      // Commit the route last so the workspace list remains visible while native scanning runs.
      setSelectedWorkspace(workspace);
    } catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };
  const closeWorkspace = () => leaveWorkspace(() => setGlobalPage("workspaces"));
  const navigateGlobal = (nextPage: GlobalPage) => {
    if (nextPage === "quota") setQuotaProvider(undefined);
    selectedWorkspace ? leaveWorkspace(() => setGlobalPage(nextPage)) : setGlobalPage(nextPage);
  };
  const openSettings = () => setAppMode("settings");

  const plan = async (includeHome = false) => {
    if (!project || !manifest) return;
    setBusy(true); setMessage("");
    try { const changes = await api.plan(project, manifest, includeHome); setChangeSet(changes); setPage("changes"); }
    catch (error) { setMessage(localizeMessage(error)); }
    finally { setBusy(false); }
  };
  const refreshDiscovery = async () => { setMessage(""); try { await api.requestRefresh("discovery", true); } catch (error) { setMessage(localizeMessage(error)); } };
  const discoveryRefreshing = refreshJobs.some((job) => job.kind === "discovery" && (job.state === "queued" || job.state === "running"));

  const navigation = globalNav.map((entry) => entry.id === "catalog" ? { ...entry, badge: globalMemories.filter((item) => item.status === "pending").length } : entry);
  const shellClass = `app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`;
  if (appMode === "settings") return (
    <div className={`${shellClass} settings-shell`}>
      <WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <SettingsSidebar active={settingsSection} collapsed={sidebarCollapsed} onSelect={setSettingsSection} onBack={() => setAppMode("main")} />
      {!sidebarCollapsed && <button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main>
        <header className="page-header" data-tauri-drag-region>
          <div className="page-title-row"><h1>{settingsSectionLabel(settingsSection)}</h1></div>
        </header>
        {message && <div className="alert"><CircleAlert size={17} />{message}</div>}
        <section className={`content settings-content${settingsSection === "general" ? " compact" : ""}`}>
          <GlobalSettings section={settingsSection} runtime={runtime} discovery={discovery} insightsStatus={insightsStatus} quotaStatus={quotaStatus} remoteGateways={remoteGateways} scanRoots={scanRoots} excluded={excluded} activity={activity} onAddRoot={addScanRootFromDialog} onRemoveRoot={async (id) => { await api.removeScanRoot(id); await loadGlobal(); await refreshDiscovery(); }} onRestore={async (path) => { await api.restoreExcludedWorkspace(path); await loadGlobal(); await refreshDiscovery(); }} onCloseBehaviorChanged={async (behavior) => { await api.setCloseBehavior(behavior); await loadGlobal(); }} onLocaleChanged={setRuntime} onRemoteGatewaysChanged={loadGlobal} />
        </section>
      </main>
    </div>
  );
  if (selectedWorkspace && project && scan && manifest) return (
    <div className={shellClass}>
      <WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <AppSidebar active="workspaces" entries={navigation} collapsed={sidebarCollapsed} onNavigate={navigateGlobal} onSettings={openSettings} />
      {!sidebarCollapsed && <button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}
      <main>
        <header className="page-header workspace-header" data-tauri-drag-region><div className="page-title-row"><button className="breadcrumb" onClick={closeWorkspace}>{tr("nav.workspaces")}</button><span className="breadcrumb-separator">/</span><h1>{selectedWorkspace.name}</h1></div><div className="header-actions">{selectedWorkspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}<details className="row-menu header-menu"><summary title={tr("common.moreActions")} aria-label={tr("common.moreActions")}><MoreHorizontal size={16} /></summary><div><button className="menu-neutral" onClick={() => void navigator.clipboard?.writeText(selectedWorkspace.path)}><Copy size={13} />{tr("workspace.copyPath")}</button></div></details><button className="ghost icon-only" title={tr("common.scan")} aria-label={tr("common.scan")} onClick={() => load(project, manifest)} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} /></button><button className="primary" onClick={() => plan(false)} disabled={busy || !hasUnsavedDraft}><GitCompareArrows size={15} />{tr("workspace.reviewChanges")}</button></div></header>
        {message && <div className="alert"><CircleAlert size={17} />{message}</div>}
        <div className="workspace-tabs" role="tablist" aria-label={selectedWorkspace.name} onKeyDown={handleTabKey}>{workspaceTabs.map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={page === id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={15} />{tr(label)}{id === "changes" && changeSet?.changes.length ? <em>{changeSet.changes.length}</em> : null}</button>)}</div>
        <section className="content workspace-content">
          {page === "overview" && <Overview workspace={selectedWorkspace} scan={scan} manifest={manifest} />}
          {page === "assets" && <Assets section={workspaceAssetSection} onSection={setWorkspaceAssetSection} scan={scan} manifest={manifest} onChange={setManifest} />}
          {page === "context" && <ContextPage project={project} onOpenInstructions={() => { setWorkspaceAssetSection("instructions"); setPage("assets"); }} />}
          {page === "changes" && <Changes changeSet={changeSet} onPlanHome={() => plan(true)} onApplied={async () => { await load(); await loadGlobal(); }} onRejected={() => setChangeSet(undefined)} />}
        </section>
      </main>
    </div>
  );

  const discoveryFailure = refreshJobs.find((job) => job.kind === "discovery" && job.state === "failed");
  const headerAction = globalPage === "workspaces" ? <>{discoveryRefreshing && <span className="badge">{tr("tray.refreshing")}</span>}<button className="ghost icon-only" title={tr("workspace.refreshDiscovery")} aria-label={tr("workspace.refreshDiscovery")} onClick={() => void refreshDiscovery()} disabled={discoveryRefreshing}><RefreshCw size={15} className={discoveryRefreshing ? "spin" : ""} /></button><button className="primary" onClick={() => void selectProject()}><FolderGit2 size={15} />{tr("workspace.addManually")}</button></> : null;
  return <div className={`${shellClass} global-shell`}><WindowToolbar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} /><AppSidebar active={globalPage} entries={navigation} collapsed={sidebarCollapsed} onNavigate={navigateGlobal} onSettings={openSettings} />{!sidebarCollapsed && <button className="sidebar-backdrop" type="button" aria-label={tr("common.closeSidebar")} onClick={() => setSidebarCollapsed(true)} />}<main><header className="page-header" data-tauri-drag-region><div className="page-title-row"><h1>{tr(globalNav.find(({ id }) => id === globalPage)?.label ?? "nav.home")}</h1></div><div className="header-actions">{headerAction}</div></header>{message && <div className="alert"><CircleAlert size={17} />{message}</div>}{globalPage === "workspaces" && discoveryFailure?.error && <div className="alert"><CircleAlert size={17} />{discoveryFailure.error}</div>}<section className="content global-content">
    {globalPage === "home" && <GlobalHome workspaces={workspaces} installations={installations} memories={globalMemories} discovery={discovery} activity={activity} insights={insightsSummary} uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length} assetCounts={assetCounts} onShowInsights={() => setGlobalPage("insights")} onShowWorkspaces={() => setGlobalPage("workspaces")} onShowAgents={() => setGlobalPage("agents")} onOpen={openWorkspace} onOpenAssets={(section) => { setAssetSection(section); setGlobalPage("catalog"); }} onAddRoot={async () => { await addScanRootFromDialog(); }} />}
    {globalPage === "workspaces" && <WorkspacesPage workspaces={workspaces} assetCounts={assetCounts} onOpen={openWorkspace} onRefresh={async (id) => { await api.refreshWorkspace(id); await loadGlobal(); }} onExclude={async (id) => { if (!window.confirm(tr("workspace.ignoreConfirm"))) return; await api.excludeWorkspace(id); await loadGlobal(); }} />}
    {globalPage === "agents" && <AgentsPage installations={installations} assets={catalog.filter((asset) => asset.scope === "agent-home")} workspaces={workspaces} remoteGateways={remoteGateways} insightsStatus={insightsStatus} onOpen={openWorkspace} />}
    {globalPage === "catalog" && <GlobalAssetsPage section={assetSection} onSection={setAssetSection} assets={catalog} workspaces={workspaces} memories={globalMemories} runtime={runtime} onReload={loadGlobal} onRuntimeChanged={setRuntime} onOpen={(id) => { const workspace = workspaces.find((item) => item.id === id); if (workspace) void openWorkspace(workspace); }} onMigrationPlanned={async (workspacePath, planned) => { const workspace = workspaces.find((item) => item.path === workspacePath); if (!workspace) return; await openWorkspace(workspace); setChangeSet(planned); setPage("changes"); }} />}
    {globalPage === "quota" && <QuotaPage initialProvider={quotaProvider} />}
    {globalPage === "insights" && <div className="insights-host" data-view={insightsSection}><div className="section-tabs insights-section-tabs" role="tablist" aria-label={tr("nav.insights")} onKeyDown={handleTabKey}>{(["overview", "tokens", "commits", "milestones", "sources"] as InsightsSection[]).map((section) => <button key={section} role="tab" aria-selected={insightsSection === section} className={insightsSection === section ? "active" : ""} onClick={() => setInsightsSection(section)}>{tr(`insights.section.${section}`)}</button>)}</div><InsightsPage section={insightsSection} workspaces={workspaces} onSummary={setInsightsSummary} /></div>}
  </section></main></div>;

  async function addScanRootFromDialog() { const selected = await open({ directory: true, multiple: false, title: tr("dialog.addScanRoot") }); if (typeof selected === "string") { await api.addScanRoot(selected, 5); await loadGlobal(); await refreshDiscovery(); } }
}

function GlobalHome({ workspaces, installations, memories, discovery, activity, insights, uniqueAssetCount, assetCounts, onShowInsights, onShowWorkspaces, onShowAgents, onOpen, onOpenAssets, onAddRoot }: { workspaces: WorkspaceSummary[]; installations: AgentInstallation[]; memories: MemoryRecord[]; discovery?: DiscoveryReport; activity: ActivityRecord[]; insights?: InsightsSummary; uniqueAssetCount: number; assetCounts: Map<string, number>; onShowInsights: () => void; onShowWorkspaces: () => void; onShowAgents: () => void; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onOpenAssets: (section: AssetSection) => void; onAddRoot: () => Promise<void> }) {
  const attention = workspaces.filter((item) => item.status === "attention");
  const pending = memories.filter((item) => item.status === "pending").length;
  const issueCount = attention.length + pending;
  const importantActions = new Set(["changeset.apply", "changeset.apply_failed", "memory.propose", "memory.review", "workspace.exclude"]);
  const importantActivity = activity.filter((item) => importantActions.has(item.action)).slice(0, 5);
  const insightCard = insights && <button className="panel home-achievement" onClick={onShowInsights}><div className="achievement-orb"><Award size={21} /></div><div><span>{tr("home.journey")}</span>{insights.total_tokens || insights.my_commits ? <div className="home-achievement-values"><strong>{insights.quality === "incomplete" ? "≥ " : ""}{formatCompact(insights.total_tokens)} Token</strong><strong>{insights.my_commits} {tr("insights.myCommits")}</strong></div> : <h2>{tr("home.insightsEmpty")}</h2>}<p>{tr("home.streak", { active: insights.active_days, current: insights.current_streak, longest: insights.longest_streak })}</p></div><ChevronRight size={16} /></button>;
  return <div className="stack home-dashboard">
    {issueCount > 0 ? <section className="attention-panel has-issues"><div className="attention-heading"><span><CircleAlert size={18} /><strong>{tr("home.needsAttention")}</strong></span><em>{issueCount}</em></div><div className="attention-items">{attention.slice(0, 4).map((workspace) => <button key={workspace.id} onClick={() => void onOpen(workspace)}><FolderGit2 size={15} /><span><strong>{workspace.name}</strong><small>{tr("home.workspaceWarnings", { count: workspace.warning_count })}</small></span><ChevronRight size={14} /></button>)}{pending > 0 && <button onClick={() => onOpenAssets("memory")}><Brain size={15} /><span><strong>{tr("home.pendingMemory")}</strong><small>{tr("home.pendingMemoryDetail", { count: pending })}</small></span><ChevronRight size={14} /></button>}</div></section> : <div className="attention-clear compact"><Check size={18} /><strong>{tr("home.allClear")}</strong></div>}
    <div className="summary-strip three"><button onClick={onShowWorkspaces}><span>{tr("home.workspaceMetric")}</span><strong>{workspaces.length}</strong></button><button onClick={() => onOpenAssets("instructions")}><span>{tr("home.assetMetric")}</span><strong>{uniqueAssetCount}</strong></button><button onClick={onShowAgents}><span>{tr("home.installedAgents")}</span><strong>{installations.filter((item) => item.installed).length} / {Object.keys(agentLabels).length}</strong></button></div>
    {!workspaces.length ? <>{insightCard}<div className="panel empty-global"><FolderGit2 size={30} /><h2>{tr("home.emptyTitle")}</h2><p>{tr("home.emptyText")}</p><button className="primary" onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</button></div></> : <div className={`home-main-grid${!insightCard && !importantActivity.length ? " single-column" : ""}`}><div className="panel"><div className="panel-head"><h2>{tr("home.recentWorkspaces")}</h2><span className="badge">{discovery ? tr("home.updated", { time: relativeTime(discovery.finished_at) }) : tr("home.discovering")}</span></div><div className="workspace-list">{workspaces.slice(0, 5).map((workspace) => <WorkspaceRow key={workspace.id} mode="compact" workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} />)}</div></div>{(insightCard || importantActivity.length > 0) && <div className="home-side-stack">{insightCard}{importantActivity.length > 0 && <div className="panel"><div className="panel-head"><h2>{tr("home.recentActivity")}</h2></div><div className="activity-list compact">{importantActivity.map((item) => <ActivityRow key={item.id} record={item} />)}</div></div>}</div>}</div>}
  </div>;
}

function WorkspacesPage({ workspaces, assetCounts, onOpen, onRefresh, onExclude }: { workspaces: WorkspaceSummary[]; assetCounts: Map<string, number>; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onRefresh: (id: string) => Promise<void>; onExclude: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all"); const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const filtered = workspaces.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || item.status === status) && (agent === "all" || item.sources.some((source) => source.agent === agent)));
  const groups = useMemo(() => { const values = new Map<string, WorkspaceSummary[]>(); for (const item of filtered) { const key = item.repository_group_id ?? `workspace:${item.id}`; values.set(key, [...(values.get(key) ?? []), item]); } return [...values.values()]; }, [filtered]);
  return <div className="stack workspace-index"><div className="panel"><div className="toolbar sticky-toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("workspace.searchPlaceholder")} /></div><span className="result-count">{tr("workspace.resultCount", { count: filtered.length })}</span><div className="toolbar-filters"><select className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select className="setting-select" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">{tr("workspace.allStatuses")}</option><option value="healthy">{workspaceStatusLabel("healthy")}</option><option value="attention">{workspaceStatusLabel("attention")}</option></select></div></div><div className="workspace-column-head" aria-hidden="true"><span>{tr("workspace.projectColumn")}</span><span>{tr("workspace.agentColumn")}</span><span>{tr("workspace.assetsColumn")}</span><span>{tr("workspace.activityColumn")}</span><span /></div><div className="repository-groups">{groups.map((group) => { const grouped = group.length > 1; return <section className={grouped ? "" : "single-workspace-group"} key={group[0].repository_group_id ?? group[0].id}>{grouped && <header><FolderGit2 size={15} /><strong>{group[0].name}</strong><span>{tr("workspace.worktrees", { count: group.length })}</span></header>}{group.map((workspace) => <div className="workspace-card" key={workspace.id}><WorkspaceRow mode="columns" workspace={workspace} assetCount={assetCounts.get(workspace.id)} onOpen={onOpen} /><details className="row-menu"><summary title={tr("common.moreActions")} aria-label={tr("common.moreActions")}><MoreHorizontal size={15} /></summary><div><button className="menu-neutral" onClick={() => void onRefresh(workspace.id)}><RefreshCw size={13} />{tr("common.scan")}</button><button onClick={() => void onExclude(workspace.id)}><Trash2 size={13} />{tr("workspace.ignore")}</button></div></details></div>)}</section>; })}{!groups.length && <Empty compact icon={FolderGit2} title={tr("workspace.noMatch")} text={tr("workspace.noMatchText")} />}</div></div></div>;
}

function WorkspaceRow({ workspace, assetCount, mode = "compact", onOpen }: { workspace: WorkspaceSummary; assetCount?: number; mode?: "compact" | "columns"; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  const agents = workspace.sources.map((source) => source.agent ? agentLabels[source.agent] : tr("workspace.source.scan")).filter((value, index, values) => values.indexOf(value) === index).join(" · ") || tr("workspace.source.manual");
  const count = assetCount ?? workspace.asset_count;
  if (mode === "columns") return <button className="workspace-row workspace-row-columns" onClick={() => void onOpen(workspace)}><span className="workspace-primary"><strong>{workspace.name}</strong><small>{workspace.path}</small></span><span className="workspace-agents">{agents}</span><span>{count}</span><span>{workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span>{workspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}</button>;
  return <button className="workspace-row" onClick={() => void onOpen(workspace)}><div className="workspace-icon"><FolderGit2 size={18} /></div><div><strong>{workspace.name}</strong><small>{workspace.path}</small><span>{agents} · {tr("workspace.assetCount", { count })} · {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</span></div>{workspace.status === "attention" && <span className="workspace-status attention">{workspaceStatusLabel("attention")}</span>}<ChevronRight size={15} /></button>;
}

function AgentsPage({ installations, assets, workspaces, remoteGateways, insightsStatus, onOpen }: { installations: AgentInstallation[]; assets: CatalogAsset[]; workspaces: WorkspaceSummary[]; remoteGateways: RemoteGatewaySummary[]; insightsStatus?: InsightsStatus; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  const agentKinds: AgentKind[] = ["codex", "claude-code", "cursor", "open-claw", "hermes"];
  const [selected, setSelected] = useState<AgentKind>("codex");
  const [section, setSection] = useState<AgentDetailSection>("overview");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetKind, setAssetKind] = useState("all");
  const installation = installations.find((item) => item.agent === selected);
  const provider = insightsStatus?.providers.find((item) => item.agent === selected);
  const homeAssets = assets.filter((item) => item.agent === selected);
  const assetKinds = [...new Set(homeAssets.map((item) => item.kind))].sort();
  const visibleHomeAssets = homeAssets.filter((item) => `${item.name} ${item.path} ${item.kind}`.toLowerCase().includes(assetQuery.toLowerCase()) && (assetKind === "all" || item.kind === assetKind));
  const linkedWorkspaces = workspaces.filter((workspace) => workspace.sources.some((source) => source.agent === selected));
  const recentLinkedWorkspaces = [...linkedWorkspaces].sort((left, right) => (right.last_active_at ?? "").localeCompare(left.last_active_at ?? "")).slice(0, 5);
  const homeAssetKinds = [...homeAssets.reduce((counts, asset) => counts.set(asset.kind, (counts.get(asset.kind) ?? 0) + 1), new Map<string, number>()).entries()].sort((left, right) => right[1] - left[1]);
  const selectedRemoteGateways = remoteGateways.filter((gateway) => gateway.kind === selected);
  const remoteWorkspaceCount = selectedRemoteGateways.reduce((total, gateway) => total + gateway.workspaces.length, 0);
  return <div className="agent-master-detail">
    <div className="panel agent-master-list">{agentKinds.map((agent) => { const item = installations.find((value) => value.agent === agent); const remoteCount = remoteGateways.filter((gateway) => gateway.kind === agent).reduce((total, gateway) => total + gateway.workspaces.length, 0); const count = workspaces.filter((workspace) => workspace.sources.some((source) => source.agent === agent)).length + remoteCount; return <button key={agent} className={selected === agent ? "active" : ""} onClick={() => { setSelected(agent); setSection("overview"); }}><AgentIcon agent={agent} /><span><strong>{agentLabels[agent]}</strong><small>{count} {tr("common.workspaces")}</small></span><span className={item?.installed ? "ready" : "status neutral"}>{tr(item?.installed ? "common.installed" : "common.notInstalled")}</span><ChevronRight size={15} /></button>; })}</div>
    <section className="panel agent-detail"><div className="agent-detail-head"><AgentIcon agent={selected} /><h2>{agentLabels[selected]}</h2>{installation?.version && <span className="agent-version">{installation.version}</span>}</div><div className="section-tabs agent-detail-tabs" role="tablist" aria-label={agentLabels[selected]} onKeyDown={handleTabKey}>{(["overview", "assets", "workspaces", "usage"] as AgentDetailSection[]).map((value) => <button role="tab" aria-selected={section === value} className={section === value ? "active" : ""} key={value} onClick={() => setSection(value)}>{tr(`agents.section.${value}`)}</button>)}</div>
      {section === "overview" && <><div className="agent-facts three"><div><span>{tr("agents.linkedWorkspaces")}</span><strong>{linkedWorkspaces.length + remoteWorkspaceCount}</strong></div><div><span>{tr("agents.homeAssets")}</span><strong>{homeAssets.length}</strong></div><div><span>{tr("agents.provider")}</span><strong>{provider ? qualityLabel(provider.quality) : tr("insights.noData")}</strong></div></div>{installation?.home && <div className="agent-home-path"><code>{installation.home}</code></div>}{installation?.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={14} />{warning}</div>)}<div className="agent-overview-grid"><section className="detail-section"><h3>{tr("agents.recentWorkspaces")}</h3><div className="agent-workspace-list preview-list">{recentLinkedWorkspaces.map((workspace) => <button key={workspace.id} onClick={() => void onOpen(workspace)}><FolderGit2 size={14} /><span>{workspace.name}<small>{workspace.path}</small></span><small>{workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}</small></button>)}{!recentLinkedWorkspaces.length && <p className="neutral-empty">{tr("agents.noRecentWorkspaces")}</p>}</div></section><section className="detail-section"><h3>{tr("agents.homeAssetTypes")}</h3><dl className="summary-list compact-summary">{homeAssetKinds.map(([kind, count]) => <div key={kind}><dt>{tr(`status.asset.${kind}`)}</dt><dd>{count}</dd></div>)}{!homeAssetKinds.length && <div><dt>{tr("agents.noHomeAssets")}</dt><dd>0</dd></div>}</dl></section></div>{selectedRemoteGateways.length > 0 && <RemoteAgentGatewayDetails gateways={selectedRemoteGateways} />}</>}
      {section === "assets" && <div className="detail-section"><div className="toolbar compact-toolbar"><div className="search"><Search size={15} /><input value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder={tr("catalog.searchPlaceholder")} /></div>{assetKinds.length > 1 && <select className="setting-select" value={assetKind} onChange={(event) => setAssetKind(event.target.value)}><option value="all">{tr("catalog.allTypes")}</option>{assetKinds.map((value) => <option key={value} value={value}>{tr(`status.asset.${value}`)}</option>)}</select>}</div><div className="home-asset-list">{visibleHomeAssets.map((asset) => <div key={asset.id}><FileCode2 size={14} /><span><strong>{asset.name}</strong><small>{shortPath(asset.path)}</small></span><em>{tr(`status.asset.${asset.kind}`)}</em></div>)}{!visibleHomeAssets.length && <Empty compact icon={FileCode2} title={tr("agents.noHomeAssets")} text="" />}</div></div>}
      {section === "workspaces" && <div className="detail-section"><div className="agent-workspace-list">{linkedWorkspaces.map((workspace) => <div key={workspace.id}><FolderGit2 size={14} /><span>{workspace.name}<small>{workspace.path}</small></span><small>{workspace.asset_count}</small></div>)}</div>{selectedRemoteGateways.length > 0 && <RemoteAgentGatewayDetails gateways={selectedRemoteGateways} />}{!linkedWorkspaces.length && !selectedRemoteGateways.length && <Empty compact icon={FolderGit2} title={tr("workspace.noMatch")} text="" />}</div>}
      {section === "usage" && <div className="detail-section provider-usage"><div className="provider-summary"><span>{tr("agents.provider")}</span><strong>{provider ? qualityLabel(provider.quality) : tr("insights.noData")}</strong>{provider?.coverage_from && <small>{provider.coverage_from} — {provider.coverage_to}</small>}</div>{(provider?.error_key || provider?.error) && <details><summary>{provider.error_key ? tr(provider.error_key, { defaultValue: tr("insights.providerUnavailable") }) : tr("insights.providerUnavailable")}</summary>{provider.error && <pre>{provider.error}</pre>}</details>}</div>}
    </section>
  </div>;
}

function RemoteAgentGatewayDetails({ gateways }: { gateways: RemoteGatewaySummary[] }) {
  return <><div className="detail-section"><h3>{tr("gateway.title")}</h3><div className="home-asset-list">{gateways.map((gateway) => <div key={gateway.id}><PlugZap size={14} /><span><strong>{gateway.name}</strong><small>{gateway.url}</small></span><em className={`gateway-${gateway.state}`}>{tr(`gateway.state.${gateway.state}`)}</em></div>)}</div></div><div className="detail-section"><h3>{tr("gateway.remoteWorkspaces")}</h3><div className="agent-workspace-list">{gateways.flatMap((gateway) => gateway.workspaces.map((workspace) => <div key={`${gateway.id}:${workspace.id}`}><FolderGit2 size={14} /><span>{workspace.name}<small>{workspace.path ?? gateway.name}</small></span><small>{tr("common.sessions")} {workspace.session_count}</small></div>))}</div></div><div className="detail-section"><h3>{tr("gateway.remoteAssets")}</h3><div className="home-asset-list">{gateways.flatMap((gateway) => gateway.assets.map((asset) => <div key={`${gateway.id}:${asset.id}`}><FileCode2 size={14} /><span><strong>{asset.name}</strong><small>{asset.path}</small></span><em>{asset.kind}</em></div>))}{gateways.every((gateway) => !gateway.assets.length) && <p>{tr(gateways.every((gateway) => gateway.kind === "hermes") ? "gateway.hermesPartial" : "gateway.noRemoteAssets")}</p>}</div></div></>;
}

function GlobalAssetsPage({ section, onSection, assets, workspaces, memories, runtime, onReload, onRuntimeChanged, onOpen, onMigrationPlanned }: { section: AssetSection; onSection: (section: AssetSection) => void; assets: CatalogAsset[]; workspaces: WorkspaceSummary[]; memories: MemoryRecord[]; runtime?: RuntimeInfo; onReload: () => Promise<void>; onRuntimeChanged: (runtime: RuntimeInfo) => void; onOpen: (id: string) => void; onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const pending = memories.filter((item) => item.status === "pending").length;
  const workspaceAssets = useMemo(() => groupCatalogAssets(assets.filter((asset) => asset.scope === "workspace")), [assets]);
  const instructionAssets = workspaceAssets.filter((asset) => asset.kind === "instruction");
  const skillAssets = workspaceAssets.filter((asset) => asset.kind === "skill");
  const connectionAssets = workspaceAssets.filter((asset) => asset.kind === "connection");
  const otherAssets = workspaceAssets.filter((asset) => !["instruction", "skill", "connection", "memory"].includes(asset.kind));
  const pendingMemoryLabel = pending ? tr("memory.pendingCount", { count: pending }) : undefined;
  return <div className="stack"><div className="section-tabs asset-category-tabs" role="tablist" aria-label={tr("nav.assets")} onKeyDown={handleTabKey}><button role="tab" aria-selected={section === "instructions"} className={section === "instructions" ? "active" : ""} onClick={() => onSection("instructions")}><FileCode2 size={15} />{tr("assets.instructions")}<em>{instructionAssets.length}</em></button><button role="tab" aria-selected={section === "skills"} className={section === "skills" ? "active" : ""} onClick={() => onSection("skills")}><Sparkles size={15} />{tr("assets.skills")}<em>{skillAssets.length}</em></button><button role="tab" aria-selected={section === "mcp"} className={section === "mcp" ? "active" : ""} onClick={() => onSection("mcp")}><PlugZap size={15} />MCP<em>{connectionAssets.length}</em></button><button role="tab" aria-selected={section === "memory"} className={section === "memory" ? "active" : ""} onClick={() => onSection("memory")}><Brain size={15} />{tr("assets.memories")}<em className={pending ? "attention-count" : ""} aria-label={pendingMemoryLabel} title={pendingMemoryLabel}>{memories.length}</em></button><button role="tab" aria-selected={section === "other"} className={section === "other" ? "active" : ""} onClick={() => onSection("other")}><Boxes size={15} />{tr("assets.hooksProfiles")}<em>{otherAssets.length}</em></button></div>{section === "instructions" && <CatalogPage assets={instructionAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "skills" && <CatalogPage assets={skillAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "other" && <CatalogPage assets={otherAssets} workspaces={workspaces} onOpen={onOpen} />}{section === "memory" && <GlobalMemoryInbox records={memories} workspaces={workspaces} onReload={onReload} />}{section === "mcp" && <McpHubPage runtime={runtime} workspaces={workspaces} onRuntimeChanged={onRuntimeChanged} onMigrationPlanned={onMigrationPlanned} />}</div>;
}

function CatalogPage({ assets, workspaces, onOpen }: { assets: CatalogAssetGroup[]; workspaces: WorkspaceSummary[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [agent, setAgent] = useState<"all" | AgentKind>("all"); const [kind, setKind] = useState("all"); const [workspaceId, setWorkspaceId] = useState("all"); const [ownership, setOwnership] = useState<"all" | "shared" | "native">("all");
  const [selectedId, setSelectedId] = useState<string>();
  const kinds = [...new Set(assets.map((asset) => asset.kind))].sort();
  const showKind = kinds.length > 1;
  const filtered = assets.filter((asset) => `${asset.name} ${asset.path} ${asset.summary} ${localizedAssetSummary(asset)} ${asset.kind} ${asset.agents.map((value) => agentLabels[value]).join(" ")}`.toLowerCase().includes(query.toLowerCase()) && (agent === "all" || asset.agents.includes(agent)) && (kind === "all" || asset.kind === kind) && (workspaceId === "all" || asset.workspace_id === workspaceId) && (ownership === "all" || (ownership === "shared" ? !asset.agents.length : asset.agents.length > 0)));
  const selected = assets.find((asset) => asset.id === selectedId);
  return <div className={`catalog-layout${selected ? " has-inspector" : ""}`}><div className="panel"><div className="toolbar catalog-toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("catalog.searchPlaceholder")} /></div><div className="toolbar-filters"><select className="setting-select" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="all">{tr("workspace.all")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><select className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{showKind && <select className="setting-select" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">{tr("catalog.allTypes")}</option>{kinds.map((value) => <option key={value} value={value}>{tr(`status.asset.${value}`)}</option>)}</select>}<select className="setting-select" value={ownership} onChange={(event) => setOwnership(event.target.value as typeof ownership)}><option value="all">{tr("catalog.allOwnership")}</option><option value="shared">{tr("catalog.shared")}</option><option value="native">{tr("catalog.native")}</option></select></div><span>{filtered.length} {tr("common.assets")}</span></div><div className={`catalog-table${showKind ? " with-kind" : ""}`}><div className="catalog-row table-head"><span>{tr("catalog.asset")}</span>{showKind && <span>{tr("catalog.type")}</span>}<span>{tr("catalog.workspace")}</span><span>{tr("catalog.visibleAgents")}</span></div>{filtered.map((asset) => { const visibleAgents = asset.agents.slice(0, 2); const hiddenAgentCount = asset.agents.length - visibleAgents.length; const allAgents = asset.agents.map((value) => agentLabels[value]).join(", "); return <button className={`catalog-row${selectedId === asset.id ? " selected" : ""}`} key={asset.id} onClick={() => setSelectedId(asset.id)}><span className="asset-name"><FileCode2 size={15} /><span><strong>{asset.name}</strong><small>{shortPath(asset.path)}</small></span></span>{showKind && <span className="tag">{tr(`status.asset.${asset.kind}`)}</span>}<span>{asset.workspace_id ? workspaces.find((item) => item.id === asset.workspace_id)?.name : "—"}</span><span className="agent-tags" aria-label={allAgents || tr("catalog.shared")} title={allAgents}>{asset.agents.length ? <>{visibleAgents.map((value) => <span className="tag" key={value}>{agentLabels[value]}</span>)}{hiddenAgentCount > 0 && <span className="tag agent-overflow">+{hiddenAgentCount}</span>}</> : <span>{tr("catalog.shared")}</span>}</span></button>; })}{!filtered.length && <Empty compact icon={Library} title={tr("catalog.noMatch")} text={tr("catalog.noMatchText")} />}</div></div>{selected && <aside className="panel asset-inspector"><div className="inspector-head"><FileCode2 size={18} /><h2>{selected.name}</h2><button className="icon-button" onClick={() => setSelectedId(undefined)} aria-label={tr("common.close")}><X size={16} /></button></div><dl><div><dt>{tr("catalog.type")}</dt><dd>{tr(`status.asset.${selected.kind}`)}</dd></div><div><dt>{tr("catalog.workspace")}</dt><dd>{selected.workspace_id ? workspaces.find((item) => item.id === selected.workspace_id)?.name : "—"}</dd></div><div><dt>{tr("catalog.visibleAgents")}</dt><dd>{selected.agents.length ? selected.agents.map((value) => agentLabels[value]).join(" · ") : tr("catalog.shared")}</dd></div><div><dt>{tr("catalog.path")}</dt><dd><code>{selected.path}</code></dd></div></dl>{selected.workspace_id && <button className="primary inspector-action" onClick={() => onOpen(selected.workspace_id!)}>{tr("catalog.openWorkspace")}<ChevronRight size={14} /></button>}</aside>}</div>;
}

type HeatmapMetric = "tokens" | "my_commits" | "all_commits" | "attributed_commits" | "sessions";
type InsightsSection = "overview" | "tokens" | "commits" | "milestones" | "sources";

function InsightsPage({ section, workspaces, onSummary }: { section: InsightsSection; workspaces: WorkspaceSummary[]; onSummary: (summary: InsightsSummary) => void }) {
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [repository, setRepository] = useState("all");
  const [range, setRange] = useState<"52w" | "year">("52w");
  const [metric, setMetric] = useState<HeatmapMetric>("tokens");
  const [summary, setSummary] = useState<InsightsSummary>();
  const [points, setPoints] = useState<HeatmapPoint[]>([]);
  const [agents, setAgents] = useState<AgentUsageBreakdown[]>([]);
  const [models, setModels] = useState<ModelUsageBreakdown[]>([]);
  const [workspaceUsage, setWorkspaceUsage] = useState<WorkspaceUsageBreakdown[]>([]);
  const [repositories, setRepositories] = useState<RepositoryCommitBreakdown[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [status, setStatus] = useState<InsightsStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingRefresh = useRef(false);
  const query = useMemo<InsightsQuery>(() => {
    const today = new Date();
    const from = range === "year" ? new Date(today.getFullYear(), 0, 1) : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 363);
    const tokenView = section === "overview" || section === "tokens";
    const commitView = section === "overview" || section === "commits";
    return {
      from: localDate(from), to: localDate(today),
      agent: tokenView && agent !== "all" ? agent : undefined,
      workspace_id: tokenView && workspaceId !== "all" ? workspaceId : undefined,
      repository_group_id: commitView && repository !== "all" ? repository : undefined,
    };
  }, [agent, workspaceId, repository, range, section]);
  const loadInsights = async () => {
    setError("");
    try {
      const view = await api.insightsView(query);
      setSummary(view.summary); setPoints(view.heatmap); setAgents(view.agents); setModels(view.models); setWorkspaceUsage(view.workspaces); setRepositories(view.repositories); setAchievements(view.achievements); setStatus(view.status); setBusy(view.status.running); onSummary(view.summary);
    } catch (reason) { setError(localizeMessage(reason)); }
  };
  useEffect(() => { void loadInsights(); }, [query]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<RefreshJobStatus>("agentkib:refresh-state", (event) => {
      if (event.payload.kind !== "insights") return;
      if (event.payload.state === "queued" || event.payload.state === "running") setBusy(true);
      if (event.payload.state === "succeeded") {
        setBusy(false);
        if (document.visibilityState === "visible") void loadInsights();
        else pendingRefresh.current = true;
      }
      if (event.payload.state === "failed") { setBusy(false); setError(event.payload.error ?? tr("errors.generic")); }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [query]);
  useEffect(() => {
    const refreshVisibleInsights = () => {
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void loadInsights();
      }
    };
    window.addEventListener("focus", refreshVisibleInsights);
    return () => window.removeEventListener("focus", refreshVisibleInsights);
  }, [query]);
  const refresh = async () => { setError(""); try { setBusy(true); await api.requestRefresh("insights", true); } catch (reason) { setBusy(false); setError(localizeMessage(reason)); } };
  const metricLabels: Record<HeatmapMetric, string> = { tokens: "Token", my_commits: tr("insights.myCommits"), all_commits: tr("insights.allCommits"), attributed_commits: tr("insights.attributedCommits"), sessions: tr("common.sessions") };
  const max = Math.max(1, ...points.map((point) => point[metric]));
  const padding = points.length ? new Date(`${points[0].date}T00:00:00`).getDay() : 0;
  const repositoryOptions = [...new Map(workspaces.filter((value) => value.repository_group_id).map((value) => [value.repository_group_id!, value.name])).entries()];
  const showTokenFilters = section === "overview" || section === "tokens";
  const showCommitFilters = section === "overview" || section === "commits";
  const showRange = !["milestones", "sources"].includes(section);
  return <div className="stack insights-page">
    {error && <div className="alert"><CircleAlert size={16} />{error}</div>}
    <div className="insights-filters">
      {showTokenFilters && <select value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}
      {showTokenFilters && <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="all">{tr("workspace.all")}</option>{workspaces.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}
      {showCommitFilters && <select value={repository} onChange={(event) => setRepository(event.target.value)}><option value="all">{tr("insights.allRepositories")}</option>{repositoryOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>}
      {showRange && <select value={range} onChange={(event) => setRange(event.target.value as typeof range)}><option value="52w">{tr("insights.range52w")}</option><option value="year">{tr("insights.rangeYear")}</option></select>}
      {busy && <span className="badge">{tr("tray.refreshing")}</span>}
      <button className="ghost icon-only" aria-label={tr("insights.refresh")} title={tr("insights.refresh")} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
    </div>
    {!summary && <div className="panel"><Empty compact icon={Award} title={tr("insights.preparing")} text={tr("insights.preparingText")} /></div>}
    {summary && section === "overview" && <>
      <div className="achievement-metrics">
        <AchievementMetric icon={Sparkles} label={tr("insights.totalToken")} value={`${summary.quality === "incomplete" ? "≥ " : ""}${formatCompact(summary.total_tokens)}`} detail={`${qualityLabel(summary.quality)}${summary.coverage_from ? ` · ${summary.coverage_from} — ${summary.coverage_to}` : ""}`} />
        <AchievementMetric icon={GitCommitHorizontal} label={tr("insights.myCommits")} value={formatCompact(summary.my_commits)} detail={tr("insights.allActivity", { count: formatCompact(summary.all_commits) })} />
        <AchievementMetric icon={CalendarDays} label={tr("insights.activeDays")} value={`${summary.active_days} ${tr("common.days")}`} detail={tr("insights.recordedSessions", { count: formatCompact(summary.session_count) })} />
        <AchievementMetric icon={Flame} label={tr("insights.currentStreak")} value={`${summary.current_streak} ${tr("common.days")}`} detail={tr("insights.longestStreak", { count: summary.longest_streak })} />
      </div>
      <div className="panel heatmap-panel"><div className="panel-head"><h2>{tr("insights.heatmap")}</h2><QualityBadge quality={summary.quality} /></div><div className="heatmap-tabs">{(Object.keys(metricLabels) as HeatmapMetric[]).map((value) => <button key={value} className={metric === value ? "active" : ""} onClick={() => setMetric(value)}>{metricLabels[value]}</button>)}</div><div className="heatmap-scroll"><HeatmapMonths points={points} padding={padding} /><div className="heatmap-grid">{Array.from({ length: padding }, (_, index) => <span className="heatmap-cell empty-cell" key={`padding-${index}`} />)}{points.map((point) => { const value = point[metric]; const level = value ? Math.max(1, Math.ceil(value / max * 4)) : 0; return <span key={point.date} className={`heatmap-cell level-${level}`} title={`${point.date} · ${metricLabels[metric]} ${formatCompact(value)} · ${qualityLabel(point.quality)}`} />; })}</div></div><div className="heatmap-legend"><span>{tr("insights.less")}</span>{[0,1,2,3,4].map((level) => <i key={level} className={`heatmap-cell level-${level}`} />)}<span>{tr("insights.more")}</span></div></div>
    </>}
    {summary && section === "tokens" && <><div className="panel"><div className="panel-head"><h2>{tr("insights.agentUsage")}</h2></div><div className="agent-usage-list">{agents.map((value) => <div key={value.agent}><AgentIcon agent={value.agent} /><span><strong>{agentLabels[value.agent]}</strong><small>{value.session_count} {tr("common.sessions")} · {qualityLabel(value.quality)}</small></span><div><strong>{formatCompact(value.total_tokens)}</strong><small>Token</small></div></div>)}{!agents.length && <p>{tr("insights.noToken")}</p>}</div></div><div className="two-col insight-columns"><BreakdownPanel title={tr("insights.modelUsage")} subtitle="" values={models.map((value) => ({ key: value.model, label: value.model, detail: `${value.session_count} ${tr("common.sessions")}`, value: value.total_tokens }))} /><BreakdownPanel title={tr("insights.workspaceUsage")} subtitle="" values={workspaceUsage.map((value) => ({ key: value.workspace_id ?? "unlinked", label: value.name, detail: `${value.session_count} ${tr("common.sessions")}`, value: value.total_tokens }))} /></div></>}
    {summary && section === "commits" && <div className="panel"><div className="panel-head"><h2>{tr("insights.repositoryCommits")}</h2></div><div className="repository-usage-list">{repositories.slice(0, 20).map((value) => <div key={value.repository_group_id}><span><strong>{value.name}</strong><small>{tr("insights.repositoryDetail", { all: value.all_commits, attributed: value.attributed_commits })}</small></span><strong>{value.my_commits}</strong></div>)}{!repositories.length && <p>{tr("insights.noCommits")}</p>}</div></div>}
    {section === "milestones" && <MilestonePaths achievements={achievements} />}
    {section === "sources" && <div className="panel provider-panel"><div className="panel-head"><h2>{tr("insights.providers")}</h2><span className="badge">{status?.refreshed_at ? tr("home.updated", { time: relativeTime(status.refreshed_at) }) : tr("insights.notRefreshed")}</span></div><div className="provider-grid">{status?.providers.map((provider) => <ProviderRow key={provider.agent} provider={provider} />)}</div></div>}
  </div>;
}

function HeatmapMonths({ points, padding }: { points: HeatmapPoint[]; padding: number }) {
  const columns = Math.max(1, Math.ceil((padding + points.length) / 7));
  const markers = buildHeatmapMonthMarkers(points, padding, document.documentElement.lang || "en-US");
  return <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${columns}, 11px)` }}>{markers.map((marker) => <span key={marker.key} style={{ gridColumn: marker.column, gridRow: 1 }}>{marker.label}</span>)}</div>;
}

const milestoneIcons: Record<AchievementCategory, typeof Activity> = {
  token: Sparkles,
  session: MessageSquareText,
  commit: GitCommitHorizontal,
  "active-days": CalendarCheck2,
  streak: Flame,
  workspaces: FolderGit2,
  agents: Network,
};

const specialAchievementIcons: Record<string, typeof Activity> = {
  "special-first-changeset": ShieldCheck,
  "special-first-memory": Brain,
  "special-shared-workspace": Network,
  "special-exact-attribution": GitCommitHorizontal,
  "special-remote-handshake": PlugZap,
  "special-night-owl": Moon,
  "special-comeback": RotateCcw,
  "special-same-day-delivery": Workflow,
};

function MilestonePaths({ achievements }: { achievements: Achievement[] }) {
  if (!achievements.length) return <div className="panel"><Empty compact icon={Award} title={tr("insights.preparing")} text="" /></div>;
  const tracks = buildAchievementTracks(achievements).filter((track) => track.milestones.length);
  const specials = buildSpecialAchievements(achievements);
  const completed = tracks.reduce((count, track) => count + track.completed, 0);
  const milestoneCount = tracks.reduce((count, track) => count + track.milestones.length, 0);
  return <div className="milestone-layout">
    <div className="panel milestone-panel">
      <div className="panel-head"><h2>{tr("insights.milestones")}</h2><span className="badge">{completed} / {milestoneCount}</span></div>
      <div className="milestone-paths">{tracks.map((track) => <MilestonePath key={track.category} track={track} />)}</div>
    </div>
    {!!specials.length && <SpecialAchievements achievements={specials} />}
  </div>;
}

function MilestonePath({ track }: { track: AchievementTrack }) {
  const Icon = milestoneIcons[track.category];
  const progressPercent = Math.round(track.progressRatio * 100);
  return <article className={`milestone-path ${track.next ? "in-progress" : "complete"}`}>
    <header>
      <span className="milestone-path-icon"><Icon size={19} /></span>
      <div className="milestone-path-title"><h3>{tr(`milestones.category.${track.category}`)}</h3><strong>{formatMilestoneValue(track.category, track.progress)}</strong></div>
      <div className="milestone-path-next"><span>{tr("milestones.completed", { completed: track.completed, total: track.milestones.length })}</span><strong>{track.next ? tr("milestones.next", { target: formatMilestoneValue(track.category, track.next.threshold) }) : tr("milestones.highest")}</strong></div>
    </header>
    <div className="milestone-rail-scroll">
      <div className="milestone-rail" style={{ gridTemplateColumns: `repeat(${Math.max(1, track.milestones.length)}, minmax(92px, 1fr))` }}>
        <div className="milestone-progress" role="progressbar" aria-label={tr("milestones.progress", { category: tr(`milestones.category.${track.category}`) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><i style={{ width: `${progressPercent}%` }} /></div>
        {track.milestones.map((milestone) => {
          const reached = achievementReached(milestone);
          const current = track.next?.code === milestone.code;
          return <div className={`milestone-node${reached ? " reached" : ""}${current ? " current" : ""}`} key={milestone.code}>
            <span>{reached ? <Check size={13} /> : ""}</span>
            <strong>{formatMilestoneValue(track.category, milestone.threshold)}</strong>
            <small>{tr(`achievements.${achievementTranslationKey(milestone.code)}.title`)}</small>
          </div>;
        })}
      </div>
    </div>
    <details className="milestone-history">
      <summary>{tr("milestones.history")}<ChevronRight size={14} /></summary>
      <div>{track.milestones.map((milestone) => {
        const current = track.next?.code === milestone.code;
        return <div key={milestone.code}><span className={achievementReached(milestone) ? "reached" : current ? "current" : "locked"}>{achievementReached(milestone) ? <Check size={13} /> : null}</span><strong>{tr(`achievements.${achievementTranslationKey(milestone.code)}.title`)}</strong><small>{formatMilestoneValue(track.category, milestone.threshold)}</small><time>{milestone.unlocked_at ? tr("insights.unlockedAt", { date: formatDateTime(milestone.unlocked_at) }) : current ? tr("milestones.currentProgress", { progress: formatMilestoneValue(track.category, track.progress) }) : tr("milestones.locked")}</time></div>;
      })}</div>
    </details>
  </article>;
}

function formatMilestoneValue(category: AchievementCategory, value: number) {
  return tr(`milestones.value.${category}`, { value: formatCompact(value) });
}

function SpecialAchievements({ achievements }: { achievements: SpecialAchievement[] }) {
  const product = achievements.filter((value) => !value.secret);
  const secrets = achievements.filter((value) => value.secret);
  const unlocked = achievements.filter((value) => value.unlocked).length;
  return <section className="panel special-achievements">
    <div className="panel-head"><h2>{tr("special.title")}</h2><span className="badge">{unlocked} / {achievements.length}</span></div>
    <div className="special-achievement-columns">
      <SpecialAchievementGroup title={tr("special.product")} achievements={product} />
      <SpecialAchievementGroup title={tr("special.secrets")} achievements={secrets} />
    </div>
  </section>;
}

function SpecialAchievementGroup({ title, achievements }: { title: string; achievements: SpecialAchievement[] }) {
  return <section className="special-achievement-group"><h3>{title}</h3><div>{achievements.map((value) => <SpecialAchievementItem key={value.achievement.code} value={value} />)}</div></section>;
}

function SpecialAchievementItem({ value }: { value: SpecialAchievement }) {
  const { achievement, secret, unlocked } = value;
  const hidden = secret && !unlocked;
  const key = achievementTranslationKey(achievement.code);
  const Icon = hidden ? LockKeyhole : specialAchievementIcons[achievement.code] ?? Award;
  const title = hidden ? tr("special.mystery") : tr(`achievements.${key}.title`);
  const status = achievement.unlocked_at
    ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })
    : unlocked ? tr("special.reachedDateUnknown") : tr("milestones.locked");
  if (hidden) {
    return <div className="special-achievement-item hidden" aria-label={`${title} · ${status}`}><span><Icon size={16} /></span><strong>{title}</strong><small>{status}</small></div>;
  }
  return <details className={`special-achievement-item${unlocked ? " unlocked" : ""}`}>
    <summary><span><Icon size={16} /></span><strong>{title}</strong><small>{status}</small><ChevronRight size={14} /></summary>
    <div><p>{tr(`achievements.${key}.description`)}</p>{achievement.unlocked_at && <time>{tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })}</time>}</div>
  </details>;
}

function ProviderRow({ provider }: { provider: NonNullable<InsightsStatus["providers"]>[number] }) {
  const summary = provider.coverage_from ? `${provider.coverage_from} — ${provider.coverage_to}` : provider.error_key ? localizeMessage({ key: provider.error_key, params: provider.error_params }) : provider.error ? tr("insights.providerUnavailable") : tr("insights.noData");
  return <div className="provider-row"><AgentIcon agent={provider.agent} /><span><strong>{agentLabels[provider.agent]}</strong><small>{summary}</small>{provider.error && <details><summary>{tr("common.details")}</summary><pre>{provider.error}</pre></details>}</span><QualityBadge quality={provider.available ? provider.quality : "incomplete"} /></div>;
}

function AchievementMetric({ icon: Icon, label, value, detail }: { icon: typeof Activity; label: string; value: string; detail: string }) { return <div className="panel achievement-metric"><Icon size={18} /><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function QualityBadge({ quality }: { quality: UsageQuality }) { return <span className={`quality-badge ${quality}`}>{qualityLabel(quality)}</span>; }
function BreakdownPanel({ title, subtitle, values }: { title: string; subtitle: string; values: Array<{ key: string; label: string; detail: string; value: number }> }) { return <div className="panel"><div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div></div><div className="repository-usage-list">{values.slice(0, 10).map((item) => <div key={item.key}><span><strong>{metadataLabel(item.label)}</strong><small>{item.detail}</small></span><strong>{formatCompact(item.value)}</strong></div>)}{!values.length && <p>{tr("insights.noRecords")}</p>}</div></div>; }

function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓库 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}

function GlobalMemoryInbox({ records, workspaces, onReload }: { records: MemoryRecord[]; workspaces: WorkspaceSummary[]; onReload: () => Promise<void> }) {
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { await api.reviewMemory(id, status, editedContent); await onReload(); };
  return <div className="panel inbox"><div className="panel-head"><div><h2>{tr("memory.globalTitle")}</h2><p>{tr("memory.globalPending", { count: records.filter((item) => item.status === "pending").length })}</p></div></div><div className="memory-list">{records.map((record) => <div key={record.id} className="global-memory-item"><span className="workspace-memory-label">{workspaces.find((item) => item.manifest_workspace_id === record.project_id)?.name ?? record.project_id.slice(0, 8)}</span><MemoryCard record={record} onReview={review} /></div>)}{!records.length && <Empty icon={Brain} title={tr("memory.empty")} text={tr("memory.globalEmptyText")} />}</div></div>;
}

function ActivityPage({ records }: { records: ActivityRecord[] }) { return <div className="panel"><div className="panel-head"><div><h2>{tr("activity.title")}</h2><p>{tr("activity.description")}</p></div></div><div className="activity-list">{records.map((record) => <ActivityRow key={record.id} record={record} />)}{!records.length && <Empty icon={History} title={tr("home.noActivity")} text={tr("activity.emptyText")} />}</div></div>; }
function ActivityRow({ record }: { record: ActivityRecord }) { const key = `activity.action.${record.action}`; return <div className="activity-row"><span className="activity-dot" /><div><strong>{tr(key, { defaultValue: record.action })}</strong><small>{record.detail}</small></div><time>{formatDateTime(record.created_at)}</time></div>; }

function McpHubPage({ runtime, workspaces, onRuntimeChanged, onMigrationPlanned }: { runtime?: RuntimeInfo; workspaces: WorkspaceSummary[]; onRuntimeChanged: (runtime: RuntimeInfo) => void; onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]); const [installations, setInstallations] = useState<McpInstallation[]>([]); const [runtimes, setRuntimes] = useState<McpRuntimeStatus[]>([]);
  const [registry, setRegistry] = useState<McpRegistryEntry[]>([]); const [query, setQuery] = useState(""); const [scope, setScope] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const project = scope || undefined;
  const load = async () => { const [nextServers, nextInstallations, nextRuntimes, nextRuntime] = await Promise.all([api.mcpServers(project), api.mcpInstallations(), api.mcpRuntimes(), api.runtime()]); setServers(nextServers); setInstallations(nextInstallations); setRuntimes(nextRuntimes); onRuntimeChanged(nextRuntime); };
  useEffect(() => { void load().catch((reason) => setError(localizeMessage(reason))); }, [scope]);
  const searchRegistry = async () => { setBusy(true); setError(""); try { setRegistry(await api.searchMcpRegistry(query)); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const install = async (entry: McpRegistryEntry) => { const command = entry.package_kind === "remote" ? entry.url : `${entry.package_kind === "npm" ? "npm" : "uv"} · ${entry.identifier}@${entry.version}`; if (!window.confirm(tr("mcp.installConfirm", { name: entry.name, command }))) return; const env: Record<string, string> = {}; for (const key of entry.required_env) { const value = window.prompt(tr("mcp.enterSecret", { key })); if (value === null) return; env[key] = value; } setBusy(true); setError(""); try { const result = await api.installMcp(entry, project); if (Object.keys(env).length) await api.saveMcpLocalValues(result.server.id, env, {}, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const updateInstallation = async (installation: McpInstallation, entry: McpRegistryEntry) => { if (!window.confirm(tr("mcp.updateConfirm", { name: installation.name, version: entry.version }))) return; const env: Record<string, string> = {}; for (const key of entry.required_env) { const value = window.prompt(tr("mcp.enterSecret", { key })); if (value === null) return; env[key] = value; } setBusy(true); setError(""); try { const result = await api.updateMcp(installation.id, entry, project); if (Object.keys(env).length) await api.saveMcpLocalValues(result.server.id, env, {}, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const updateNetwork = async (lanEnabled: boolean) => { if (lanEnabled && !window.confirm(tr("mcp.lanWarning"))) return; try { await api.updateMcpNetwork({ port: runtime?.mcp_network?.port ?? 47653, lan_enabled: lanEnabled, lan_risk_accepted: lanEnabled }); onRuntimeChanged(await api.runtime()); } catch (reason) { setError(localizeMessage(reason)); } };
  const updatePort = async (port: number) => { if (!Number.isInteger(port) || port < 1 || port > 65535 || port === runtime?.mcp_network?.port) return; try { await api.updateMcpNetwork({ port, lan_enabled: runtime?.mcp_network?.lan_enabled ?? false, lan_risk_accepted: runtime?.mcp_network?.lan_risk_accepted ?? false }); onRuntimeChanged(await api.runtime()); } catch (reason) { setError(localizeMessage(reason)); } };
  const authorize = async (serverId: string) => { try { const result = await api.startMcpOAuth(serverId, project); await openUrl(result.authorization_url); } catch (reason) { setError(localizeMessage(reason)); } };
  return <div className="stack mcp-hub-page">{error && <div className="alert"><CircleAlert size={16} />{error}</div>}<div className="mcp-hero"><div><span className="eyebrow">STREAMABLE HTTP MCP HUB</span><h2>{tr("mcp.title")}</h2><p>{tr("mcp.description")}</p></div><div className="mcp-hub-address"><span className={runtime?.mcp_hub?.running ? "ready" : "status rejected"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code><small>{tr("mcp.runtimeCount", { count: runtime?.mcp_hub?.runtime_count ?? 0 })}</small></div></div><div className="panel mcp-network"><div><h2>{tr("mcp.network")}</h2><p>{tr("mcp.networkDescription")}</p></div><div className="mcp-network-controls"><label><span>{tr("mcp.port")}</span><input className="mcp-port" type="number" min="1" max="65535" defaultValue={runtime?.mcp_network?.port ?? 47653} onBlur={(event) => void updatePort(Number(event.target.value))} /></label><label><span>{tr("mcp.lanMode")}</span><input type="checkbox" checked={runtime?.mcp_network?.lan_enabled ?? false} onChange={(event) => void updateNetwork(event.target.checked)} /></label></div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.scope")}</h2><p>{tr("mcp.scopeDescription")}</p></div><select className="setting-select" value={scope} onChange={(event) => setScope(event.target.value)}><option value="">{tr("mcp.globalScope")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.path}>{workspace.name}</option>)}</select></div></div><McpServerEditor project={project} onSaved={load} /><McpMigrationInventory project={project} onPlanned={onMigrationPlanned} /><div className="two-col mcp-columns"><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.registry")}</h2><p>{tr("mcp.registryDescription")}</p></div></div><div className="mcp-search"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRegistry(); }} placeholder={tr("mcp.searchPlaceholder")} /><button className="primary" disabled={busy} onClick={() => void searchRegistry()}><Search size={14} />{tr("common.search")}</button></div><div className="mcp-list">{registry.map((entry) => <article key={`${entry.name}-${entry.version}`}><div><strong>{entry.name}</strong><small>{entry.description}</small><span>{entry.package_kind} · {entry.version}{entry.required_env.length ? ` · ${tr("mcp.requiredEnv", { count: entry.required_env.length })}` : ""}</span></div><button className="ghost" onClick={() => void install(entry)}>{tr("mcp.install")}</button></article>)}{!registry.length && <p>{tr("mcp.registryEmpty")}</p>}</div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.configured")}</h2><p>{tr("mcp.configuredDescription")}</p></div><span className="badge">{servers.length}</span></div><div className="mcp-list">{servers.map((server) => <article key={server.id}><div><strong>{server.name}</strong><small>{server.transport === "stdio" ? server.command : server.url}</small><span>{server.targets.length ? server.targets.map((agent) => agentLabels[agent]).join(" · ") : tr("mcp.allAgents")}</span></div><div className="mcp-actions">{server.transport === "streamable-http" && <button className="ghost" onClick={() => void authorize(server.id)}>{tr("mcp.authorize")}</button>}<button className="ghost" onClick={async () => { try { await api.probeMcpRuntime(server.id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.probe")}</button><button className="icon-danger" onClick={async () => { await api.removeMcpServer(server.id, project); await load(); }}><Trash2 size={14} /></button></div></article>)}{!servers.length && <p>{tr("mcp.configuredEmpty")}</p>}</div></div></div><div className="two-col mcp-columns"><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.installations")}</h2><p>{runtime?.mcp_package_root}</p></div><span className="badge">{installations.length}</span></div><div className="mcp-list">{installations.map((item) => { const update = registry.find((entry) => entry.package_kind === item.package_kind && entry.identifier === item.identifier && entry.version !== item.version); return <article key={item.id}><div><strong>{item.name}</strong><small>{item.identifier}</small><span>{item.package_kind} · {item.version ?? "—"}</span></div><div className="mcp-actions">{update && <button className="ghost" disabled={busy} onClick={() => void updateInstallation(item, update)}>{tr("mcp.update")}</button>}<button className="icon-danger" onClick={async () => { if (!window.confirm(tr("mcp.uninstallConfirm", { name: item.name }))) return; await api.uninstallMcp(item.id); await load(); }}><Trash2 size={14} /></button></div></article>; })}{!installations.length && <p>{tr("mcp.installationsEmpty")}</p>}</div></div><div className="panel"><div className="panel-head"><div><h2>{tr("mcp.runtimes")}</h2><p>{tr("mcp.lazyRuntime")}</p></div><button className="ghost" onClick={() => void load()}><RefreshCw size={13} />{tr("common.refresh")}</button></div><div className="mcp-list">{runtimes.map((item) => <article key={item.config_hash}><div><strong>{item.server_name}</strong><small>{item.config_hash.slice(0, 16)}…</small><span className={`status ${item.state}`}>{tr(`mcp.runtime.${item.state}`)}</span></div><div className="mcp-actions"><button className="ghost" onClick={async () => { try { await api.restartMcpRuntime(item.server_id, project); await load(); } catch (reason) { setError(localizeMessage(reason)); } }}>{tr("mcp.restart")}</button><button className="ghost" onClick={async () => { await api.stopMcpRuntime(item.server_id); await load(); }}>{tr("mcp.stop")}</button></div></article>)}{!runtimes.length && <p>{tr("mcp.runtimesEmpty")}</p>}</div></div></div></div>;
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
  return <div className="panel mcp-editor"><div className="panel-head"><div><h2>{tr("mcp.editor")}</h2><p>{tr("mcp.editorDescription")}</p></div><button className="primary" disabled={saving} onClick={() => void save()}>{tr("common.save")}</button></div>{error && <div className="alert"><CircleAlert size={16} />{error}</div>}<div className="mcp-editor-grid"><label><span>{tr("mcp.publicJson")}</span><textarea value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} /></label><div><label><span>{tr("mcp.environmentSecrets")}</span><textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder="API_TOKEN=…" spellCheck={false} /></label><label><span>{tr("mcp.headerSecrets")}</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder="Authorization=Bearer …" spellCheck={false} /></label><small>{tr("mcp.secretDescription")}</small></div></div></div>;
}

function McpMigrationInventory({ project, onPlanned }: { project?: string; onPlanned: (project: string, changeSet: ChangeSet) => Promise<void> }) {
  const [candidates, setCandidates] = useState<import("./types").McpMigrationCandidate[]>([]);
  const [scanned, setScanned] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scan = async () => { setCandidates(await api.nativeMcpCandidates(project)); setScanned(true); };
  const plan = async () => { if (!project || !selected.length) return; if (!window.confirm(tr("mcp.migrationConfirm", { count: selected.length }))) return; setBusy(true); setError(""); try { await onPlanned(project, await api.planMcpMigration(project, selected)); } catch (reason) { setError(localizeMessage(reason)); } finally { setBusy(false); } };
  const toggle = (id: string, checked: boolean) => setSelected((current) => checked ? [...current, id] : current.filter((value) => value !== id));
  return <div className="panel"><div className="panel-head"><div><h2>{tr("mcp.migration")}</h2><p>{tr("mcp.migrationDescription")}</p></div><div className="mcp-actions"><button className="ghost" onClick={() => void scan()}><Search size={13} />{tr("common.scan")}</button><button className="primary" disabled={!project || !selected.length || busy} onClick={() => void plan()}>{tr("mcp.planMigration")}</button></div></div>{!project && <div className="warning"><CircleAlert size={14} />{tr("mcp.projectRequired")}</div>}{error && <div className="alert"><CircleAlert size={16} />{error}</div>}{scanned && <div className="mcp-list migration-list">{candidates.map((candidate) => <article key={candidate.id}><label><input type="checkbox" disabled={!candidate.supported || !project} checked={selected.includes(candidate.id)} onChange={(event) => toggle(candidate.id, event.target.checked)} /><span><strong>{candidate.name}</strong><small>{agentLabels[candidate.agent]} · {candidate.source_path}</small><em>{candidate.transport} · {candidate.endpoint}{candidate.has_secret_values ? ` · ${tr("mcp.secretReentry")}` : ""}</em></span></label><span className={`status ${candidate.supported ? "approved" : "rejected"}`}>{tr(candidate.supported ? "mcp.importable" : "mcp.unsupported")}</span></article>)}{!candidates.length && <p>{tr("mcp.migrationEmpty")}</p>}</div>}</div>;
}

function GlobalSettings({ section, runtime, discovery, insightsStatus, quotaStatus, remoteGateways, scanRoots, excluded, activity, onAddRoot, onRemoveRoot, onRestore, onCloseBehaviorChanged, onLocaleChanged, onRemoteGatewaysChanged }: { section: SettingsSection; runtime?: RuntimeInfo; discovery?: DiscoveryReport; insightsStatus?: InsightsStatus; quotaStatus?: QuotaCollectorStatus; remoteGateways: RemoteGatewaySummary[]; scanRoots: ScanRoot[]; excluded: ExcludedWorkspace[]; activity: ActivityRecord[]; onAddRoot: () => Promise<void>; onRemoveRoot: (id: string) => Promise<void>; onRestore: (path: string) => Promise<void>; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>; onLocaleChanged: (runtime: RuntimeInfo) => void; onRemoteGatewaysChanged: () => Promise<void> }) {
  if (section === "general") return <div className="settings-groups"><section className="panel settings-section settings-general"><div className="setting-rows"><ThemeSetting runtime={runtime} onChanged={onLocaleChanged} /><LanguageSetting runtime={runtime} onChanged={onLocaleChanged} /><div className="setting-row"><div><strong>{tr("settings.closeBehavior")}</strong></div><CloseBehaviorSelect value={runtime?.close_behavior} onChange={onCloseBehaviorChanged} /></div></div></section></div>;
  if (section === "discovery") return <div className="settings-groups"><SettingGroup title={tr("settings.discovery")}><div className="setting-row"><div><strong>{tr("settings.discoveryStatus")}</strong></div><span className={discovery?.errors.length ? "status rejected" : "ready"}>{discovery ? tr("settings.workspaceCount", { count: discovery.discovered_count }) : tr("home.discovering")}</span></div>{discovery?.errors.map((error) => <div className="setting-detail error" key={error}>{error}</div>)}</SettingGroup><div className="panel settings-section"><div className="panel-head"><h2>{tr("settings.scanRoots")}</h2><button className="primary" onClick={() => void onAddRoot()}>{tr("settings.addFolder")}</button></div><div className="settings-list">{scanRoots.map((root) => <div key={root.id}><FolderGit2 size={16} /><span><strong>{root.path}</strong><small>{tr("settings.maxDepth", { depth: root.max_depth })}</small></span><button className="icon-danger" onClick={() => void onRemoveRoot(root.id)}><Trash2 size={15} /></button></div>)}{!scanRoots.length && <p>{tr("settings.noScanRoots")}</p>}</div></div><div className="panel settings-section"><div className="panel-head"><h2>{tr("settings.excluded")}</h2></div><div className="settings-list">{excluded.map((item) => <div key={item.path}><X size={16} /><span><strong>{item.path}</strong><small>{formatDateTime(item.created_at)}</small></span><button className="ghost" onClick={() => void onRestore(item.path)}>{tr("common.restore")}</button></div>)}{!excluded.length && <p>{tr("settings.noExcluded")}</p>}</div></div></div>;
  if (section === "integrations") return <div className="settings-groups"><SettingGroup title="AgentKib MCP Hub"><div className="setting-row"><div><strong>{tr("mcp.network")}</strong><code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code></div><span className={runtime?.mcp_hub?.running ? "ready" : "status neutral"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span></div></SettingGroup><RemoteGatewaysSettings gateways={remoteGateways} onChanged={onRemoteGatewaysChanged} /><ObsidianSettingsCard /></div>;
  if (section === "privacy") return <div className="settings-groups"><SettingGroup title={tr("settings.localData")}><div className="setting-row"><div><strong>{tr("settings.dataLocation")}</strong><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />{tr("common.localOnly")}</span></div></SettingGroup><GitIdentitySettings /></div>;
  return <div className="settings-groups"><SettingGroup title={tr("quota.diagnostics")}><QuotaDiagnostics status={quotaStatus} /></SettingGroup><SettingGroup title={tr("settings.providerStatus")}>{insightsStatus?.providers.map((provider) => <div className="setting-row" key={provider.agent}><div className="setting-agent"><AgentIcon agent={provider.agent} /><strong>{agentLabels[provider.agent]}</strong></div><QualityBadge quality={provider.available ? provider.quality : "incomplete"} /></div>)}{!insightsStatus?.providers.length && <div className="setting-empty">{tr("insights.noData")}</div>}</SettingGroup><ActivityPage records={activity} /></div>;
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="panel settings-section"><div className="panel-head"><h2>{title}</h2></div><div className="setting-rows">{children}</div></section>; }

function LanguageSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: LocalePreference) => {
    const nextRuntime = await api.setLocale(preference);
    await changeLocale(nextRuntime.effective_locale);
    onChanged(nextRuntime);
  };
  return <div className="setting-row"><div><strong>{tr("settings.language")}</strong></div><select aria-label={tr("settings.language")} className="setting-select" value={runtime?.locale_preference ?? "system"} onChange={(event) => void update(event.target.value as LocalePreference)}>{(["system", "zh-CN", "zh-TW", "ja-JP", "en-US"] as LocalePreference[]).map((locale) => <option key={locale} value={locale}>{tr(`settings.language.${locale}`)}</option>)}</select></div>;
}

function ThemeSetting({ runtime, onChanged }: { runtime?: RuntimeInfo; onChanged: (runtime: RuntimeInfo) => void }) {
  const update = async (preference: ThemePreference) => {
    const nextRuntime = await api.setThemePreference(preference);
    applyTheme(nextRuntime.effective_theme);
    onChanged(nextRuntime);
  };
  return <div className="setting-row"><div><strong>{tr("settings.theme")}</strong></div><div className="theme-segments" role="group" aria-label={tr("settings.theme")}>{(["light", "dark", "system"] as ThemePreference[]).map((theme) => <button key={theme} type="button" className={(runtime?.theme_preference ?? "system") === theme ? "active" : ""} aria-pressed={(runtime?.theme_preference ?? "system") === theme} onClick={() => void update(theme)}>{tr(`settings.theme.${theme}`)}</button>)}</div></div>;
}

function CloseBehaviorSelect({ value, onChange }: { value?: CloseBehavior; onChange: (behavior?: CloseBehavior) => Promise<void> }) {
  return <select className="setting-select" value={value ?? "ask"} onChange={(event) => void onChange(event.target.value === "ask" ? undefined : event.target.value as CloseBehavior)}><option value="ask">{tr("settings.close.ask")}</option><option value="minimize-to-tray">{tr("settings.close.tray")}</option><option value="quit">{tr("settings.close.quit")}</option></select>;
}

function GitIdentitySettings() {
  const [identities, setIdentities] = useState<GitIdentitySummary[]>([]); const [email, setEmail] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setIdentities(await api.gitIdentities()); } catch (reason) { setError(localizeMessage(reason)); } };
  useEffect(() => { void load(); }, []);
  const add = async () => { if (!email.trim()) return; try { setError(""); await api.addGitIdentityAlias(email); setEmail(""); await load(); } catch (reason) { setError(localizeMessage(reason)); } };
  return <div className="panel"><div className="panel-head"><div><h2>{tr("settings.gitIdentity")}</h2><p>{tr("settings.gitIdentityDescription")}</p></div></div>{error && <div className="alert">{error}</div>}<div className="git-identity-form"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void add(); }} placeholder={tr("settings.gitAliasPlaceholder")} /><button className="ghost" onClick={() => void add()}>{tr("settings.addAlias")}</button></div><div className="settings-list">{identities.map((identity) => <label key={identity.id}><GitCommitHorizontal size={15} /><span><strong>{metadataLabel(identity.label)}</strong><small>{identity.source} · {identity.id.slice(0, 10)}…</small></span><input type="checkbox" checked={identity.enabled} onChange={async (event) => { await api.setGitIdentityEnabled(identity.id, event.target.checked); await load(); }} /></label>)}{!identities.length && <p>{tr("settings.gitIdentityEmpty")}</p>}</div></div>;
}

function Overview({ workspace, scan, manifest }: { workspace: WorkspaceSummary; scan: WorkspaceScan; manifest: Manifest }) {
  const configuredAgents = scan.agents.filter((agent) => agent.detected || agent.warnings.length > 0);
  const unconfiguredAgents = scan.agents.filter((agent) => !agent.detected && agent.warnings.length === 0);
  const issueCount = scan.warnings.length + scan.agents.reduce((total, agent) => total + agent.warnings.length, 0);
  const sharedAssets = (manifest.instructions.shared.trim() ? 1 : 0) + manifest.instructions.scoped.length + manifest.skills.length + manifest.connections.length;
  const sources = workspace.sources.flatMap((source) => source.agent ? [agentLabels[source.agent]] : []).filter((value, index, values) => values.indexOf(value) === index).join(" · ") || tr("workspace.source.manual");
  return <div className="stack">
    {scan.warnings.map((warning) => <div className="warning overview-warning" key={warning}><CircleAlert size={15} />{warning}</div>)}
    <div className="workspace-overview-meta"><button type="button" title={tr("workspace.copyPath")} onClick={() => void navigator.clipboard?.writeText(workspace.path)}><code>{workspace.path}</code><Copy size={13} /></button><span><strong>{tr("workspace.discoverySources")}</strong>{sources}</span><span><strong>{tr("workspace.lastScanLabel")}</strong>{workspace.last_scanned_at ? relativeTime(workspace.last_scanned_at) : tr("common.never")}</span></div>
    <div className="workspace-summary-bar"><div><span>{tr("overview.health")}</span><strong>{workspaceStatusLabel(issueCount ? "attention" : "healthy")}</strong></div><div><span>{tr("overview.sharedAssets")}</span><strong>{sharedAssets}</strong></div><div><span>{tr("overview.projectAgentConfigs")}</span><strong>{scan.agents.filter((agent) => agent.detected).length}</strong></div><div><span>{tr("overview.realIssues")}</span><strong>{issueCount}</strong></div></div>
    <div className="workspace-overview-grid"><section className="panel"><div className="panel-head"><h2>{tr("overview.publicSource")}</h2>{scan.manifest_exists && <span className="badge">Schema v{manifest.schema_version}</span>}</div><dl className="summary-list"><div><dt>{tr("assets.sharedInstructions")}</dt><dd>{manifest.instructions.shared.trim() ? 1 : 0}</dd></div><div><dt>{tr("overview.sharedSkills")}</dt><dd>{manifest.skills.length}</dd></div><div><dt>MCP</dt><dd>{manifest.connections.length}</dd></div><div><dt>{tr("overview.scopedRules")}</dt><dd>{manifest.instructions.scoped.length}</dd></div></dl></section><section className="panel"><div className="panel-head"><h2>{tr("overview.projectAgentConfigs")}</h2></div><div className="agent-readiness-list">{configuredAgents.map((agent) => <div key={agent.agent}><AgentIcon agent={agent.agent} /><strong>{agentLabels[agent.agent]}</strong><span>{tr("overview.nativeAssets", { count: agent.asset_count })}</span><span className={agent.warnings.length ? "status attention" : "ready"}>{tr(agent.warnings.length ? "status.workspace.attention" : "overview.detected")}</span></div>)}{!configuredAgents.length && <p className="neutral-empty">{tr("overview.noProjectAgentConfigs")}</p>}{unconfiguredAgents.length > 0 && <details className="unconfigured-agents"><summary>{tr("overview.otherAgents", { count: unconfiguredAgents.length })}</summary>{unconfiguredAgents.map((agent) => <div key={agent.agent}><AgentIcon agent={agent.agent} /><strong>{agentLabels[agent.agent]}</strong><span>{tr("overview.noProjectConfig")}</span></div>)}</details>}</div></section></div>
    <WorkspaceObsidianCard workspaceId={workspace.id} />
  </div>;
}

function Assets({ section, onSection, scan, manifest, onChange }: { section: WorkspaceAssetSection; onSection: (section: WorkspaceAssetSection) => void; scan: WorkspaceScan; manifest: Manifest; onChange: (manifest: Manifest) => void }) {
  const [query, setQuery] = useState("");
  const [skillName, setSkillName] = useState(""); const [skillPath, setSkillPath] = useState("");
  const [connectionName, setConnectionName] = useState(""); const [transport, setTransport] = useState<"stdio" | "http">("stdio"); const [endpoint, setEndpoint] = useState("");
  const filtered = scan.assets.filter((asset) => `${asset.agent} ${asset.kind} ${asset.path}`.toLowerCase().includes(query.toLowerCase()));
  const addSkill = () => { if (!skillName.trim() || !skillPath.trim()) return; onChange({ ...manifest, skills: [...manifest.skills.filter((skill) => skill.name !== skillName.trim()), { name: skillName.trim(), path: skillPath.trim(), targets: [] }] }); setSkillName(""); setSkillPath(""); };
  const addConnection = () => { if (!connectionName.trim() || !endpoint.trim()) return; const common = { name: connectionName.trim(), env: {}, allow_tools: [] as string[], targets: [] as AgentKind[] }; const connection: ConnectionDefinition = transport === "stdio" ? { ...common, transport, command: endpoint.trim(), args: [] } : { ...common, transport, url: endpoint.trim() }; onChange({ ...manifest, connections: [...manifest.connections.filter((item) => item.name !== connection.name), connection] }); setConnectionName(""); setEndpoint(""); };
  const tabs: Array<[WorkspaceAssetSection, string, number]> = [["instructions", "assets.instructions", manifest.instructions.shared.trim() ? 1 : 0], ["skills", "assets.skills", manifest.skills.length], ["mcp", "MCP", manifest.connections.length], ["native", "assets.nativeAssets", scan.assets.length]];
  return <div className="stack workspace-assets"><div className="section-tabs workspace-asset-tabs" role="tablist" aria-label={tr("nav.assets")}>{tabs.map(([value, label, count]) => <button role="tab" aria-selected={section === value} className={section === value ? "active" : ""} key={value} onClick={() => onSection(value)}>{label === "MCP" ? label : tr(label)}<em>{count}</em></button>)}</div>
    {section === "instructions" && <div className="panel asset-task">{!scan.manifest_exists && <div className="shared-layer-note"><ShieldCheck size={16} /><strong>{tr("assets.sharedLayerEmpty")}</strong></div>}<label className="instruction-editor">{tr("assets.sharedInstructions")}<textarea value={manifest.instructions.shared} onChange={(event) => onChange({ ...manifest, instructions: { ...manifest.instructions, shared: event.target.value } })} /></label></div>}
    {section === "skills" && <div className="panel asset-task"><div className="managed-list">{manifest.skills.map((skill) => <span className="managed-item" key={skill.name}><span><strong>{skill.name}</strong><small>{skill.path}</small></span><button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, skills: manifest.skills.filter((item) => item.name !== skill.name) })}><X size={13} /></button></span>)}</div><div className="inline-form"><input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder={tr("assets.name")} /><input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder=".agents/skills/name" /><button className="primary" onClick={addSkill}>{tr("common.add")}</button></div></div>}
    {section === "mcp" && <div className="panel asset-task"><div className="managed-list">{manifest.connections.map((connection) => <span className="managed-item" key={connection.name}><span><strong>{connection.name}</strong><small>{connection.transport === "stdio" ? connection.command : connection.url}</small></span><button aria-label={tr("common.remove")} onClick={() => onChange({ ...manifest, connections: manifest.connections.filter((item) => item.name !== connection.name) })}><X size={13} /></button></span>)}</div><div className="inline-form connection-form"><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder={tr("assets.name")} /><select value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></select><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"} /><button className="primary" onClick={addConnection}>{tr("common.add")}</button></div></div>}
    {section === "native" && <div className="panel asset-task"><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("assets.searchPlaceholder")} /></div><span>{tr("overview.nativeAssets", { count: filtered.length })}</span></div><div className="asset-table"><div className="table-row table-head"><span>{tr("assets.asset")}</span><span>Agent</span><span>{tr("assets.type")}</span><span>{tr("assets.size")}</span></div>{filtered.map((asset) => <div className="table-row" key={`${asset.agent}-${asset.path}`}><span className="asset-name"><FileCode2 size={16} /><div><strong>{asset.path.split("/").pop()}</strong><small>{shortPath(asset.path)}</small></div></span><span>{agentLabels[asset.agent]}</span><span><span className="tag">{tr(`status.asset.${asset.kind}`)}</span></span><span>{formatBytes(asset.size)}</span></div>)}</div></div>}
  </div>;
}

function ContextPage({ project, onOpenInstructions }: { project: string; onOpenInstructions: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("codex"); const [cwd, setCwd] = useState(project); const [preview, setPreview] = useState<ContextPreview>(); const [error, setError] = useState(""); const [resolving, setResolving] = useState(false);
  const requestSequence = useRef(0);
  const run = async () => { const sequence = ++requestSequence.current; setResolving(true); setError(""); try { const next = await api.context(project, cwd, agent); if (sequence === requestSequence.current) setPreview(next); } catch (value) { if (sequence === requestSequence.current) setError(localizeMessage(value)); } finally { if (sequence === requestSequence.current) setResolving(false); } };
  useEffect(() => { const timeout = window.setTimeout(() => { void run(); }, 350); return () => window.clearTimeout(timeout); }, [project, cwd, agent]);
  const empty = preview && !preview.sections.length;
  return <div className={`context-layout${empty ? " is-empty" : ""}`}><div className="panel config-panel"><h2>{tr("context.environment")}</h2><label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>{tr("context.workingDirectory")}<input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label><button className="ghost" onClick={() => void run()} disabled={resolving}><RefreshCw size={14} className={resolving ? "spin" : ""} />{tr("context.resolve")}</button><div className="separator" /><h3>{tr("context.capabilities")}</h3><Pills values={preview?.visible_skills ?? []} empty={tr("context.noSkill")} /><Pills values={preview?.visible_connections ?? []} empty={tr("context.noConnection")} /></div><div className="panel context-preview"><div className="panel-head"><h2>{tr("context.effective")}</h2>{preview && <span className="badge">{preview.sections.length} {tr("common.sections")}</span>}</div>{error && <div className="alert">{error}</div>}{preview?.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={15} />{warning}</div>)}{empty && <div className="compact-state"><FileCode2 size={18} /><span>{tr("context.noInstructions")}</span><button className="ghost" onClick={onOpenInstructions}>{tr("context.openInstructions")}</button></div>}<div className="timeline">{preview?.sections.map((contextSection, index) => <article key={`${contextSection.source}-${index}`}><span className="step">{index + 1}</span><div><header><strong>{shortPath(contextSection.source)}</strong><span>{contextSection.scope || tr("status.scope.project")}</span></header><details><summary>{tr("context.showContent")}</summary><pre>{contextSection.content}</pre></details></div></article>)}</div>{preview?.approved_memories.length ? <div className="memory-context"><h3>{tr("context.approvedMemory")}</h3>{preview.approved_memories.map((item) => <p key={item}>{item}</p>)}</div> : null}</div></div>;
}

function Changes({ changeSet, onPlanHome, onApplied, onRejected }: { changeSet?: ChangeSet; onPlanHome: () => void; onApplied: () => void; onRejected: () => void }) {
  const [selected, setSelected] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [homeApproved, setHomeApproved] = useState(false);
  const change = changeSet?.changes[selected];
  if (!changeSet) return <Empty compact icon={GitCompareArrows} title={tr("changes.empty")} text={tr("changes.emptyText")} />;
  const apply = async () => { setBusy(true); try { await api.apply(changeSet, homeApproved); await onApplied(); } catch (value) { setError(String(value)); } finally { setBusy(false); } };
  return <div className="changes-layout"><div className="panel file-list"><div className="panel-head"><div><h2>ChangeSet</h2><p>{changeSet.id.slice(0, 8)} · {changeSet.changes.length} {tr("common.files")}</p></div></div>{changeSet.changes.map((file, index) => <button key={file.target} className={index === selected ? "active" : ""} onClick={() => setSelected(index)}><FileCode2 size={16} /><div><strong>{file.target.split("/").pop()}</strong><span>{shortPath(file.target)}</span></div><span className={`risk ${file.risk}`}>{tr(`status.risk.${file.risk}`)}</span></button>)}<div className="home-toggle"><p>{tr("changes.homeQuestion")}</p><button className="ghost" onClick={onPlanHome}>{tr("changes.includeHome")}</button>{changeSet.requires_home_approval && <label className="home-approval"><input type="checkbox" checked={homeApproved} onChange={(event) => setHomeApproved(event.target.checked)} />{tr("changes.homeApproval")}</label>}</div></div><div className="panel diff-panel">{change ? <><div className="panel-head"><div><h2>{change.target.split("/").pop()}</h2><p>{change.target} · {tr(`status.scope.${change.scope}`)}</p></div><span className={`risk ${change.risk}`}>{tr(`status.risk.${change.risk}`)}</span></div><Diff before={change.before} after={change.after} /></> : <Empty icon={Check} title={tr("changes.synced")} text={tr("changes.syncedText")} />}{error && <div className="alert">{error}</div>}<div className="apply-bar"><div><ShieldCheck size={17} /><span>{tr("changes.hashValidation")}</span></div><div className="apply-actions"><button className="ghost" onClick={onRejected} disabled={busy}>{tr("changes.reject")}</button><button className="primary" onClick={apply} disabled={busy || !changeSet.changes.length || (changeSet.requires_home_approval && !homeApproved)}>{tr(busy ? "changes.applying" : "changes.apply", { count: changeSet.changes.length })}</button></div></div></div></div>;
}

function MemoryInbox({ project, manifest }: { project: string; manifest: Manifest }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("project_fact"); const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const load = async (searchQuery = query) => { try { setError(""); setRecords(searchQuery.trim() ? await api.searchMemories(project, searchQuery) : await api.memories(project)); } catch (value) { setError(String(value)); } };
  useEffect(() => { void load(); }, [project]);
  const propose = async () => { if (!content.trim()) return; try { await api.proposeMemory(project, content, type); setContent(""); await load(); } catch (value) { setError(String(value)); } };
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { try { await api.reviewMemory(id, status, editedContent); await load(); } catch (value) { setError(String(value)); } };
  return <div className="memory-layout"><div className="panel compose"><span className="eyebrow">{tr("memory.newProposal")}</span><h2>{tr("memory.captureFact")}</h2><p>{tr("memory.approvedDescription")}</p><label>{tr("memory.type")}<select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{["project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation","user_preference"].map((value) => <option key={value} value={value}>{tr(`status.memoryType.${value}`)}</option>)}</select></label><label>{tr("memory.content")}<textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={tr("memory.contentPlaceholder")} /></label><button className="primary" onClick={propose}>{tr("memory.submit")}</button><small>Workspace: {manifest.workspace.id.slice(0, 8)}</small></div><div className="panel inbox"><div className="panel-head"><div><h2>{tr("memory.inbox")}</h2><p>{query.trim() ? tr("memory.approvedSearchOnly") : tr("memory.pendingCount", { count: records.filter((r) => r.status === "pending").length })}</p></div><div className="memory-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder={tr("memory.searchPlaceholder")} /><button className="ghost" onClick={() => void load()}>{tr("common.search")}</button>{query && <button className="link" onClick={() => { setQuery(""); void load(""); }}>{tr("common.clear")}</button>}</div></div>{error && <div className="alert">{error}</div>}<div className="memory-list">{records.map((record) => <MemoryCard key={record.id} record={record} onReview={review} />)}{!records.length && <Empty icon={Brain} title={query.trim() ? tr("memory.noSearchMatch") : tr("memory.empty")} text={query.trim() ? tr("memory.noSearchMatchText") : tr("memory.workspaceEmptyText")} />}</div></div></div>;
}

function MemoryCard({ record, onReview }: { record: MemoryRecord; onReview: (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  return <article><div><span className={`status ${record.status}`}>{tr(`status.memory.${record.status}`)}</span><span className="tag">{tr(`status.memoryType.${record.memory_type}`)}</span><time>{formatDateTime(record.created_at)}</time></div>{editing ? <textarea className="memory-edit" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p>{record.content}</p>}{record.source_agent && <small>{tr("memory.source", { source: record.source_agent })}</small>}{record.status === "pending" && <footer><button className="approve" onClick={() => onReview(record.id, "approved", editing ? draft : undefined)}><Check size={15} />{editing ? tr("memory.saveApprove") : tr("common.approve")}</button><button className="ghost" onClick={() => setEditing((value) => !value)}>{editing ? <X size={14} /> : <Pencil size={14} />}{editing ? tr("memory.cancelEdit") : tr("common.edit")}</button><button className="reject" onClick={() => onReview(record.id, "rejected")}>{tr("common.reject")}</button></footer>}{record.status === "approved" && <footer><button className="reject" onClick={() => onReview(record.id, "invalidated")}>{tr("memory.invalidate")}</button></footer>}</article>;
}

function SettingsPage({ runtime, manifest, onManifestChange, onCloseBehaviorChanged, onLocaleChanged }: { runtime?: RuntimeInfo; manifest: Manifest; onManifestChange: (manifest: Manifest) => void; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>; onLocaleChanged: (runtime: RuntimeInfo) => void }) {
  const setAdapterEnabled = (agent: AgentKind, enabled: boolean) => onManifestChange({ ...manifest, adapters: { ...manifest.adapters, [agent]: { enabled, generated_hashes: manifest.adapters[agent]?.generated_hashes ?? {} } } });
  return <div className="settings-grid"><LanguageSetting runtime={runtime} onChanged={onLocaleChanged} /><div className="panel setting-card"><div className="setting-icon"><PlugZap /></div><div><h2>AgentKib MCP Hub</h2><p>{tr("settings.mcpDescription")}</p><code>{runtime?.mcp_hub ? `127.0.0.1:${runtime.mcp_hub.port}` : "—"}</code></div><span className={runtime?.mcp_hub?.running ? "ready" : "status rejected"}>{tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}</span></div><div className="panel setting-card"><div className="setting-icon"><Activity /></div><div><h2>{tr("settings.closeBehavior")}</h2><p>{tr("settings.closeBehaviorWorkspaceDescription")}</p></div><CloseBehaviorSelect value={runtime?.close_behavior} onChange={onCloseBehaviorChanged} /></div><div className="panel setting-card"><div className="setting-icon"><ShieldCheck /></div><div><h2>{tr("settings.localData")}</h2><p>{tr("settings.localDataWorkspaceDescription")}</p><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />{tr("common.localOnly")}</span></div><div className="panel adapter-settings"><div className="panel-head"><div><h2>{tr("settings.adapters")}</h2><p>{tr("settings.adaptersDescription")}</p></div></div><div className="adapter-toggle-grid">{(Object.keys(agentLabels) as AgentKind[]).map((agent) => <label key={agent}><AgentIcon agent={agent} /><span><strong>{agentLabels[agent]}</strong><small>{tr(manifest.adapters[agent]?.enabled === false ? "common.disabled" : "common.enabled")}</small></span><input type="checkbox" checked={manifest.adapters[agent]?.enabled !== false} onChange={(event) => setAdapterEnabled(agent, event.target.checked)} /></label>)}</div></div><div className="panel paths"><h2>{tr("settings.agentHomes")}</h2><p>{tr("settings.agentHomesDescription")}</p><dl><div><dt>OpenClaw</dt><dd>{runtime?.openclaw_config ?? tr("settings.homeNotFound")}</dd></div><div><dt>Hermes</dt><dd>{runtime?.hermes_config ?? tr("settings.homeNotFound")}</dd></div></dl></div></div>;
}

function Pills({ values, empty }: { values: string[]; empty: string }) { return <div className="pills">{values.length ? values.map((value) => <span key={value}>{value}</span>) : <small>{empty}</small>}</div>; }
function Empty({ icon: Icon, title, text, compact = false }: { icon: typeof Brain; title: string; text: string; compact?: boolean }) { return <div className={`empty${compact ? " compact" : ""}`}><Icon size={28} /><h3>{title}</h3>{text && <p>{text}</p>}</div>; }
function Diff({ before, after }: { before: string; after: string }) { return <pre className="diff">{diffLines(before, after).map((line, index) => <div className={line.type} key={`${index}-${line.content}`}><span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>{line.content || " "}</div>)}</pre>; }
function shortPath(path: string) { const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }
function localizedAssetSummary(asset: CatalogAsset | CatalogAssetGroup | WorkspaceScan["assets"][number]) { return asset.summary_key ? tr(asset.summary_key, { ...asset.summary_params, defaultValue: asset.summary }) : asset.summary; }
function achievementTranslationKey(code: string) {
  return ({
    "token-100000": "token_100k", "token-1000000": "token_1m", "token-10000000": "token_10m", "token-100000000": "token_100m",
    "token-1000000000": "token_1b", "token-10000000000": "token_10b", "token-100000000000": "token_100b", "token-1000000000000": "token_1t",
    "session-10": "session_10", "session-50": "session_50", "session-100": "session_100", "session-500": "session_500", "session-1000": "session_1000", "session-5000": "session_5000", "session-10000": "session_10000",
    "commit-1": "commit_1", "commit-10": "commit_10", "commit-100": "commit_100", "commit-1000": "commit_1000", "commit-5000": "commit_5000", "commit-10000": "commit_10000",
    "active-days-7": "active_days_7", "active-days-30": "active_days_30", "active-days-100": "active_days_100", "active-days-365": "active_days_365", "active-days-1000": "active_days_1000",
    "streak-3": "streak_3", "streak-7": "streak_7", "streak-14": "streak_14", "streak-30": "streak_30", "streak-60": "streak_60", "streak-100": "streak_100", "streak-180": "streak_180", "streak-365": "streak_365",
    "workspaces-1": "workspaces_1", "workspaces-5": "workspaces_5", "workspaces-10": "workspaces_10", "workspaces-25": "workspaces_25", "workspaces-50": "workspaces_50", "workspaces-100": "workspaces_100",
    "agents-1": "agents_1", "agents-2": "agents_2", "agents-3": "agents_3", "agents-4": "agents_4", "agents-5": "agents_5",
    "special-first-changeset": "special_first_changeset", "special-first-memory": "special_first_memory", "special-shared-workspace": "special_shared_workspace", "special-exact-attribution": "special_exact_attribution",
    "special-remote-handshake": "special_remote_handshake", "special-night-owl": "special_night_owl", "special-comeback": "special_comeback", "special-same-day-delivery": "special_same_day_delivery",
  } as Record<string, string>)[code] ?? code;
}
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function formatCompact(value: number) { return formatCompactNumber(value); }
function qualityLabel(value: UsageQuality) { return tr(`status.quality.${value}`); }
function localDate(value: Date) { const year = value.getFullYear(); const month = String(value.getMonth() + 1).padStart(2, "0"); const day = String(value.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
function workspaceStatusLabel(status: WorkspaceSummary["status"]) { return tr(`status.workspace.${status}`); }
function relativeTime(value: string) { return formatRelativeTime(value); }
function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (!tabs.length || current < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}
