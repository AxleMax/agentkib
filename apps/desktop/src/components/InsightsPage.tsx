import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity, Award, Brain, CalendarCheck2, CalendarDays, Check, ChevronRight, CircleAlert, Flame, FolderGit2, GitCommitHorizontal, LockKeyhole, MessageSquareText, Moon, Network, PlugZap, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Workflow, X } from "lucide-react";
import { api } from "../api";
import { achievementReached, buildAchievementWallItems, selectDefaultTrackMilestone, type AchievementCategory, type AchievementTrack, type AchievementWallItem } from "../achievements";
import { formatCompactNumber, formatDateTime, formatRelativeTime, localizeMessage, tr } from "../i18n";
import { buildHeatmapMonthMarkers } from "../insights";
import type { Achievement, AgentKind, AgentUsageBreakdown, HeatmapPoint, InsightsQuery, InsightsStatus, InsightsSummary, ModelUsageBreakdown, RefreshJobStatus, RepositoryCommitBreakdown, WorkspaceSummary, WorkspaceUsageBreakdown } from "../types";
import { AgentIcon } from "./AgentIcon";

type HeatmapMetric = "tokens" | "my_commits" | "all_commits" | "attributed_commits" | "sessions";
export type InsightsSection = "overview" | "tokens" | "commits" | "milestones" | "sources";

