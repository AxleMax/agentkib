import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Activity, ArrowLeft, Bot, Boxes, Brain, Check, ChevronRight, CircleAlert, Code2, FileCode2, FolderGit2, GitCompareArrows, History, Home, LayoutDashboard, Library, Pencil, PlugZap, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { api } from "./api";
import { diffLines } from "./diff";
import type { ActivityRecord, AgentInstallation, AgentKind, CatalogAsset, ChangeSet, CloseBehavior, ConnectionDefinition, ContextPreview, DiscoveryReport, ExcludedWorkspace, Manifest, MemoryRecord, MemoryType, RuntimeInfo, ScanRoot, WorkspaceScan, WorkspaceSummary } from "./types";

type Page = "overview" | "assets" | "context" | "changes" | "memory" | "settings";
type GlobalPage = "home" | "workspaces" | "agents" | "catalog" | "memory" | "activity" | "settings";

const agentLabels: Record<AgentKind, string> = { codex: "Codex", "claude-code": "Claude Code", "open-claw": "OpenClaw", hermes: "Hermes" };
const nav = [
  ["overview", "Overview", LayoutDashboard], ["assets", "Assets", Boxes], ["context", "Context Preview", Code2],
  ["changes", "Changes", GitCompareArrows], ["memory", "Memory Inbox", Brain], ["settings", "Settings", Settings],
] as const;
const globalNav = [
  ["home", "Home", Home], ["workspaces", "Workspaces", FolderGit2], ["agents", "Agents", Bot],
  ["catalog", "Asset Catalog", Library], ["memory", "Memory Inbox", Brain], ["activity", "Activity", History], ["settings", "Settings", Settings],
] as const;

