import {
  Award,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FolderGit2,
  History,
  Library,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCompactNumber, formatDateTime, formatRelativeTime, tr } from "@/core/i18n";
import type {
  ActivityRecord,
  AgentInstallation,
  AgentKind,
  ContextDoctorSummary,
  DiscoveryReport,
  InsightsSummary,
  MemoryRecord,
  WorkspaceSummary,
} from "@/core/types";

export type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";

const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "deepseek-harness": "DeepSeek Harness",
};

export function GlobalHome({
  workspaces,
  doctorSummaries,
  installations,
  memories,
  discovery,
  activity,
  insights,
  uniqueAssetCount,
  assetCounts,
  onShowInsights,
  onShowWorkspaces,
  onShowAgents,
  onOpen,
  onOpenDoctor,
  onOpenAssets,
  onAddRoot,
}: {
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  installations: AgentInstallation[];
  memories: MemoryRecord[];
  discovery?: DiscoveryReport;
  activity: ActivityRecord[];
  insights?: InsightsSummary;
  uniqueAssetCount: number;
  assetCounts: Map<string, number>;
  onShowInsights: () => void;
  onShowWorkspaces: () => void;
  onShowAgents: () => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenAssets: (section: AssetSection) => void;
  onAddRoot: () => Promise<void>;
}) {
  const attention = workspaces.filter(
    (item) =>
      item.status === "attention" ||
      (doctorSummaries[item.id]?.error_count ?? 0) +
        (doctorSummaries[item.id]?.warning_count ?? 0) >
        0,
  );
  const pending = memories.filter((item) => item.status === "pending").length;
  const doctorIssueCount = Object.values(doctorSummaries).reduce(
    (total, summary) => total + summary.error_count + summary.warning_count,
    0,
  );
  const legacyAttentionCount = attention.filter(
    (workspace) => !doctorSummaries[workspace.id],
  ).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const importantActions = new Set([
    "changeset.apply",
    "changeset.apply_failed",
    "memory.propose",
    "memory.review",
    "workspace.exclude",
  ]);
  const importantActivity = activity
    .filter((item) => importantActions.has(item.action))
    .slice(0, 5);
  const installedAgentCount = installations.filter((item) => item.installed).length;
  const metrics = [
    {
      label: tr("home.workspaceMetric"),
      value: workspaces.length,
      icon: FolderGit2,
      onClick: onShowWorkspaces,
    },
    {
      label: tr("home.assetMetric"),
      value: uniqueAssetCount,
      icon: Library,
      onClick: () => onOpenAssets("instructions"),
    },
    {
      label: tr("home.installedAgents"),
      value: installedAgentCount,
      icon: Bot,
      onClick: onShowAgents,
    },
    {
      label: tr("home.pendingMemory"),
      value: pending,
      icon: Brain,
      onClick: () => onOpenAssets("memory"),
    },
  ];
  const insightCard = insights && (
    <Button
      variant="bare"
      size="content"
      className="group relative block w-full overflow-hidden rounded-2xl bg-foreground p-5 text-left text-background shadow-sm transition-transform hover:-translate-y-0.5 hover:bg-foreground active:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onShowInsights}
    >
      <div className="absolute -right-8 -top-10 size-32 rounded-full border-[18px] border-background/10" />
      <div className="relative flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-background/10">
          <Award size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold tracking-[.14em] text-background/60">
            {tr("home.journey")}
          </span>
          {insights.total_tokens || insights.my_commits ? (
            <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
              <strong>{formatCompactNumber(insights.total_tokens)} Token</strong>
              <strong>
                {insights.my_commits} {tr("insights.myCommits")}
              </strong>
            </span>
          ) : (
            <strong className="mt-2 block text-sm">{tr("home.insightsEmpty")}</strong>
          )}
          <span className="mt-2 block text-xs leading-5 text-background/65">
            {tr("home.streak", {
              active: insights.active_days,
              current: insights.current_streak,
              longest: insights.longest_streak,
            })}
          </span>
        </span>
        <ChevronRight
          className="mt-1 shrink-0 text-background/70 transition-transform group-hover:translate-x-0.5"
          size={17}
        />
      </div>
    </Button>
  );
  return (
    <div className="grid gap-6">
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-card px-6 py-6 shadow-[0_18px_50px_-34px_rgba(15,23,42,.4)] md:px-7 md:py-7">
        <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full border-[32px] border-primary/[0.035]" />
        <div className="relative grid gap-6">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map(({ label, value, icon: Icon, onClick }) => (
              <Button
                variant="bare"
                size="content"
                className="group flex min-w-0 items-start gap-3 rounded-xl border border-border-subtle bg-muted/20 p-4 text-left transition-[transform,border-color,background-color] hover:-translate-y-0.5 hover:border-border hover:bg-muted/45"
                key={label}
                onClick={onClick}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-muted-foreground">
                    {label}
                  </span>
                  <strong className="mt-1 block text-xl font-semibold tabular-nums tracking-[-.03em] text-foreground">
                    {value}
                  </strong>
                </span>
              </Button>
            ))}
          </div>
        </div>
      </section>
      {issueCount > 0 ? (
        <Card className="overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/[0.045] shadow-none">
          <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 px-5 py-3.5">
            <span className="flex items-center gap-2 text-sm">
              <CircleAlert size={17} className="text-amber-600" />
              <strong>{tr("home.needsAttention")}</strong>
            </span>
            <Badge variant="secondary" className="bg-background/70 tabular-nums">
              {issueCount}
            </Badge>
          </div>
          <div className="grid divide-y divide-amber-500/15">
            {attention.slice(0, 4).map((workspace) => {
              const doctorCount =
                (doctorSummaries[workspace.id]?.error_count ?? 0) +
                (doctorSummaries[workspace.id]?.warning_count ?? 0);
              return (
                <Button
                  variant="bare"
                  size="content"
                  className="flex items-center gap-3 px-5 py-3.5 text-left hover:bg-amber-500/[0.08]"
                  key={workspace.id}
                  onClick={() => void onOpenDoctor(workspace)}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700">
                    <ShieldCheck size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">{workspace.name}</strong>
                    <small className="mt-0.5 block text-xs text-muted-foreground">
                      {tr("home.workspaceWarnings", {
                        count: doctorCount || workspace.warning_count,
                      })}
                    </small>
                  </span>
                  <ChevronRight size={15} className="text-muted-foreground" />
                </Button>
              );
            })}
            {pending > 0 && (
              <Button
                variant="bare"
                size="content"
                className="flex items-center gap-3 px-5 py-3.5 text-left hover:bg-amber-500/[0.08]"
                onClick={() => onOpenAssets("memory")}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700">
                  <Brain size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">{tr("home.pendingMemory")}</strong>
                  <small className="mt-0.5 block text-xs text-muted-foreground">
                    {tr("home.pendingMemoryDetail", { count: pending })}
                  </small>
                </span>
                <ChevronRight size={15} className="text-muted-foreground" />
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.045] px-5 py-3.5 text-sm">
          <span className="grid size-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700">
            <Check size={17} />
          </span>
          <span>
            <strong className="block">{tr("home.allClear")}</strong>
            <small className="mt-0.5 block text-xs text-muted-foreground">
              {tr("home.allClearDescription")}
            </small>
          </span>
        </div>
      )}
      {!workspaces.length ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.45fr)]">
          <Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-2xl border-dashed bg-card p-8 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-primary/8 text-primary">
              <FolderGit2 size={24} />
            </span>
            <h2 className="text-lg font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">
              {tr("home.emptyText")}
            </p>
            <Button onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</Button>
          </Card>
          {insightCard}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
          <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
              <div>
                <h2 className="text-base font-semibold tracking-[-.02em]">
                  {tr("home.recentWorkspaces")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">{tr("home.workspaceSources")}</p>
              </div>
              <Badge variant="outline" className="shrink-0">
                {discovery
                  ? tr("home.updated", { time: relativeTime(discovery.finished_at) })
                  : tr("home.discovering")}
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid">
                {workspaces.slice(0, 5).map((workspace) => (
                  <WorkspaceRow
                    key={workspace.id}
                    workspace={workspace}
                    assetCount={assetCounts.get(workspace.id)}
                    onOpen={onOpen}
                  />
                ))}
              </div>
              <Button
                variant="link"
                className="mx-5 my-3 px-0 text-xs text-muted-foreground"
                onClick={onShowWorkspaces}
              >
                {tr("nav.workspaces")}
                <ChevronRight size={13} />
              </Button>
            </CardContent>
          </Card>
          <div className="grid content-start gap-4">
            {insightCard}
            {importantActivity.length > 0 ? (
              <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
                <CardHeader className="border-b border-border-subtle px-5 py-4">
                  <h2 className="text-base font-semibold tracking-[-.02em]">
                    {tr("home.recentActivity")}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr("home.activityDescription")}
                  </p>
                </CardHeader>
                <CardContent className="grid gap-2 p-3">
                  {importantActivity.map((item) => (
                    <ActivityRow key={item.id} record={item} />
                  ))}
                </CardContent>
              </Card>
            ) : (
              <Card className="rounded-2xl border-dashed bg-card p-5">
                <div className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <History size={15} />
                  </span>
                  <span>
                    <strong className="block text-sm">{tr("home.noImportantActivity")}</strong>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {tr("home.noImportantActivityText")}
                    </p>
                  </span>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({
  workspace,
  assetCount,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const sourceAgents = workspace.sources
    .map((source) => source.agent)
    .filter((value): value is AgentKind => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const agents =
    sourceAgents.map((value) => agentLabels[value]).join(" · ") ||
    (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return (
    <Button
      variant="bare"
      size="content"
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/40"
      onClick={() => void onOpen(workspace)}
    >
      <div className="grid size-9 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:bg-muted">
        <FolderGit2 size={18} />
      </div>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold">{workspace.name}</strong>
        <small className="block truncate text-xs text-muted-foreground" title={workspace.path}>
          {workspace.path}
        </small>
        <span className="block truncate text-xs text-muted-foreground">
          {agents} · {tr("workspace.assetCount", { count })} ·{" "}
          {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}
        </span>
      </div>
      {workspace.status === "attention" && (
        <span className="text-xs font-medium text-amber-700">
          {workspaceStatusLabel("attention")}
        </span>
      )}
      <ChevronRight className="text-muted-foreground" size={15} />
    </Button>
  );
}

function ActivityRow({ record }: { record: ActivityRecord }) {
  const key = `activity.action.${record.action}`;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
      <div>
        <strong>{tr(key, { defaultValue: record.action })}</strong>
        <small title={record.detail}>{record.detail}</small>
      </div>
      <time>{formatDateTime(record.created_at)}</time>
    </div>
  );
}

function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}

function relativeTime(value: string) {
  return formatRelativeTime(value);
}