const agentLabels: Record<AgentKind, string> = { codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", "open-claw": "OpenClaw", hermes: "Hermes", "deepseek-harness": "DeepSeek Harness" };

export function InsightsPage({ section, workspaces, onSummary }: { section: InsightsSection; workspaces: WorkspaceSummary[]; onSummary: (summary: InsightsSummary) => void }) {
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
      if (!pendingRefresh.current) return;
      pendingRefresh.current = false;
      void loadInsights();
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
      {busy && <span className="badge">{tr("tray.refreshInsights")}</span>}
      <button className="ghost icon-only" aria-label={tr("insights.refresh")} title={tr("insights.refresh")} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
    </div>
    {!summary && <div className="panel"><Empty icon={Award} title={tr("insights.preparing")} text={tr("insights.preparingText")} /></div>}
    {summary && section === "overview" && <>
      <div className="achievement-metrics">
        <AchievementMetric icon={Sparkles} label={tr("insights.totalToken")} value={formatCompact(summary.total_tokens)} detail={summary.coverage_from ? `${summary.coverage_from} — ${summary.coverage_to}` : ""} />
        <AchievementMetric icon={GitCommitHorizontal} label={tr("insights.myCommits")} value={formatCompact(summary.my_commits)} detail={tr("insights.allActivity", { count: formatCompact(summary.all_commits) })} />
        <AchievementMetric icon={CalendarDays} label={tr("insights.activeDays")} value={`${summary.active_days} ${tr("common.days")}`} detail={tr("insights.recordedSessions", { count: formatCompact(summary.session_count) })} />
        <AchievementMetric icon={Flame} label={tr("insights.currentStreak")} value={`${summary.current_streak} ${tr("common.days")}`} detail={tr("insights.longestStreak", { count: summary.longest_streak })} />
      </div>
      <div className="panel heatmap-panel"><div className="panel-head"><h2>{tr("insights.heatmap")}</h2></div><div className="heatmap-tabs">{(Object.keys(metricLabels) as HeatmapMetric[]).map((value) => <button key={value} className={metric === value ? "active" : ""} onClick={() => setMetric(value)}>{metricLabels[value]}</button>)}</div><div className="heatmap-scroll"><HeatmapMonths points={points} padding={padding} /><div className="heatmap-grid">{Array.from({ length: padding }, (_, index) => <span className="heatmap-cell empty-cell" key={`padding-${index}`} />)}{points.map((point) => { const value = point[metric]; const level = value ? Math.max(1, Math.ceil(value / max * 4)) : 0; return <span key={point.date} className={`heatmap-cell level-${level}`} title={`${point.date} · ${metricLabels[metric]} ${formatCompact(value)}`} />; })}</div></div><div className="heatmap-legend"><span>{tr("insights.less")}</span>{[0,1,2,3,4].map((level) => <i key={level} className={`heatmap-cell level-${level}`} />)}<span>{tr("insights.more")}</span></div></div>
    </>}
    {summary && section === "tokens" && <><div className="panel"><div className="panel-head"><h2>{tr("insights.agentUsage")}</h2></div><div className="agent-usage-list">{agents.map((value) => <div key={value.agent}><AgentIcon agent={value.agent} /><span><strong>{agentLabels[value.agent]}</strong><small>{value.session_count} {tr("common.sessions")}</small></span><div><strong>{formatCompact(value.total_tokens)}</strong><small>Token</small></div></div>)}{!agents.length && <p>{tr("insights.noToken")}</p>}</div></div><div className="two-col insight-columns"><BreakdownPanel title={tr("insights.modelUsage")} values={models.map((value) => ({ key: value.model, label: value.model, detail: `${value.session_count} ${tr("common.sessions")}`, value: value.total_tokens }))} /><BreakdownPanel title={tr("insights.workspaceUsage")} values={workspaceUsage.map((value) => ({ key: value.workspace_id ?? "unlinked", label: value.name, detail: `${value.session_count} ${tr("common.sessions")}`, value: value.total_tokens }))} /></div></>}
    {summary && section === "commits" && <div className="panel"><div className="panel-head"><h2>{tr("insights.repositoryCommits")}</h2></div><div className="repository-usage-list">{repositories.slice(0, 20).map((value) => <div key={value.repository_group_id}><span><strong>{value.name}</strong><small>{tr("insights.repositoryDetail", { all: value.all_commits, attributed: value.attributed_commits })}</small></span><strong>{value.my_commits}</strong></div>)}{!repositories.length && <p>{tr("insights.noCommits")}</p>}</div></div>}
    {section === "milestones" && <AchievementWall achievements={achievements} />}
    {section === "sources" && <div className="panel provider-panel"><div className="panel-head"><h2>{tr("insights.providers")}</h2><span className="badge">{status?.refreshed_at ? tr("home.updated", { time: formatRelativeTime(status.refreshed_at) }) : tr("insights.notRefreshed")}</span></div><div className="provider-grid">{status?.providers.map((provider) => <ProviderRow key={provider.agent} provider={provider} />)}</div></div>}
  </div>;
}

function HeatmapMonths({ points, padding }: { points: HeatmapPoint[]; padding: number }) {
  const columns = Math.max(1, Math.ceil((padding + points.length) / 7));
  const markers = buildHeatmapMonthMarkers(points, padding, document.documentElement.lang || "en-US");
  return <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${columns}, 11px)` }}>{markers.map((marker) => <span key={marker.key} style={{ gridColumn: marker.column, gridRow: 1 }}>{marker.label}</span>)}</div>;
}

const milestoneIcons: Record<AchievementCategory, typeof Activity> = { token: Sparkles, session: MessageSquareText, commit: GitCommitHorizontal, "active-days": CalendarCheck2, streak: Flame, workspaces: FolderGit2, agents: Network };
const specialAchievementIcons: Record<string, typeof Activity> = { "special-first-changeset": ShieldCheck, "special-first-memory": Brain, "special-shared-workspace": Network, "special-exact-attribution": GitCommitHorizontal, "special-remote-handshake": PlugZap, "special-night-owl": Moon, "special-comeback": RotateCcw, "special-same-day-delivery": Workflow };

function AchievementWall({ achievements }: { achievements: Achievement[] }) {
  const [selected, setSelected] = useState<AchievementWallItem>();
  if (!achievements.length) return <div className="panel"><Empty icon={Award} title={tr("insights.preparing")} /></div>;
  const items = buildAchievementWallItems(achievements);
  const tracks = items.filter((item) => item.kind === "track");
  const specials = items.filter((item) => item.kind === "special");
  const completedMilestones = tracks.reduce((count, item) => count + item.track.completed, 0);
  const milestoneCount = tracks.reduce((count, item) => count + item.track.milestones.length, 0);
  const completedSpecials = specials.filter((item) => item.unlocked).length;
  return <section className="panel achievement-wall-panel"><div className="panel-head"><h2>{tr("insights.milestones")}</h2><div className="achievement-wall-counts"><span className="badge">{tr("achievementWall.milestones", { completed: completedMilestones, total: milestoneCount })}</span><span className="badge">{tr("achievementWall.specials", { completed: completedSpecials, total: specials.length })}</span></div></div><div className="achievement-wall-grid">{items.map((item) => <AchievementWallCard key={item.id} item={item} onOpen={() => setSelected(item)} />)}</div>{selected && <AchievementDetailDialog key={selected.id} item={selected} onClose={() => setSelected(undefined)} />}</section>;
}

function AchievementWallCard({ item, onOpen }: { item: AchievementWallItem; onOpen: () => void }) {
  if (item.kind === "track") {
    const Icon = milestoneIcons[item.track.category];
    const title = tr(`achievements.${achievementTranslationKey(item.cover.code)}.title`);
    return <button className={`achievement-wall-card track${item.unlocked ? " unlocked" : " locked"}`} onClick={onOpen} aria-label={tr("achievementWall.openTrack", { category: tr(`milestones.category.${item.track.category}`) })}><span className="achievement-wall-icon"><Icon size={20} /></span><span className="achievement-wall-kind">{tr(`milestones.category.${item.track.category}`)}</span><strong>{title}</strong><small>{formatMilestoneValue(item.track.category, item.cover.threshold)}</small><span className="achievement-wall-footer"><span>{tr("milestones.completed", { completed: item.track.completed, total: item.track.milestones.length })}</span><ChevronRight size={15} /></span></button>;
  }
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const Icon = hidden ? LockKeyhole : specialAchievementIcons[achievement.code] ?? Award;
  const title = hidden ? tr("special.mystery") : tr(`achievements.${achievementTranslationKey(achievement.code)}.title`);
  const status = achievement.unlocked_at ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) }) : unlocked ? tr("special.reachedDateUnknown") : tr("milestones.locked");
  return <button className={`achievement-wall-card special${unlocked ? " unlocked" : " locked"}${hidden ? " secret" : ""}`} onClick={onOpen} aria-label={tr("achievementWall.openSpecial", { title })}><span className="achievement-wall-icon"><Icon size={20} /></span><span className="achievement-wall-kind">{tr("special.title")}</span><strong>{title}</strong><small>{status}</small><span className="achievement-wall-footer"><span>{unlocked ? tr("achievementWall.unlocked") : tr("milestones.locked")}</span><ChevronRight size={15} /></span></button>;
}

function AchievementDetailDialog({ item, onClose }: { item: AchievementWallItem; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; previouslyFocused?.focus(); };
  }, [onClose]);
  const title = item.kind === "track" ? tr(`milestones.category.${item.track.category}`) : item.special.secret && !item.special.unlocked ? tr("special.mystery") : tr(`achievements.${achievementTranslationKey(item.special.achievement.code)}.title`);
  return <div className="achievement-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="achievement-dialog" role="dialog" aria-modal="true" aria-labelledby="achievement-dialog-title" ref={dialogRef}><header><div><span>{item.kind === "track" ? tr("achievementWall.track") : tr("special.title")}</span><h2 id="achievement-dialog-title">{title}</h2></div><button className="ghost icon-only" onClick={onClose} aria-label={tr("common.close")}><X size={17} /></button></header>{item.kind === "track" ? <AchievementTrackDetail track={item.track} /> : <SpecialAchievementDetail item={item} />}</div></div>;
}

function AchievementTrackDetail({ track }: { track: AchievementTrack }) {
  const [selected, setSelected] = useState(() => selectDefaultTrackMilestone(track));
  const progressPercent = Math.round(track.progressRatio * 100);
  const selectedReached = achievementReached(selected);
  const selectedCurrent = track.next?.code === selected.code;
  return <div className="achievement-dialog-content"><div className="achievement-track-summary"><span><small>{tr("achievementWall.currentValue")}</small><strong>{formatMilestoneValue(track.category, track.progress)}</strong></span><span><small>{tr("achievementWall.completedStages")}</small><strong>{track.completed} / {track.milestones.length}</strong></span><span><small>{tr("achievementWall.nextTarget")}</small><strong>{track.next ? formatMilestoneValue(track.category, track.next.threshold) : tr("milestones.highest")}</strong></span></div><div className="milestone-rail-scroll dialog-rail"><div className="milestone-rail" style={{ gridTemplateColumns: `repeat(${Math.max(1, track.milestones.length)}, minmax(112px, 1fr))` }}><div className="milestone-progress" role="progressbar" aria-label={tr("milestones.progress", { category: tr(`milestones.category.${track.category}`) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><i style={{ width: `${progressPercent}%` }} /></div>{track.milestones.map((milestone) => { const reached = achievementReached(milestone); const current = track.next?.code === milestone.code; return <button className={`milestone-node${reached ? " reached" : ""}${current ? " current" : ""}${selected.code === milestone.code ? " selected" : ""}`} key={milestone.code} onClick={() => setSelected(milestone)} aria-pressed={selected.code === milestone.code}><span>{reached ? <Check size={13} /> : ""}</span><strong>{formatMilestoneValue(track.category, milestone.threshold)}</strong><small>{tr(`achievements.${achievementTranslationKey(milestone.code)}.title`)}</small></button>; })}</div></div><section className="achievement-stage-detail"><div><span className={selectedReached ? "reached" : selectedCurrent ? "current" : "locked"}>{selectedReached ? <Check size={14} /> : <LockKeyhole size={13} />}</span><div><small>{tr("achievementWall.stageDetail")}</small><h3>{tr(`achievements.${achievementTranslationKey(selected.code)}.title`)}</h3></div></div><strong>{formatMilestoneValue(track.category, selected.threshold)}</strong><p>{selected.unlocked_at ? tr("insights.unlockedAt", { date: formatDateTime(selected.unlocked_at) }) : selectedReached ? tr("special.reachedDateUnknown") : selectedCurrent ? tr("milestones.currentProgress", { progress: formatMilestoneValue(track.category, track.progress) }) : tr("milestones.locked")}</p></section></div>;
}

function SpecialAchievementDetail({ item }: { item: Extract<AchievementWallItem, { kind: "special" }> }) {
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const key = achievementTranslationKey(achievement.code);
  const Icon = hidden ? LockKeyhole : specialAchievementIcons[achievement.code] ?? Award;
  const title = hidden ? tr("special.mystery") : tr(`achievements.${key}.title`);
  const status = achievement.unlocked_at ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) }) : unlocked ? tr("special.reachedDateUnknown") : tr("milestones.locked");
  return <div className="achievement-dialog-content special-detail"><span className={`special-detail-icon${unlocked ? " unlocked" : ""}`}><Icon size={28} /></span><h3>{title}</h3><p>{hidden ? tr("achievementWall.secretCondition") : tr(`achievements.${key}.description`)}</p><span className="badge">{status}</span></div>;
}

function ProviderRow({ provider }: { provider: NonNullable<InsightsStatus["providers"]>[number] }) {
  const summary = provider.coverage_from ? `${provider.coverage_from} — ${provider.coverage_to}` : provider.error_key ? localizeMessage({ key: provider.error_key, params: provider.error_params }) : provider.error ? tr("insights.providerUnavailable") : provider.available ? undefined : tr("insights.noData");
  return <div className="provider-row"><AgentIcon agent={provider.agent} /><span><strong>{agentLabels[provider.agent]}</strong>{summary && <small>{summary}</small>}{provider.error && <details><summary>{tr("common.details")}</summary><pre>{provider.error}</pre></details>}</span></div>;
}

function AchievementMetric({ icon: Icon, label, value, detail }: { icon: ComponentType<{ size?: number }>; label: string; value: string; detail: string }) { return <div className="panel achievement-metric"><Icon size={18} /><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function BreakdownPanel({ title, values }: { title: string; values: Array<{ key: string; label: string; detail: string; value: number }> }) { return <div className="panel"><div className="panel-head"><h2>{title}</h2></div><div className="repository-usage-list">{values.slice(0, 10).map((item) => <div key={item.key}><span><strong>{metadataLabel(item.label)}</strong><small>{item.detail}</small></span><strong>{formatCompact(item.value)}</strong></div>)}{!values.length && <p>{tr("insights.noRecords")}</p>}</div></div>; }
function Empty({ icon: Icon, title, text }: { icon: ComponentType<{ size?: number }>; title: string; text?: string }) { return <div className="empty compact"><Icon size={28} /><h3>{title}</h3>{text && <p>{text}</p>}</div>; }
function formatMilestoneValue(category: AchievementCategory, value: number) { return tr(`milestones.value.${category}`, { value: formatCompact(value) }); }
function formatCompact(value: number) { return formatCompactNumber(value); }
function localDate(value: Date) { const year = value.getFullYear(); const month = String(value.getMonth() + 1).padStart(2, "0"); const day = String(value.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓库 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
function achievementTranslationKey(code: string) {
  return ({
    "token-100000": "token_100k", "token-1000000": "token_1m", "token-10000000": "token_10m", "token-100000000": "token_100m", "token-1000000000": "token_1b", "token-10000000000": "token_10b", "token-100000000000": "token_100b", "token-1000000000000": "token_1t",
    "session-10": "session_10", "session-50": "session_50", "session-100": "session_100", "session-500": "session_500", "session-1000": "session_1000", "session-5000": "session_5000", "session-10000": "session_10000",
    "commit-1": "commit_1", "commit-10": "commit_10", "commit-100": "commit_100", "commit-1000": "commit_1000", "commit-5000": "commit_5000", "commit-10000": "commit_10000",
    "active-days-7": "active_days_7", "active-days-30": "active_days_30", "active-days-100": "active_days_100", "active-days-365": "active_days_365", "active-days-1000": "active_days_1000",
    "streak-3": "streak_3", "streak-7": "streak_7", "streak-14": "streak_14", "streak-30": "streak_30", "streak-60": "streak_60", "streak-100": "streak_100", "streak-180": "streak_180", "streak-365": "streak_365",
    "workspaces-1": "workspaces_1", "workspaces-5": "workspaces_5", "workspaces-10": "workspaces_10", "workspaces-25": "workspaces_25", "workspaces-50": "workspaces_50", "workspaces-100": "workspaces_100",
    "agents-1": "agents_1", "agents-2": "agents_2", "agents-3": "agents_3", "agents-4": "agents_4", "agents-5": "agents_5",
    "special-first-changeset": "special_first_changeset", "special-first-memory": "special_first_memory", "special-shared-workspace": "special_shared_workspace", "special-exact-attribution": "special_exact_attribution", "special-remote-handshake": "special_remote_handshake", "special-night-owl": "special_night_owl", "special-comeback": "special_comeback", "special-same-day-delivery": "special_same_day_delivery",
  } as Record<string, string>)[code] ?? code;
}