export function App() {
  const [page, setPage] = useState<Page>("overview"); const [globalPage, setGlobalPage] = useState<GlobalPage>("home");
  const [project, setProject] = useState(""); const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSummary>();
  const [scan, setScan] = useState<WorkspaceScan>();
  const [manifest, setManifest] = useState<Manifest>();
  const [changeSet, setChangeSet] = useState<ChangeSet>();
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]); const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [catalog, setCatalog] = useState<CatalogAsset[]>([]); const [globalMemories, setGlobalMemories] = useState<MemoryRecord[]>([]); const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [scanRoots, setScanRoots] = useState<ScanRoot[]>([]); const [excluded, setExcluded] = useState<ExcludedWorkspace[]>([]); const [discovery, setDiscovery] = useState<DiscoveryReport>();

  const load = async (path = project) => {
    if (!path) return;
    setBusy(true); setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([api.scan(path), api.manifest(path), api.runtime()]);
      setProject(path); setScan(nextScan); setManifest(nextManifest); setRuntime(nextRuntime);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  const loadGlobal = async () => {
    const [nextWorkspaces, nextInstallations, nextCatalog, nextMemories, nextActivity, nextRoots, nextExcluded, nextRuntime] = await Promise.all([
      api.workspaces(), api.agentInstallations(), api.catalogAssets(), api.globalMemories(), api.activity(), api.scanRoots(), api.excludedWorkspaces(), api.runtime(),
    ]);
    setWorkspaces(nextWorkspaces); setInstallations(nextInstallations); setCatalog(nextCatalog); setGlobalMemories(nextMemories); setActivity(nextActivity); setScanRoots(nextRoots); setExcluded(nextExcluded); setRuntime(nextRuntime);
  };

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<DiscoveryReport>("agenthub:discovery-updated", (event) => { setDiscovery(event.payload); void loadGlobal(); });
        const legacy = localStorage.getItem("agenthub.project");
        if (legacy) { await api.addWorkspace(legacy); localStorage.removeItem("agenthub.project"); }
        await loadGlobal();
        try {
          const report = await api.discoverWorkspaces();
          if (!disposed) { setDiscovery(report); await loadGlobal(); }
        } catch (error) {
          // Rust 启动调度可能已经占用发现任务；事件监听会接收其结果。
          if (!String(error).includes("正在运行")) throw error;
        }
      } catch (error) { if (!disposed) setMessage(String(error)); }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    const refreshRuntime = () => { void api.runtime().then(setRuntime).catch(() => undefined); };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, []);

  const selectProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: "手动添加工作区" });
    if (typeof selected === "string") { const workspace = await api.addWorkspace(selected); await loadGlobal(); await openWorkspace(workspace); }
  };

  const openWorkspace = async (workspace: WorkspaceSummary) => { setSelectedWorkspace(workspace); setPage("overview"); setChangeSet(undefined); await load(workspace.path); };
  const closeWorkspace = () => { setSelectedWorkspace(undefined); setProject(""); setScan(undefined); setManifest(undefined); setChangeSet(undefined); };

  const plan = async (includeHome = false) => {
    if (!project || !manifest) return;
    setBusy(true); setMessage("");
    try { const changes = await api.plan(project, manifest, includeHome); setChangeSet(changes); setPage("changes"); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  if (selectedWorkspace && project && scan && manifest) return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><div><strong>AgentHub</strong><span>Local control plane</span></div></div>
        <button className="back-global" onClick={closeWorkspace}><ArrowLeft size={15} />全部工作区</button>
        <button className="project-switcher" onClick={() => setPage("overview")}><FolderGit2 size={17} /><div><strong>{manifest.workspace.name}</strong><span>{shortPath(project)}</span></div><ChevronRight size={15} /></button>
        <nav>{nav.map(([id, label, Icon]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={17} />{label}{id === "changes" && changeSet?.changes.length ? <em>{changeSet.changes.length}</em> : null}</button>)}</nav>
        <div className="sidebar-foot"><div className="status-dot" /> Local only · No cloud sync</div>
      </aside>
      <main>
        <header><div><h1>{nav.find(([id]) => id === page)?.[1]}</h1><p>{pageDescription(page)}</p></div><div className="header-actions"><button className="ghost" onClick={() => load()} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} />重新扫描</button><button className="primary" onClick={() => plan(false)} disabled={busy}><GitCompareArrows size={15} />生成变更</button></div></header>
        {message && <div className="alert"><CircleAlert size={17} />{message}</div>}
        <section className="content">
          {page === "overview" && <Overview scan={scan} manifest={manifest} runtime={runtime} onImport={() => plan(false)} />}
          {page === "assets" && <Assets scan={scan} manifest={manifest} onChange={setManifest} />}
          {page === "context" && <ContextPage project={project} />}
          {page === "changes" && <Changes changeSet={changeSet} onPlanHome={() => plan(true)} onApplied={() => load()} onRejected={() => setChangeSet(undefined)} />}
          {page === "memory" && <MemoryInbox project={project} manifest={manifest} />}
          {page === "settings" && <SettingsPage runtime={runtime} manifest={manifest} onManifestChange={setManifest} onInstalled={async () => { await api.installMcp(); setRuntime(await api.runtime()); }} onCloseBehaviorChanged={async (behavior) => { await api.setCloseBehavior(behavior); setRuntime(await api.runtime()); }} />}
        </section>
      </main>
    </div>
  );

  const refreshDiscovery = async () => { setBusy(true); setMessage(""); try { setDiscovery(await api.discoverWorkspaces()); await loadGlobal(); } catch (error) { setMessage(String(error)); } finally { setBusy(false); } };
  return <div className="app-shell global-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><div><strong>AgentHub</strong><span>Agent asset control plane</span></div></div><nav>{globalNav.map(([id, label, Icon]) => <button key={id} className={globalPage === id ? "active" : ""} onClick={() => setGlobalPage(id)}><Icon size={17} />{label}{id === "memory" && globalMemories.filter((item) => item.status === "pending").length ? <em>{globalMemories.filter((item) => item.status === "pending").length}</em> : null}</button>)}</nav><div className="sidebar-foot"><div className="status-dot" /> Local only · {workspaces.length} workspaces</div></aside><main><header><div><h1>{globalNav.find(([id]) => id === globalPage)?.[1]}</h1><p>{globalPageDescription(globalPage)}</p></div><div className="header-actions"><button className="ghost" onClick={() => void refreshDiscovery()} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} />刷新发现</button><button className="primary" onClick={() => void selectProject()}><FolderGit2 size={15} />手动添加</button></div></header>{message && <div className="alert"><CircleAlert size={17} />{message}</div>}<section className="content global-content">
    {globalPage === "home" && <GlobalHome workspaces={workspaces} installations={installations} memories={globalMemories} discovery={discovery} activity={activity} onOpen={openWorkspace} onAddRoot={async () => { await addScanRootFromDialog(); }} />}
    {globalPage === "workspaces" && <WorkspacesPage workspaces={workspaces} onOpen={openWorkspace} onRefresh={async (id) => { await api.refreshWorkspace(id); await loadGlobal(); }} onExclude={async (id) => { await api.excludeWorkspace(id); await loadGlobal(); }} />}
    {globalPage === "agents" && <AgentsPage installations={installations} assets={catalog.filter((asset) => asset.scope === "agent-home")} workspaces={workspaces} />}
    {globalPage === "catalog" && <CatalogPage assets={catalog} workspaces={workspaces} onOpen={(id) => { const workspace = workspaces.find((item) => item.id === id); if (workspace) void openWorkspace(workspace); }} />}
    {globalPage === "memory" && <GlobalMemoryInbox records={globalMemories} workspaces={workspaces} onReload={loadGlobal} />}
    {globalPage === "activity" && <ActivityPage records={activity} />}
    {globalPage === "settings" && <GlobalSettings runtime={runtime} discovery={discovery} scanRoots={scanRoots} excluded={excluded} onAddRoot={addScanRootFromDialog} onRemoveRoot={async (id) => { await api.removeScanRoot(id); await refreshDiscovery(); }} onRestore={async (path) => { await api.restoreExcludedWorkspace(path); await refreshDiscovery(); }} onInstalled={async () => { await api.installMcp(); await loadGlobal(); }} onCloseBehaviorChanged={async (behavior) => { await api.setCloseBehavior(behavior); await loadGlobal(); }} />}
  </section></main></div>;

  async function addScanRootFromDialog() { const selected = await open({ directory: true, multiple: false, title: "添加授权扫描目录" }); if (typeof selected === "string") { await api.addScanRoot(selected, 5); await refreshDiscovery(); } }
}

