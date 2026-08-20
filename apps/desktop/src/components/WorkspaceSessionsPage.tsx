import { Input } from "@/components/ui/input";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
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
    return <div className="conversation-disabled compact-state">
      <MessageSquareText size={20} />
      <span>{tr("conversations.indexDisabled")}</span>
      <Button className="primary" onClick={() => void onRuntimeChanged(true)}>{tr("conversations.enable")}</Button>
    </div>;
  }

  return <><div className={`conversation-layout${showDetail ? " show-detail" : ""}`}>
    <aside className="panel conversation-master">
      <div className="conversation-toolbar">
        <div className="search"><Search size={15} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("conversations.searchPlaceholder")} /></div>
        <SelectControl value={agent} onChange={(event) => setAgent(event.target.value as AgentFilter)} aria-label={tr("conversations.agentFilter")}>
          <option value="all">{tr("conversations.allAgents")}</option>
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
        </SelectControl>
        <Button className="ghost icon-only" onClick={() => void refresh(true)} disabled={refreshing} aria-label={tr("conversations.refresh")} title={tr("conversations.refresh")}><RefreshCw size={15} className={refreshing ? "spin" : ""} /></Button>
      </div>
      <ToggleGroup className="conversation-filters" value={[filter]} onValueChange={(values) => { const value = values[0]; if (value) setFilter(value as SessionFilter); }} aria-label={tr("conversations.filterLabel")}>
        {(["current", "archived", "metadata", "all"] as SessionFilter[]).map((value) => <ToggleGroupItem key={value} value={value} className={filter === value ? "active" : ""}><span>{tr(`conversations.filter.${value}`)}</span><em>{filterCounts[value]}</em></ToggleGroupItem>)}
      </ToggleGroup>
      {statuses.length > 0 && <div className="conversation-source-summary">{statuses.map((status) => {
        const sourceSessions = sessions.filter((session) => session.agent === status.agent);
        const readable = sourceSessions.filter((session) => session.availability === "readable").length;
        return <span key={status.agent}><AgentIcon agent={status.agent} /><strong>{status.agent === "codex" ? "Codex" : "Claude Code"}</strong><em>{tr("conversations.sourceCoverage", { total: status.session_count, readable })}</em></span>;
      })}</div>}
      {statuses.some((status) => status.freshness !== "fresh") && <div className="conversation-source-status"><CircleAlert size={14} /><span>{tr("conversations.partialIndex")}</span></div>}
      <div className="conversation-list">
        {filtered.map((session) => <Button variant="bare" size="content" key={session.id} className={selected?.id === session.id ? "active" : ""} onClick={() => { setSelectedId(session.id); setShowDetail(true); }}>
          <AgentIcon agent={session.agent} />
          <span>
            <strong>{session.title || tr("conversations.untitled")}</strong>
            <small>{session.updated_at ? formatRelativeTime(session.updated_at) : tr("conversations.unknownTime")}{session.message_count !== undefined ? ` · ${tr("conversations.messageCount", { count: session.message_count })}` : ""}</small>
            <em>{session.git_branch && <span><GitBranch size={11} />{session.git_branch}</span>}{session.archived && <span><Archive size={11} />{tr("conversations.archived")}</span>}{session.sidechain && <span>{tr("conversations.sidechain")}</span>}{session.availability === "metadata-only" && <span>{tr("conversations.metadataOnly")}</span>}</em>
          </span>
        </Button>)}
        {!filtered.length && <div className="conversation-empty"><MessageSquareText size={21} /><strong>{tr(filter === "current" && filterCounts.metadata > 0 ? "conversations.metadataAvailable" : "conversations.empty", { count: filterCounts.metadata })}</strong>{filter === "current" && filterCounts.metadata > 0 && <Button className="ghost" onClick={() => setFilter("metadata")}>{tr("conversations.viewMetadata")}</Button>}</div>}
      </div>
    </aside>
    <section className="panel conversation-detail">
      <header>
        <Button className="ghost conversation-back" onClick={() => setShowDetail(false)}><ArrowLeft size={15} />{tr("conversations.back")}</Button>
        {selected ? <><div><span><AgentIcon agent={selected.agent} /><strong>{selected.title || tr("conversations.untitled")}</strong></span><small>{selected.updated_at ? formatDateTime(selected.updated_at) : tr("conversations.unknownTime")}{selected.git_branch ? ` · ${selected.git_branch}` : ""}</small></div>{selected.availability === "readable" && events.length > 0 && <Button className="ghost conversation-handoff" onClick={() => setShowHandoff(true)}><FileOutput size={14} />{tr("handoff.create")}</Button>}</> : <strong>{tr("conversations.selectSession")}</strong>}
      </header>
      {error && <div className="alert"><CircleAlert size={15} />{error}</div>}
      {warnings.map((warning) => <div className="warning" key={warning}><CircleAlert size={14} />{tr("conversations.damagedLines")}</div>)}
      {!selected && <div className="conversation-empty"><MessageSquareText size={26} /><strong>{tr("conversations.selectSession")}</strong></div>}
      {selected?.availability === "metadata-only" && <div className="conversation-empty"><Archive size={24} /><strong>{tr("conversations.metadataOnly")}</strong><span>{tr("conversations.metadataOnlyDetail")}</span></div>}
      {selected?.availability === "readable" && <div className="conversation-thread">
        {nextCursor && <Button className="ghost load-earlier" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{tr(loadingEarlier ? "common.loading" : "conversations.loadEarlier")}</Button>}
        {reading && <div className="conversation-empty compact"><RefreshCw className="spin" size={18} /><span>{tr("conversations.reading")}</span></div>}
        {!reading && !events.length && !error && <div className="conversation-empty"><MessageSquareText size={24} /><strong>{tr("conversations.noReadableEvents")}</strong></div>}
        {events.map((event) => <ConversationEventRow key={event.id} event={event} />)}
      </div>}
    </section>
  </div>{showHandoff && selected && <SessionHandoffDialog workspace={workspace} session={selected} targetAgents={targetAgents} onClose={() => setShowHandoff(false)} onPlanned={(changeSet) => { setShowHandoff(false); onHandoffPlanned(changeSet); }} />}</>;
}

function ConversationEventRow({ event }: { event: ConversationEvent }) {
  if (event.kind === "tool-summary") {
    return <div className="conversation-tool"><Wrench size={14} /><strong>{event.tool_name || tr("conversations.tool")}</strong><span>{tr(`conversations.toolStatus.${event.tool_status ?? "unknown"}`)}</span>{(event.timestamp || event.duration_ms !== undefined) && <time>{event.timestamp ? formatDateTime(event.timestamp) : ""}{event.timestamp && event.duration_ms !== undefined ? " · " : ""}{event.duration_ms !== undefined ? formatDuration(event.duration_ms) : ""}</time>}</div>;
  }
  const isUser = event.kind === "user-message";
  return <article className={`conversation-message ${isUser ? "user" : "agent"}`}>
    <header>{isUser ? <UserRound size={14} /> : <Bot size={14} />}<strong>{tr(isUser ? "conversations.you" : "conversations.agent")}</strong>{event.timestamp && <time>{formatDateTime(event.timestamp)}</time>}</header>
    <div className="selectable">{event.content}</div>
    {(event.attachment_count > 0 || event.truncated) && <footer>{event.attachment_count > 0 && <span>{tr("conversations.attachments", { count: event.attachment_count })}</span>}{event.truncated && <span>{tr("conversations.contentTruncated")}</span>}</footer>}
  </article>;
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
