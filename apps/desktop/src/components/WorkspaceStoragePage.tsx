import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleAlert, Folder, Gauge, HardDrive, Pause, RefreshCw, Search } from "lucide-react";
import { api } from "../api";
import { currentLocale, formatDateTime, localizeMessage, tr } from "../i18n";
import { squarifyTreemap } from "../treemap";
import type { AgentKind, RefreshJobStatus, StorageBreakdown, StorageOverview, WorkspaceStorage, WorkspaceSummary } from "../types";

const agentLabels: Record<AgentKind, string> = { codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", "open-claw": "OpenClaw", hermes: "Hermes" };

export function WorkspaceStoragePage({ workspaces, job }: { workspaces: WorkspaceSummary[]; job?: RefreshJobStatus }) {
  const [overview, setOverview] = useState<StorageOverview>();
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [sort, setSort] = useState<"allocated" | "regenerable">("allocated");
  const [error, setError] = useState("");
  const active = job?.state === "queued" || job?.state === "running";

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<StorageOverview>("agentkib:storage-updated", (event) => {
        if (!disposed) setOverview(event.payload);
      });
      try {
        const cached = await api.storageOverview();
        if (!disposed) setOverview(cached);
      } catch (reason) {
        if (!disposed) setError(localizeMessage(reason));
      } finally {
        if (!disposed) setLoaded(true);
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const workspaceById = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const filtered = useMemo(() => (overview?.workspaces ?? []).filter((item) => {
    const workspace = workspaceById.get(item.workspace_id);
    const matchesQuery = `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase());
    const matchesAgent = agent === "all" || workspace?.sources.some((source) => source.agent === agent);
    return matchesQuery && matchesAgent;
  }).sort((left, right) => sort === "allocated" ? right.allocated_bytes - left.allocated_bytes : right.regenerable_bytes - left.regenerable_bytes), [agent, overview, query, sort, workspaceById]);
  const selected = filtered.find((item) => item.workspace_id === selectedId) ?? overview?.workspaces.find((item) => item.workspace_id === selectedId);
  const mapItems = selected ? compactBreakdown(selected.breakdown) : compactWorkspaces(filtered);
  const rects = squarifyTreemap(mapItems.map((item) => ({ id: item.id, value: item.value })));

  const start = async () => {
    setError("");
    try { await api.requestRefresh("storage", true); } catch (reason) { setError(localizeMessage(reason)); }
  };
  const stop = async () => { await api.cancelStorageScan(); };
  const coverage = overview?.total_workspace_count ? Math.round((overview.scanned_workspace_count / overview.total_workspace_count) * 100) : 0;
  const estimated = overview?.workspaces.some((item) => item.measurement === "logical-estimate") ?? false;
  const hasCache = Boolean(overview?.scanned_workspace_count);

  if (!loaded) return <div className="panel storage-empty"><p>{tr("common.loading")}</p></div>;

  return <div className="stack storage-page">
    {hasCache && <div className="storage-toolbar toolbar">
      <div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("storage.searchPlaceholder")} /></div>
      <select className="setting-select" value={agent} onChange={(event) => setAgent(event.target.value as typeof agent)}><option value="all">{tr("workspace.allAgents")}</option>{Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select className="setting-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="allocated">{tr("storage.sortAllocated")}</option><option value="regenerable">{tr("storage.sortRegenerable")}</option></select>
      {active ? <button className="ghost" onClick={() => void stop()}><Pause size={14} />{tr("storage.stopScan")}</button> : <button className="primary" onClick={() => void start()}><RefreshCw size={14} />{overview?.scanned_workspace_count ? tr("storage.scanAgain") : tr("storage.startScan")}</button>}
    </div>}
    {error && <div className="alert"><CircleAlert size={16} />{error}</div>}
    {hasCache && <div className="storage-summary">
      <Metric label={tr("storage.allocated")} value={formatBytes(overview?.allocated_bytes ?? 0)} meta={estimated ? tr("storage.estimated") : undefined} />
      <Metric label={tr("storage.regenerable")} value={formatBytes(overview?.regenerable_bytes ?? 0)} />
      <Metric label={tr("storage.agentAssets")} value={formatBytes(overview?.agent_asset_bytes ?? 0)} />
      <Metric label={tr("storage.coverage")} value={`${overview?.scanned_workspace_count ?? 0} / ${overview?.total_workspace_count ?? workspaces.length}`} meta={`${coverage}%`} />
    </div>}
    {active && <div className="storage-progress"><span>{job?.state === "queued" ? tr("storage.waiting") : tr("storage.scanning")}</span><progress max={job?.progress_total || 1} value={job?.progress_current || 0} /><strong>{job?.progress_current ?? 0} / {job?.progress_total ?? workspaces.length}</strong></div>}
    {!hasCache ? <div className="panel storage-empty"><HardDrive size={32} /><h2>{active ? tr("storage.scanning") : tr("storage.emptyTitle")}</h2>{!active && <p>{tr("storage.emptyText")}</p>}{overview?.workspaces.map((item) => <span className="storage-unavailable" key={item.workspace_id}><CircleAlert size={13} />{item.name} · {tr(item.error_key ?? "storage.scanUnavailable")}</span>)}{active ? <button className="ghost" onClick={() => void stop()}><Pause size={14} />{tr("storage.stopScan")}</button> : <button className="primary" onClick={() => void start()}>{tr("storage.startScan")}</button>}</div> : <div className={`storage-main${selected ? " has-inspector" : ""}`}>
      <section className="panel storage-map-panel">
        <div className="panel-head storage-map-head"><div>{selected && <button className="breadcrumb" onClick={() => setSelectedId(undefined)}>{tr("storage.allWorkspaces")}</button>}<h2>{selected?.name ?? tr("storage.mapTitle")}</h2></div><span>{overview?.last_scanned_at ? tr("storage.scannedAt", { time: formatDateTime(overview.last_scanned_at) }) : ""}</span></div>
        <div className="storage-treemap" role="list" aria-label={selected?.name ?? tr("storage.mapTitle")}>{rects.map((rect, index) => { const item = mapItems.find((value) => value.id === rect.id)!; return <button key={rect.id} role="listitem" className={`storage-tile tone-${index % 8}`} style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }} title={`${item.label} · ${formatBytes(item.value)}`} onClick={() => !selected && item.workspaceId && setSelectedId(item.workspaceId)}><strong>{item.label}</strong><span>{formatBytes(item.value)}</span></button>; })}</div>
      </section>
      <aside className="panel storage-inspector">{selected ? <WorkspaceInspector storage={selected} workspace={workspaceById.get(selected.workspace_id)} /> : <><div className="panel-head"><h2>{tr("storage.workspaceRanking")}</h2><span>{filtered.length}</span></div><div className="storage-ranking">{filtered.map((item) => <button key={item.workspace_id} onClick={() => setSelectedId(item.workspace_id)}><Folder size={15} /><span><strong>{item.name}</strong><small>{formatBytes(item.regenerable_bytes)} {tr("storage.regenerableShort")}</small></span><b>{formatBytes(item.allocated_bytes)}</b></button>)}</div></>}</aside>
    </div>}
  </div>;
}

function Metric({ label, value, meta }: { label: string; value: string; meta?: string }) { return <div><span>{label}</span><strong>{value}</strong>{meta && <small>{meta}</small>}</div>; }

function WorkspaceInspector({ storage, workspace }: { storage: WorkspaceStorage; workspace?: WorkspaceSummary }) {
  const agents = workspace?.sources.map((source) => source.agent && agentLabels[source.agent]).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" · ") || "—";
  return <><div className="panel-head"><div><h2>{storage.name}</h2><span className={`quality-badge ${storage.quality}`}>{tr(`storage.quality.${storage.quality}`)}</span></div></div><dl className="storage-facts"><div><dt>{tr("storage.allocated")}</dt><dd>{formatBytes(storage.allocated_bytes)}</dd></div><div><dt>{tr("storage.logical")}</dt><dd>{formatBytes(storage.logical_bytes)}</dd></div><div><dt>{tr("storage.files")}</dt><dd>{storage.file_count.toLocaleString(currentLocale())}</dd></div><div><dt>{tr("storage.directories")}</dt><dd>{storage.directory_count.toLocaleString(currentLocale())}</dd></div><div><dt>{tr("storage.sourceAgents")}</dt><dd>{agents}</dd></div><div><dt>{tr("storage.measurement")}</dt><dd>{tr(`storage.measurement.${storage.measurement}`)}</dd></div></dl><code className="storage-path">{storage.path}</code>{storage.error_key && <div className="storage-warning"><CircleAlert size={14} /><span>{tr(storage.error_key)}{storage.error_detail && <small>{storage.error_detail}</small>}</span></div>}<div className="storage-breakdown-list"><h3>{tr("storage.largestItems")}</h3>{storage.breakdown.slice().sort((left, right) => right.allocated_bytes - left.allocated_bytes).slice(0, 8).map((item) => <div key={item.name}><span>{item.kind === "root-files" ? tr("storage.rootFiles") : item.name}</span><strong>{formatBytes(item.allocated_bytes)}</strong></div>)}</div></>;
}

interface MapItem { id: string; label: string; value: number; workspaceId?: string }

function compactWorkspaces(values: WorkspaceStorage[]): MapItem[] {
  return compact(values.map((item) => ({ id: item.workspace_id, label: item.name, value: item.allocated_bytes, workspaceId: item.workspace_id })));
}

function compactBreakdown(values: StorageBreakdown[]): MapItem[] {
  return compact(values.map((item) => ({ id: item.relative_path || "__root_files__", label: item.kind === "root-files" ? tr("storage.rootFiles") : item.name, value: item.allocated_bytes })));
}

function compact(values: MapItem[]): MapItem[] {
  const sorted = values.filter((item) => item.value > 0).sort((left, right) => right.value - left.value);
  if (sorted.length <= 24) return sorted;
  const visible = sorted.slice(0, 23);
  const other = sorted.slice(23).reduce((sum, item) => sum + item.value, 0);
  return [...visible, { id: "__other__", label: tr("storage.other"), value: other }];
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2 }).format(amount)} ${units[index]}`;
}