function GlobalHome({ workspaces, installations, memories, discovery, activity, onOpen, onAddRoot }: { workspaces: WorkspaceSummary[]; installations: AgentInstallation[]; memories: MemoryRecord[]; discovery?: DiscoveryReport; activity: ActivityRecord[]; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onAddRoot: () => Promise<void> }) {
  const attention = workspaces.filter((item) => item.status !== "healthy").length;
  return <div className="stack"><div className="global-hero"><div><span className="eyebrow">LOCAL AGENT ASSET CONTROL PLANE</span><h2>所有 Agent，共享一套可信资产</h2><p>自动发现 Agent 已使用的工作区，统一盘点 Instructions、Skills、MCP 和经审批的共享记忆。</p></div><span className="privacy-chip"><ShieldCheck size={15} />只保存聚合元数据</span></div><div className="metric-grid"><Metric icon={FolderGit2} label="工作区" value={String(workspaces.length)} detail={`${attention} 项待处理`} tone="purple" /><Metric icon={Bot} label="已安装 Agent" value={`${installations.filter((item) => item.installed).length} / 4`} detail="只读检测本地状态" tone="green" /><Metric icon={Library} label="资产" value={String(workspaces.reduce((total, item) => total + item.asset_count, 0))} detail="跨工作区可检索" tone="blue" /><Metric icon={Brain} label="待审批记忆" value={String(memories.filter((item) => item.status === "pending").length)} detail="批准后才可共享" tone="amber" /></div>{!workspaces.length ? <div className="panel empty-global"><FolderGit2 size={30} /><h2>没有发现可用工作区</h2><p>AgentHub 不会扫描整台磁盘。添加一个授权目录，或手动添加工作区。</p><button className="primary" onClick={() => void onAddRoot()}>添加扫描目录</button></div> : <div className="two-col global-columns"><div className="panel"><div className="panel-head"><div><h2>最近工作区</h2><p>来自 Agent 配置与全部历史元数据</p></div><span className="badge">{discovery ? `更新于 ${relativeTime(discovery.finished_at)}` : "正在发现"}</span></div><div className="workspace-list">{workspaces.slice(0, 8).map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} onOpen={onOpen} />)}</div></div><div className="panel"><div className="panel-head"><div><h2>最近活动</h2><p>发现、同步和记忆审计</p></div></div><div className="activity-list compact">{activity.slice(0, 8).map((item) => <ActivityRow key={item.id} record={item} />)}{!activity.length && <Empty icon={History} title="暂无活动" text="完成首次发现后会显示本地审计记录。" />}</div></div></div>}</div>;
}

function WorkspacesPage({ workspaces, onOpen, onRefresh, onExclude }: { workspaces: WorkspaceSummary[]; onOpen: (workspace: WorkspaceSummary) => Promise<void>; onRefresh: (id: string) => Promise<void>; onExclude: (id: string) => Promise<void> }) {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all"); const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const filtered = workspaces.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || item.status === status) && (agent === "all" || item.sources.some((source) => source.agent === agent)));
  const groups = useMemo(() => { const values = new Map<string, WorkspaceSummary[]>(); for (const item of filtered) { const key = item.repository_group_id ?? `workspace:${item.id}`; values.set(key, [...(values.get(key) ?? []), item]); } return [...values.values()]; }, [filtered]);
  return <div className="stack"><div className="panel"><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区路径或名称" /></div><div className="toolbar-filters"><select className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">全部 Agent</option>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select className="setting-select" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="healthy">健康</option><option value="needs-import">待导入</option><option value="attention">需关注</option></select></div></div><div className="repository-groups">{groups.map((group) => <section key={group[0].repository_group_id ?? group[0].id}><header><FolderGit2 size={15} /><strong>{group[0].repository_group_id ? group[0].name : "独立工作区"}</strong>{group.length > 1 && <span>{group.length} worktrees</span>}</header>{group.map((workspace) => <div className="workspace-card" key={workspace.id}><WorkspaceRow workspace={workspace} onOpen={onOpen} /><div className="workspace-actions"><button className="ghost" onClick={() => void onRefresh(workspace.id)}><RefreshCw size={13} />扫描</button><button className="icon-danger" title="从资产中心排除" onClick={() => void onExclude(workspace.id)}><Trash2 size={14} /></button></div></div>)}</section>)}{!groups.length && <Empty icon={FolderGit2} title="没有匹配的工作区" text="调整筛选条件，或手动添加一个本地项目。" />}</div></div></div>;
}

function WorkspaceRow({ workspace, onOpen }: { workspace: WorkspaceSummary; onOpen: (workspace: WorkspaceSummary) => Promise<void> }) {
  return <button className="workspace-row" onClick={() => void onOpen(workspace)}><div className="workspace-icon"><FolderGit2 size={18} /></div><div><strong>{workspace.name}</strong><small>{workspace.path}</small><span>{workspace.sources.map((source) => source.agent ? agentLabels[source.agent] : "目录扫描").filter((value, index, values) => values.indexOf(value) === index).join(" · ") || "手动添加"}</span></div><span className={`workspace-status ${workspace.status}`}>{workspaceStatusLabel(workspace.status)}</span><ChevronRight size={15} /></button>;
}

