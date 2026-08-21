import { Input } from "@/components/ui/input";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArrowLeft,
  Bot,
  CircleAlert,
  FileOutput,
  GitBranch,
  MessageSquareText,
  RefreshCw,
  Search,
  UserRound,
  Wrench,
} from "lucide-react";
import { api } from "../api";
import { AgentIcon } from "./AgentIcon";
import { formatDateTime, formatRelativeTime, localizeMessage, tr } from "../i18n";
import type {
  AgentKind,
  ConversationEvent,
  ConversationIndexStatus,
  ConversationSessionSummary,
  PlannedSessionHandoff,
  WorkspaceSummary,
} from "../types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";

type SessionFilter = "current" | "archived" | "metadata" | "all";
type AgentFilter = "all" | ConversationSessionSummary["agent"];

function matchesSessionFilter(session: ConversationSessionSummary, filter: SessionFilter) {
  if (filter === "current") return !session.archived && session.availability === "readable";
  if (filter === "archived") return session.archived;
  if (filter === "metadata") return session.availability === "metadata-only";
  return true;
}

export function WorkspaceSessionsPage({
  workspace,
  enabled,
  onRuntimeChanged,
  onHandoffPlanned,
  targetAgents,
}: {
  workspace: WorkspaceSummary;
  enabled: boolean;
  onRuntimeChanged: (enabled: boolean) => Promise<void>;
  onHandoffPlanned: (handoff: PlannedSessionHandoff) => void;
  targetAgents: AgentKind[];
}) {
  const [sessions, setSessions] = useState<ConversationSessionSummary[]>([]);
  const [statuses, setStatuses] = useState<ConversationIndexStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [filter, setFilter] = useState<SessionFilter>("current");
  const [refreshing, setRefreshing] = useState(false);
  const [reading, setReading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const readSequence = useRef(0);

  const reloadCache = async () => {
    const [nextSessions, nextStatuses] = await Promise.all([
      api.workspaceSessions(workspace.id),
      api.workspaceSessionStatus(workspace.id),
    ]);
    setSessions(nextSessions);
    setStatuses(nextStatuses);
  };

  const refresh = async (force: boolean) => {
    setRefreshing(true);
    setError("");
    try {
      const nextSessions = await api.refreshWorkspaceSessions(workspace.id, force);
      setSessions(nextSessions);
      setStatuses(await api.workspaceSessionStatus(workspace.id));
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (!enabled) {
      setSessions([]);
      setStatuses([]);
      return;
    }
    setSessions([]);
    setStatuses([]);
    setSelectedId(undefined);
    setRefreshing(true);
    setError("");
    void (async () => {
      unlisten = await listen<string>("agentkib:conversations-updated", (event) => {
        if (event.payload === workspace.id) void reloadCache();
      });
      try {
        const nextSessions = await api.refreshWorkspaceSessions(workspace.id, true);
        if (disposed) return;
        const nextStatuses = await api.workspaceSessionStatus(workspace.id);
        if (disposed) return;
        setSessions(nextSessions);
        setStatuses(nextStatuses);
      } catch (reason) {
        if (!disposed) setError(localizeMessage(reason));
      } finally {
        if (!disposed) setRefreshing(false);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [workspace.id, enabled]);

  const scopedSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      if (agent !== "all" && session.agent !== agent) return false;
      if (needle && !(session.title ?? "").toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [agent, query, sessions]);
  const filterCounts = useMemo(() => Object.fromEntries(
    (["current", "archived", "metadata", "all"] as SessionFilter[])
      .map((value) => [value, scopedSessions.filter((session) => matchesSessionFilter(session, value)).length]),
  ) as Record<SessionFilter, number>, [scopedSessions]);
  const filtered = useMemo(
    () => scopedSessions.filter((session) => matchesSessionFilter(session, filter)),
    [filter, scopedSessions],
  );

  const selected = sessions.find((session) => session.id === selectedId);
  useEffect(() => {
    if (selectedId && filtered.some((session) => session.id === selectedId)) return;
    setSelectedId(filtered[0]?.id);
    setShowDetail(false);
  }, [filtered, selectedId]);

  useEffect(() => {
    const sequence = ++readSequence.current;
    setEvents([]);
    setNextCursor(undefined);
    setWarnings([]);
    setError("");
    if (!selected || selected.availability !== "readable") {
      setReading(false);
      return;
    }
    setReading(true);
    void api.sessionEvents(selected.id)
      .then((page) => {
        if (sequence !== readSequence.current) return;
        setEvents(page.events);
        setNextCursor(page.next_cursor);
        setWarnings(page.warnings);
      })
      .catch((reason) => {
        if (sequence === readSequence.current) setError(localizeMessage(reason));
      })
      .finally(() => {
        if (sequence === readSequence.current) setReading(false);
      });
  }, [selected?.id, selected?.availability]);

  const loadEarlier = async () => {
    if (!selected || !nextCursor) return;
    setLoadingEarlier(true);
    try {
      const page = await api.sessionEvents(selected.id, nextCursor);
      setEvents((current) => [...page.events, ...current]);
      setNextCursor(page.next_cursor);
      setWarnings((current) => [...new Set([...page.warnings, ...current])]);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setLoadingEarlier(false);
    }
  };

  if (!enabled) {
    return <div className="grid min-h-[180px] place-content-center justify-items-center gap-3 rounded-xl border bg-card p-6 text-center text-muted-foreground">
      <MessageSquareText size={20} />
      <span>{tr("conversations.indexDisabled")}</span>
      <Button className="primary" onClick={() => void onRuntimeChanged(true)}>{tr("conversations.enable")}</Button>
    </div>;
  }

  return <><div className={`conversation-layout${showDetail ? " show-detail" : ""}`}>
    <Card className="panel conversation-master">
      <div className="grid min-h-[50px] grid-cols-[minmax(0,1fr)_112px_34px] items-center gap-2 border-b border-border p-2 max-[640px]:grid-cols-[minmax(0,1fr)_34px]">
        <div className="search min-w-0"><Search size={15} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("conversations.searchPlaceholder")} /></div>
        <SelectControl value={agent} onChange={(event) => setAgent(event.target.value as AgentFilter)} aria-label={tr("conversations.agentFilter")}>
          <option value="all">{tr("conversations.allAgents")}</option>
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
        </SelectControl>
        <Button className="ghost icon-only" onClick={() => void refresh(true)} disabled={refreshing} aria-label={tr("conversations.refresh")} title={tr("conversations.refresh")}><RefreshCw size={15} className={refreshing ? "spin" : ""} /></Button>
      </div>
      <ToggleGroup className="flex min-h-[38px] gap-0.5 overflow-x-auto border-b border-border p-1" value={[filter]} onValueChange={(values) => { const value = values[0]; if (value) setFilter(value as SessionFilter); }} aria-label={tr("conversations.filterLabel")}>
        {(["current", "archived", "metadata", "all"] as SessionFilter[]).map((value) => <ToggleGroupItem key={value} value={value} className="min-h-7 flex-none gap-1 px-2 text-xs"><span>{tr(`conversations.filter.${value}`)}</span><Badge variant={filter === value ? "default" : "secondary"}>{filterCounts[value]}</Badge></ToggleGroupItem>)}
      </ToggleGroup>
      {statuses.length > 0 && <div className="grid gap-0.5 border-b border-border px-2.5 py-1">{statuses.map((status) => {
        const sourceSessions = sessions.filter((session) => session.agent === status.agent);
        const readable = sourceSessions.filter((session) => session.availability === "readable").length;
        return <span className="grid min-h-7 grid-cols-[18px_auto_minmax(0,1fr)] items-center gap-1.5 text-xs" key={status.agent}><AgentIcon agent={status.agent} /><strong>{status.agent === "codex" ? "Codex" : "Claude Code"}</strong><em className="overflow-hidden text-right text-muted-foreground [text-overflow:ellipsis] whitespace-nowrap">{tr("conversations.sourceCoverage", { total: status.session_count, readable })}</em></span>;
      })}</div>}
      {statuses.some((status) => status.freshness !== "fresh") && <div className="flex min-h-[34px] items-center gap-2 border-b border-border px-3 py-2 text-xs text-amber-600"><CircleAlert size={14} /><span>{tr("conversations.partialIndex")}</span></div>}
      <div className="conversation-list min-h-0 flex-1 overflow-auto">
        {filtered.map((session) => <Button variant="bare" size="content" key={session.id} className={`grid min-h-[72px] w-full grid-cols-[28px_minmax(0,1fr)] items-start gap-2 border-b border-border px-3 py-2 text-left ${selected?.id === session.id ? "bg-accent-soft" : "hover:bg-surface-hover"}`} onClick={() => { setSelectedId(session.id); setShowDetail(true); }}>
          <AgentIcon agent={session.agent} />
          <span className="min-w-0">
            <strong className="block truncate text-sm">{session.title || tr("conversations.untitled")}</strong>
            <small className="mt-1 block truncate text-xs text-muted-foreground">{session.updated_at ? formatRelativeTime(session.updated_at) : tr("conversations.unknownTime")}{session.message_count !== undefined ? ` · ${tr("conversations.messageCount", { count: session.message_count })}` : ""}</small>
            <em className="mt-1.5 flex min-h-4 flex-wrap items-center gap-1.5 text-xs text-muted-foreground not-italic">{session.git_branch && <span className="inline-flex items-center gap-1"><GitBranch size={11} />{session.git_branch}</span>}{session.archived && <span className="inline-flex items-center gap-1"><Archive size={11} />{tr("conversations.archived")}</span>}{session.sidechain && <span>{tr("conversations.sidechain")}</span>}{session.availability === "metadata-only" && <span>{tr("conversations.metadataOnly")}</span>}</em>
          </span>
        </Button>)}
        {!filtered.length && <div className="conversation-empty"><MessageSquareText size={21} /><strong>{tr(filter === "current" && filterCounts.metadata > 0 ? "conversations.metadataAvailable" : "conversations.empty", { count: filterCounts.metadata })}</strong>{filter === "current" && filterCounts.metadata > 0 && <Button className="ghost" onClick={() => setFilter("metadata")}>{tr("conversations.viewMetadata")}</Button>}</div>}
      </div>
    </Card>
    <Card className="conversation-detail grid min-w-0 grid-rows-[auto_auto_minmax(0,1fr)]">
      <header className="flex min-h-[61px] items-center border-b border-border px-4 py-2.5">
        <Button className="ghost conversation-back" onClick={() => setShowDetail(false)}><ArrowLeft size={15} />{tr("conversations.back")}</Button>
        {selected ? <><div className="min-w-0"><span className="flex min-w-0 items-center gap-2"><AgentIcon agent={selected.agent} /><strong className="truncate text-base">{selected.title || tr("conversations.untitled")}</strong></span><small className="mt-1 block truncate text-xs text-muted-foreground">{selected.updated_at ? formatDateTime(selected.updated_at) : tr("conversations.unknownTime")}{selected.git_branch ? ` · ${selected.git_branch}` : ""}</small></div>{selected.availability === "readable" && events.length > 0 && <Button className="ghost ml-auto shrink-0" onClick={() => setShowHandoff(true)}><FileOutput size={14} />{tr("handoff.create")}</Button>}</> : <strong>{tr("conversations.selectSession")}</strong>}
      </header>
      {error && <div className="alert"><CircleAlert size={15} />{error}</div>}
      {warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={14} />{tr("conversations.damagedLines")}</div>)}
      {!selected && <div className="conversation-empty"><MessageSquareText size={26} /><strong>{tr("conversations.selectSession")}</strong></div>}
      {selected?.availability === "metadata-only" && <div className="conversation-empty"><Archive size={24} /><strong>{tr("conversations.metadataOnly")}</strong><span>{tr("conversations.metadataOnlyDetail")}</span></div>}
      {selected?.availability === "readable" && <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4">
        {nextCursor && <Button className="ghost self-center" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{tr(loadingEarlier ? "common.loading" : "conversations.loadEarlier")}</Button>}
        {reading && <div className="grid min-h-[72px] place-content-center justify-items-center gap-2 text-sm text-muted-foreground"><RefreshCw className="spin" size={18} /><span>{tr("conversations.reading")}</span></div>}
        {!reading && !events.length && !error && <div className="grid min-h-[180px] place-content-center justify-items-center gap-2 text-center text-muted-foreground"><MessageSquareText size={24} /><strong className="text-sm text-foreground">{tr("conversations.noReadableEvents")}</strong></div>}
        {events.map((event) => <ConversationEventRow key={event.id} event={event} />)}
      </div>}
    </Card>
  </div>{showHandoff && selected && <SessionHandoffDialog workspace={workspace} session={selected} targetAgents={targetAgents} onClose={() => setShowHandoff(false)} onPlanned={(changeSet) => { setShowHandoff(false); onHandoffPlanned(changeSet); }} />}</>;
}

function ConversationEventRow({ event }: { event: ConversationEvent }) {
  if (event.kind === "tool-summary") {
    return <div className="flex min-h-[34px] items-center gap-2 rounded-lg border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"><Wrench size={14} /><strong className="text-foreground">{event.tool_name || tr("conversations.tool")}</strong><span>{tr(`conversations.toolStatus.${event.tool_status ?? "unknown"}`)}</span>{(event.timestamp || event.duration_ms !== undefined) && <time className="ml-auto">{event.timestamp ? formatDateTime(event.timestamp) : ""}{event.timestamp && event.duration_ms !== undefined ? " · " : ""}{event.duration_ms !== undefined ? formatDuration(event.duration_ms) : ""}</time>}</div>;
  }
  const isUser = event.kind === "user-message";
  return <article className={`max-w-[min(760px,88%)] self-start rounded-xl border px-3 py-2.5 ${isUser ? "user ml-auto bg-accent-soft" : "bg-muted"}`}>
    <header className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">{isUser ? <UserRound size={14} /> : <Bot size={14} />}<strong className="text-foreground">{tr(isUser ? "conversations.you" : "conversations.agent")}</strong>{event.timestamp && <time className="ml-auto">{formatDateTime(event.timestamp)}</time>}</header>
    <div className="selectable text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{event.content}</div>
    {(event.attachment_count > 0 || event.truncated) && <footer className="mt-2 flex gap-2 text-xs text-muted-foreground">{event.attachment_count > 0 && <span>{tr("conversations.attachments", { count: event.attachment_count })}</span>}{event.truncated && <span>{tr("conversations.contentTruncated")}</span>}</footer>}
  </article>;
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