function AgentsPage({ installations, assets, workspaces }: { installations: AgentInstallation[]; assets: CatalogAsset[]; workspaces: WorkspaceSummary[] }) {
  return <div className="agent-center-grid">{(["codex", "claude-code", "open-claw", "hermes"] as AgentKind[]).map((agent) => { const installation = installations.find((item) => item.agent === agent); const homeAssets = assets.filter((item) => item.agent === agent); const count = workspaces.filter((workspace) => workspace.sources.some((source) => source.agent === agent)).length; return <div className="panel agent-center-card" key={agent}><div className="agent-center-head"><AgentLogo agent={agent} /><div><h2>{agentLabels[agent]}</h2><p>{installation?.home ?? "未检测到 Agent Home"}</p></div><span className={installation?.installed ? "ready" : "muted"}>{installation?.installed ? "已安装" : "未安装"}</span></div><dl className="summary-list"><div><dt>关联工作区</dt><dd>{count}</dd></div><div><dt>Home 资产</dt><dd>{homeAssets.length}</dd></div></dl><div className="home-asset-list">{homeAssets.slice(0, 8).map((asset) => <div key={asset.id}><FileCode2 size={13} /><span><strong>{asset.name}</strong><small>{shortPath(asset.path)}</small></span><em>{asset.kind}</em></div>)}{!homeAssets.length && <p>未发现可公开盘点的 Home 资产</p>}</div></div>; })}</div>;
}

function CatalogPage({ assets, workspaces, onOpen }: { assets: CatalogAsset[]; workspaces: WorkspaceSummary[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [scope, setScope] = useState<"all" | CatalogAsset["scope"]>("all");
  const filtered = assets.filter((asset) => `${asset.name} ${asset.path} ${asset.summary} ${asset.kind}`.toLowerCase().includes(query.toLowerCase()) && (scope === "all" || asset.scope === scope));
  return <div className="panel"><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Instructions、Skills、MCP、Hooks…" /></div><select className="setting-select" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="all">全部范围</option><option value="workspace">项目资产</option><option value="agent-home">Agent Home</option></select><span>{filtered.length} assets</span></div><div className="catalog-table"><div className="catalog-row table-head"><span>资产</span><span>范围</span><span>Agent</span><span>来源</span></div>{filtered.map((asset) => <button className="catalog-row" key={asset.id} disabled={!asset.workspace_id} onClick={() => asset.workspace_id && onOpen(asset.workspace_id)}><span className="asset-name"><FileCode2 size={15} /><span><strong>{asset.name}</strong><small>{asset.summary}</small></span></span><span className="tag">{asset.scope}</span><span>{asset.agent ? agentLabels[asset.agent] : "共享"}</span><span>{asset.workspace_id ? workspaces.find((item) => item.id === asset.workspace_id)?.name : shortPath(asset.path)}</span></button>)}{!filtered.length && <Empty icon={Library} title="没有匹配资产" text="资产目录只保存名称、路径和摘要，不索引文件正文。" />}</div></div>;
}

function GlobalMemoryInbox({ records, workspaces, onReload }: { records: MemoryRecord[]; workspaces: WorkspaceSummary[]; onReload: () => Promise<void> }) {
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { await api.reviewMemory(id, status, editedContent); await onReload(); };
  return <div className="panel inbox"><div className="panel-head"><div><h2>全局记忆收件箱</h2><p>{records.filter((item) => item.status === "pending").length} 条待审批 · 只有 approved 可被 Agent 检索</p></div></div><div className="memory-list">{records.map((record) => <div key={record.id} className="global-memory-item"><span className="workspace-memory-label">{workspaces.find((item) => item.manifest_workspace_id === record.project_id)?.name ?? record.project_id.slice(0, 8)}</span><MemoryCard record={record} onReview={review} /></div>)}{!records.length && <Empty icon={Brain} title="还没有共享记忆" text="工作区中的手工提议和 Agent MCP 提议会统一出现在这里。" />}</div></div>;
}

function ActivityPage({ records }: { records: ActivityRecord[] }) { return <div className="panel"><div className="panel-head"><div><h2>本地审计活动</h2><p>发现、ChangeSet 和记忆治理记录</p></div></div><div className="activity-list">{records.map((record) => <ActivityRow key={record.id} record={record} />)}{!records.length && <Empty icon={History} title="暂无活动" text="AgentHub 的本地操作会记录在这里。" />}</div></div>; }
function ActivityRow({ record }: { record: ActivityRecord }) { return <div className="activity-row"><span className="activity-dot" /><div><strong>{record.action}</strong><small>{record.detail}</small></div><time>{new Date(record.created_at).toLocaleString()}</time></div>; }

function GlobalSettings({ runtime, discovery, scanRoots, excluded, onAddRoot, onRemoveRoot, onRestore, onInstalled, onCloseBehaviorChanged }: { runtime?: RuntimeInfo; discovery?: DiscoveryReport; scanRoots: ScanRoot[]; excluded: ExcludedWorkspace[]; onAddRoot: () => Promise<void>; onRemoveRoot: (id: string) => Promise<void>; onRestore: (path: string) => Promise<void>; onInstalled: () => Promise<void>; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void> }) {
  return <div className="settings-grid"><div className="panel setting-card"><div className="setting-icon"><RefreshCw /></div><div><h2>自动发现</h2><p>启动时刷新，窗口隐藏后每 15 分钟继续运行。</p>{discovery?.errors.map((error) => <small className="discovery-error" key={error}>{error}</small>)}</div><span className={discovery?.errors.length ? "status rejected" : "ready"}>{discovery ? `${discovery.discovered_count} 个工作区` : "正在发现"}</span></div><div className="panel setting-card"><div className="setting-icon"><PlugZap /></div><div><h2>AgentHub MCP</h2><p>独立 stdio 服务在桌面窗口关闭后仍可使用。</p><code>{runtime?.mcp_install_path ?? "—"}</code></div><button className={runtime?.mcp_installed ? "ghost" : "primary"} onClick={() => void onInstalled()}>{runtime?.mcp_installed ? "重新安装" : "安装 MCP"}</button></div><div className="panel setting-card"><div className="setting-icon"><Activity /></div><div><h2>关闭窗口时</h2><p>隐藏后从 Dock 消失，菜单栏和后台发现继续运行。</p></div><select className="setting-select" value={runtime?.close_behavior ?? "ask"} onChange={(event) => void onCloseBehaviorChanged(event.target.value === "ask" ? undefined : event.target.value as CloseBehavior)}><option value="ask">下次关闭时询问</option><option value="minimize-to-tray">最小化到菜单栏</option><option value="quit">退出应用</option></select></div><div className="panel"><div className="panel-head"><div><h2>授权扫描目录</h2><p>仅扫描这些目录，最大深度 5；不会扫描整个 Home。</p></div><button className="primary" onClick={() => void onAddRoot()}>添加目录</button></div><div className="settings-list">{scanRoots.map((root) => <div key={root.id}><FolderGit2 size={15} /><span><strong>{root.path}</strong><small>最大深度 {root.max_depth}</small></span><button className="icon-danger" onClick={() => void onRemoveRoot(root.id)}><Trash2 size={14} /></button></div>)}{!scanRoots.length && <p>尚未授权额外扫描目录</p>}</div></div><div className="panel"><div className="panel-head"><div><h2>已排除工作区</h2><p>恢复后会在下一次发现时重新进入资产中心。</p></div></div><div className="settings-list">{excluded.map((item) => <div key={item.path}><X size={15} /><span><strong>{item.path}</strong><small>{new Date(item.created_at).toLocaleString()}</small></span><button className="ghost" onClick={() => void onRestore(item.path)}>恢复</button></div>)}{!excluded.length && <p>没有排除的工作区</p>}</div></div><div className="panel setting-card"><div className="setting-icon"><ShieldCheck /></div><div><h2>本地数据</h2><p>索引、记忆、备份和审计只保留在当前设备。</p><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />Local only</span></div></div>;
}

function Overview({ scan, manifest, runtime, onImport }: { scan: WorkspaceScan; manifest: Manifest; runtime?: RuntimeInfo; onImport: () => void }) {
  const detected = scan.agents.filter((a) => a.detected).length;
  return <div className="stack">
    {!scan.manifest_exists && <div className="panel import-banner"><Sparkles size={22} /><div><h2>准备首次导入</h2><p>已扫描现有原生资产。先查看 manifest 与各平台生成文件的 Diff，确认后才会创建或修改文件。</p></div><button className="primary" onClick={onImport}>查看导入预览</button></div>}
    {scan.warnings.map((warning) => <div className="warning overview-warning" key={warning}><CircleAlert size={15} />{warning}</div>)}
    <div className="metric-grid"><Metric icon={Activity} label="配置健康度" value={scan.warnings.length ? "需关注" : "健康"} detail={`${scan.assets.length} 个资产已索引`} tone="green" /><Metric icon={Boxes} label="已识别 Agent" value={`${detected} / 4`} detail="四平台适配已启用" tone="purple" /><Metric icon={Brain} label="共享记忆" value={manifest.memories.require_approval ? "需审批" : "自动"} detail="仅批准项会被检索" tone="amber" /><Metric icon={PlugZap} label="本地 MCP" value={runtime?.mcp_installed ? "已安装" : "待安装"} detail="App 关闭后仍可运行" tone="blue" /></div>
    <div className="panel"><div className="panel-head"><div><h2>Agent readiness</h2><p>当前项目中检测到的原生资产</p></div><span className="badge">Schema v{manifest.schema_version}</span></div><div className="agent-list">{scan.agents.map((agent) => <div className="agent-row" key={agent.agent}><AgentLogo agent={agent.agent} /><div><strong>{agentLabels[agent.agent]}</strong><span>{agent.asset_count} 个原生资产</span></div><span className={agent.detected ? "ready" : "muted"}>{agent.detected ? <><Check size={14} />已检测</> : "未配置"}</span></div>)}</div></div>
    <div className="two-col"><div className="panel"><div className="panel-head"><div><h2>公共资产源</h2><p>.agenthub/manifest.yaml</p></div></div><dl className="summary-list"><div><dt>共享 Skills</dt><dd>{manifest.skills.length}</dd></div><div><dt>MCP Connections</dt><dd>{manifest.connections.length}</dd></div><div><dt>目录级规则</dt><dd>{manifest.instructions.scoped.length}</dd></div></dl></div><div className="panel callout"><ShieldCheck size={22} /><div><h2>安全写入</h2><p>所有配置变更先生成 Diff，并通过文件哈希检测外部修改。Agent Home 写入需要独立确认。</p></div></div></div>
  </div>;
}

function Assets({ scan, manifest, onChange }: { scan: WorkspaceScan; manifest: Manifest; onChange: (manifest: Manifest) => void }) {
  const [query, setQuery] = useState("");
  const [skillName, setSkillName] = useState(""); const [skillPath, setSkillPath] = useState("");
  const [connectionName, setConnectionName] = useState(""); const [transport, setTransport] = useState<"stdio" | "http">("stdio"); const [endpoint, setEndpoint] = useState("");
  const filtered = scan.assets.filter((asset) => `${asset.agent} ${asset.kind} ${asset.path}`.toLowerCase().includes(query.toLowerCase()));
  const addSkill = () => { if (!skillName.trim() || !skillPath.trim()) return; onChange({ ...manifest, skills: [...manifest.skills.filter((skill) => skill.name !== skillName.trim()), { name: skillName.trim(), path: skillPath.trim(), targets: [] }] }); setSkillName(""); setSkillPath(""); };
  const addConnection = () => { if (!connectionName.trim() || !endpoint.trim()) return; const common = { name: connectionName.trim(), env: {}, allow_tools: [] as string[], targets: [] as AgentKind[] }; const connection: ConnectionDefinition = transport === "stdio" ? { ...common, transport, command: endpoint.trim(), args: [] } : { ...common, transport, url: endpoint.trim() }; onChange({ ...manifest, connections: [...manifest.connections.filter((item) => item.name !== connection.name), connection] }); setConnectionName(""); setEndpoint(""); };
  return <div className="stack"><div className="panel public-assets"><div className="panel-head"><div><h2>公共资产草稿</h2><p>编辑只保存在当前会话，点击“生成变更”后统一查看 Diff</p></div><span className="badge">manifest v{manifest.schema_version}</span></div><div className="asset-editor-grid"><label className="instruction-editor">共享项目指令<textarea value={manifest.instructions.shared} onChange={(event) => onChange({ ...manifest, instructions: { ...manifest.instructions, shared: event.target.value } })} /></label><div className="asset-builders"><div><h3>Skills</h3>{manifest.skills.map((skill) => <span className="managed-item" key={skill.name}><span><strong>{skill.name}</strong><small>{skill.path}</small></span><button onClick={() => onChange({ ...manifest, skills: manifest.skills.filter((item) => item.name !== skill.name) })}><X size={13} /></button></span>)}<div className="inline-form"><input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="名称" /><input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder=".agents/skills/name" /><button className="ghost" onClick={addSkill}>添加</button></div></div><div><h3>MCP Connections</h3>{manifest.connections.map((connection) => <span className="managed-item" key={connection.name}><span><strong>{connection.name}</strong><small>{connection.transport === "stdio" ? connection.command : connection.url}</small></span><button onClick={() => onChange({ ...manifest, connections: manifest.connections.filter((item) => item.name !== connection.name) })}><X size={13} /></button></span>)}<div className="inline-form connection-form"><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="名称" /><select value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></select><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "stdio" ? "/absolute/path/to/server" : "https://…"} /><button className="ghost" onClick={addConnection}>添加</button></div></div></div></div></div><div className="panel"><div className="toolbar"><div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件、类型或 Agent" /></div><span>{filtered.length} native assets</span></div><div className="asset-table"><div className="table-row table-head"><span>资产</span><span>Agent</span><span>类型</span><span>大小</span></div>{filtered.map((asset) => <div className="table-row" key={`${asset.agent}-${asset.path}`}><span className="asset-name"><FileCode2 size={16} /><div><strong>{asset.path.split("/").pop()}</strong><small>{shortPath(asset.path)}</small></div></span><span>{agentLabels[asset.agent]}</span><span><span className="tag">{asset.kind}</span></span><span>{formatBytes(asset.size)}</span></div>)}</div></div></div>;
}

function ContextPage({ project }: { project: string }) {
  const [agent, setAgent] = useState<AgentKind>("codex"); const [cwd, setCwd] = useState(project); const [preview, setPreview] = useState<ContextPreview>(); const [error, setError] = useState("");
  const run = async () => { try { setError(""); setPreview(await api.context(project, cwd, agent)); } catch (value) { setError(String(value)); } };
  useEffect(() => { void run(); }, [agent]);
  return <div className="context-layout"><div className="panel config-panel"><h2>模拟运行环境</h2><label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>{Object.entries(agentLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Working directory<input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label><button className="primary" onClick={run}>解析有效上下文</button><div className="separator" /><h3>可见能力</h3><Pills values={preview?.visible_skills ?? []} empty="无匹配 Skill" /><Pills values={preview?.visible_connections ?? []} empty="无 MCP Connection" /></div><div className="panel context-preview"><div className="panel-head"><div><h2>Effective context</h2><p>按公开加载规则模拟，不包含模型内部系统提示词</p></div><span className="badge">{preview?.sections.length ?? 0} sections</span></div>{error && <div className="alert">{error}</div>}{preview?.warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={15} />{warning}</div>)}<div className="timeline">{preview?.sections.map((section, index) => <article key={`${section.source}-${index}`}><span className="step">{index + 1}</span><div><header><strong>{shortPath(section.source)}</strong><span>{section.scope || "project"}</span></header><pre>{section.content}</pre></div></article>)}</div>{preview?.approved_memories.length ? <div className="memory-context"><h3>Approved memory</h3>{preview.approved_memories.map((item) => <p key={item}>{item}</p>)}</div> : null}</div></div>;
}

function Changes({ changeSet, onPlanHome, onApplied, onRejected }: { changeSet?: ChangeSet; onPlanHome: () => void; onApplied: () => void; onRejected: () => void }) {
  const [selected, setSelected] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [homeApproved, setHomeApproved] = useState(false);
  const change = changeSet?.changes[selected];
  if (!changeSet) return <Empty icon={GitCompareArrows} title="还没有待应用的变更" text="点击右上角“生成变更”，AgentHub 会比较公共资产与四个平台原生配置。" />;
  const apply = async () => { setBusy(true); try { await api.apply(changeSet, homeApproved); await onApplied(); } catch (value) { setError(String(value)); } finally { setBusy(false); } };
  return <div className="changes-layout"><div className="panel file-list"><div className="panel-head"><div><h2>ChangeSet</h2><p>{changeSet.id.slice(0, 8)} · {changeSet.changes.length} files</p></div></div>{changeSet.changes.map((file, index) => <button key={file.target} className={index === selected ? "active" : ""} onClick={() => setSelected(index)}><FileCode2 size={16} /><div><strong>{file.target.split("/").pop()}</strong><span>{shortPath(file.target)}</span></div><span className={`risk ${file.risk}`}>{file.risk}</span></button>)}<div className="home-toggle"><p>需要 OpenClaw / Hermes Home 集成？</p><button className="ghost" onClick={onPlanHome}>包含 Home 配置</button>{changeSet.requires_home_approval && <label className="home-approval"><input type="checkbox" checked={homeApproved} onChange={(event) => setHomeApproved(event.target.checked)} />我确认授权修改上方列出的 Agent Home 文件</label>}</div></div><div className="panel diff-panel">{change ? <><div className="panel-head"><div><h2>{change.target.split("/").pop()}</h2><p>{change.target} · {change.scope}</p></div><span className={`risk ${change.risk}`}>{change.risk} risk</span></div><Diff before={change.before} after={change.after} /></> : <Empty icon={Check} title="配置已同步" text="当前没有文件需要修改。" />}{error && <div className="alert">{error}</div>}<div className="apply-bar"><div><ShieldCheck size={17} /><span>应用前会再次校验所有文件哈希</span></div><div className="apply-actions"><button className="ghost" onClick={onRejected} disabled={busy}>拒绝变更</button><button className="primary" onClick={apply} disabled={busy || !changeSet.changes.length || (changeSet.requires_home_approval && !homeApproved)}>{busy ? "正在应用…" : `应用 ${changeSet.changes.length} 个变更`}</button></div></div></div></div>;
}

function MemoryInbox({ project, manifest }: { project: string; manifest: Manifest }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]); const [content, setContent] = useState(""); const [type, setType] = useState<MemoryType>("project_fact"); const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const load = async (searchQuery = query) => { try { setError(""); setRecords(searchQuery.trim() ? await api.searchMemories(project, searchQuery) : await api.memories(project)); } catch (value) { setError(String(value)); } };
  useEffect(() => { void load(); }, [project]);
  const propose = async () => { if (!content.trim()) return; try { await api.proposeMemory(project, content, type); setContent(""); await load(); } catch (value) { setError(String(value)); } };
  const review = async (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => { try { await api.reviewMemory(id, status, editedContent); await load(); } catch (value) { setError(String(value)); } };
  return <div className="memory-layout"><div className="panel compose"><span className="eyebrow">NEW MEMORY PROPOSAL</span><h2>沉淀项目事实</h2><p>只有批准后的记忆才会通过 MCP 提供给其他 Agent。</p><label>类型<select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>{["project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation","user_preference"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>内容<textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：API 层统一使用 async handler…" /></label><button className="primary" onClick={propose}>提交到收件箱</button><small>Workspace: {manifest.workspace.id.slice(0, 8)}</small></div><div className="panel inbox"><div className="panel-head"><div><h2>Memory inbox</h2><p>{query.trim() ? "仅搜索已批准记忆" : `${records.filter((r) => r.status === "pending").length} 条待审批`}</p></div><div className="memory-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder="搜索已批准记忆" /><button className="ghost" onClick={() => void load()}>搜索</button>{query && <button className="link" onClick={() => { setQuery(""); void load(""); }}>清除</button>}</div></div>{error && <div className="alert">{error}</div>}<div className="memory-list">{records.map((record) => <MemoryCard key={record.id} record={record} onReview={review} />)}{!records.length && <Empty icon={Brain} title={query.trim() ? "没有匹配的已批准记忆" : "还没有共享记忆"} text={query.trim() ? "换一个关键词，或清除搜索查看全部提议。" : "可以在左侧手动提议，或让 Agent 通过 MCP 提交。"} />}</div></div></div>;
}

function MemoryCard({ record, onReview }: { record: MemoryRecord; onReview: (id: string, status: "approved" | "rejected" | "invalidated", editedContent?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);
  return <article><div><span className={`status ${record.status}`}>{record.status}</span><span className="tag">{record.memory_type}</span><time>{new Date(record.created_at).toLocaleString()}</time></div>{editing ? <textarea className="memory-edit" value={draft} onChange={(event) => setDraft(event.target.value)} /> : <p>{record.content}</p>}{record.source_agent && <small>来源：{record.source_agent}</small>}{record.status === "pending" && <footer><button className="approve" onClick={() => onReview(record.id, "approved", editing ? draft : undefined)}><Check size={15} />{editing ? "保存并批准" : "批准"}</button><button className="ghost" onClick={() => setEditing((value) => !value)}>{editing ? <X size={14} /> : <Pencil size={14} />}{editing ? "取消编辑" : "编辑"}</button><button className="reject" onClick={() => onReview(record.id, "rejected")}>拒绝</button></footer>}{record.status === "approved" && <footer><button className="reject" onClick={() => onReview(record.id, "invalidated")}>作废</button></footer>}</article>;
}

function SettingsPage({ runtime, manifest, onManifestChange, onInstalled, onCloseBehaviorChanged }: { runtime?: RuntimeInfo; manifest: Manifest; onManifestChange: (manifest: Manifest) => void; onInstalled: () => Promise<void>; onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void> }) {
  const [error, setError] = useState("");
  const updateCloseBehavior = async (value: string) => { try { setError(""); await onCloseBehaviorChanged(value === "ask" ? undefined : value as CloseBehavior); } catch (reason) { setError(String(reason)); } };
  const setAdapterEnabled = (agent: AgentKind, enabled: boolean) => onManifestChange({ ...manifest, adapters: { ...manifest.adapters, [agent]: { enabled, generated_hashes: manifest.adapters[agent]?.generated_hashes ?? {} } } });
  return <div className="settings-grid">{error && <div className="alert">{error}</div>}<div className="panel setting-card"><div className="setting-icon"><PlugZap /></div><div><h2>AgentHub MCP</h2><p>独立 stdio 服务允许 Agent 在桌面应用关闭时读取项目资产和提交记忆提议。</p><code>{runtime?.mcp_install_path ?? "—"}</code></div><button className={runtime?.mcp_installed ? "ghost" : "primary"} onClick={onInstalled}>{runtime?.mcp_installed ? "重新安装" : "安装 MCP"}</button></div><div className="panel setting-card"><div className="setting-icon"><Activity /></div><div><h2>关闭窗口时</h2><p>隐藏后 AgentHub 会从 Dock 消失，但菜单栏图标与本地服务仍保持运行。</p></div><select className="setting-select" value={runtime?.close_behavior ?? "ask"} onChange={(event) => void updateCloseBehavior(event.target.value)}><option value="ask">下次关闭时询问</option><option value="minimize-to-tray">最小化到菜单栏</option><option value="quit">退出应用</option></select></div><div className="panel setting-card"><div className="setting-icon"><ShieldCheck /></div><div><h2>本地数据</h2><p>SQLite、备份和审计记录只保留在当前设备。</p><code>{runtime?.data_dir ?? "—"}</code></div><span className="ready"><Check size={14} />Local only</span></div><div className="panel adapter-settings"><div className="panel-head"><div><h2>平台适配器</h2><p>停用后不再为该平台生成配置；修改会随下一次 ChangeSet 保存。</p></div></div><div className="adapter-toggle-grid">{(Object.keys(agentLabels) as AgentKind[]).map((agent) => <label key={agent}><AgentLogo agent={agent} /><span><strong>{agentLabels[agent]}</strong><small>{manifest.adapters[agent]?.enabled === false ? "已停用" : "已启用"}</small></span><input type="checkbox" checked={manifest.adapters[agent]?.enabled !== false} onChange={(event) => setAdapterEnabled(agent, event.target.checked)} /></label>)}</div></div><div className="panel paths"><h2>可授权的 Agent Home</h2><p>AgentHub 默认不修改这些文件。只有 Changes 中明确包含并二次确认时才会写入。</p><dl><div><dt>OpenClaw</dt><dd>{runtime?.openclaw_config ?? "未找到 Home"}</dd></div><div><dt>Hermes</dt><dd>{runtime?.hermes_config ?? "未找到 Home"}</dd></div></dl></div></div>;
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: typeof Activity; label: string; value: string; detail: string; tone: string }) { return <div className="metric"><div className={`metric-icon ${tone}`}><Icon size={19} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function AgentLogo({ agent }: { agent: AgentKind }) { return <div className={`agent-logo ${agent}`}><span>{agent === "claude-code" ? "C" : agent === "open-claw" ? "O" : agent === "hermes" ? "H" : "◎"}</span></div>; }
function Pills({ values, empty }: { values: string[]; empty: string }) { return <div className="pills">{values.length ? values.map((value) => <span key={value}>{value}</span>) : <small>{empty}</small>}</div>; }
function Empty({ icon: Icon, title, text }: { icon: typeof Brain; title: string; text: string }) { return <div className="empty"><Icon size={28} /><h3>{title}</h3><p>{text}</p></div>; }
function Diff({ before, after }: { before: string; after: string }) { return <pre className="diff">{diffLines(before, after).map((line, index) => <div className={line.type} key={`${index}-${line.content}`}><span>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>{line.content || " "}</div>)}</pre>; }
function shortPath(path: string) { const parts = path.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path; }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function pageDescription(page: Page) { return ({ overview: "项目状态与 Agent 配置健康度", assets: "所有可追溯的项目指令、技能与连接", context: "查看指定 Agent 在当前目录实际获得的上下文", changes: "所有写入都经过 Diff、哈希校验与确认", memory: "审批 Agent 提交的共享事实与决策", settings: "本地运行时、MCP 与数据位置" } as const)[page]; }
function globalPageDescription(page: GlobalPage) { return ({ home: "跨 Agent、跨工作区的本地资产总览", workspaces: "自动发现并治理 Agent 使用过的项目", agents: "Agent 安装状态与 Home 资产只读盘点", catalog: "跨工作区检索 Instructions、Skills、MCP 与原生资产", memory: "统一审批所有工作区提交的共享记忆", activity: "本地发现、变更和记忆治理审计", settings: "扫描来源、排除列表、状态栏与本地运行时" } as const)[page]; }
function workspaceStatusLabel(status: WorkspaceSummary["status"]) { return ({ "needs-import": "待导入", healthy: "健康", attention: "需关注" } as const)[status]; }
function relativeTime(value: string) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; return `${Math.floor(seconds / 86400)} 天前`; }
