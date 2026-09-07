import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  CircleAlert,
  Clock,
  Database,
  FileText,
  Info,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { api } from "@/core/api";
import { formatDateTime, localizeMessage, tr } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import { sessionAgentNames, sessionRecordLabel } from "./session-labels";
import { useSessionHistory } from "./useSessionHistory";
import { ConversationEventRow } from "./ConversationEventRow";

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={`session-notice ${error ? "session-notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? <CircleAlert size={17} /> : <Info size={17} />}
      <div>{children}</div>
    </div>
  );
}

export function SessionHubPage() {
  const hub = useSessionHub();
  const navigate = useNavigate();
  const history = useSessionHistory(hub.selected, hub.enabled, hub.historyRevision);
  const resetFilters = useSessionViewStore((state) => state.resetFilters);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const enableLock = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (historyRef.current) historyRef.current.scrollTop = 0;
  }, [hub.selected?.id]);

  const enable = async () => {
    if (enableLock.current) return;
    enableLock.current = true;
    setEnabling(true);
    setEnableError("");
    try {
      useAppStore.getState().setRuntime(await api.setSessionIndexEnabled(true));
    } catch (error) {
      setEnableError(localizeMessage(error));
    } finally {
      enableLock.current = false;
      setEnabling(false);
    }
  };

  if (!hub.runtimeReady || hub.workspacesLoading)
    return (
      <div className="session-state" role="status">
        <RefreshCw className="animate-spin" size={24} />
        <p>{tr("sessions.loading")}</p>
      </div>
    );
  if (!hub.enabled)
    return (
      <div className="session-state">
        <Database size={32} />
        <h1>{tr("conversations.indexDisabled")}</h1>
        <p>{tr("sessions.enableDescription")}</p>
        {enableError && <Notice error>{enableError}</Notice>}
        <Button disabled={enabling} onClick={() => void enable()}>
          {tr(enabling ? "sessions.enabling" : "conversations.enable")}
        </Button>
      </div>
    );
  if (hub.workspacesError && !hub.workspaces.length)
    return (
      <div className="session-state">
        <Notice error>{hub.workspacesError}</Notice>
        <Button onClick={hub.retryWorkspaces}>{tr("sessions.retry")}</Button>
      </div>
    );

  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const stats = [
    ["all", hub.filtered.length],
    ["readable", hub.filtered.filter((session) => session.availability === "readable").length],
    ["archived", hub.filtered.filter((session) => session.archived).length],
    ["metadata", hub.filtered.filter((session) => session.availability === "metadata-only").length],
  ] as const;
  const visibleWorkspaceIds = new Set(hub.filtered.map((session) => session.workspace_id));
  const statusWorkspaces = hub.workspaces.filter(
    (item) =>
      visibleWorkspaceIds.has(item.id) ||
      Boolean(hub.errors[item.id]) ||
      !hub.sessions.some((session) => session.workspace_id === item.id),
  );

  return (
    <div className="session-hub-page">
      {selected && (
        <header className="session-hub-header">
          <div className="session-hub-heading">
            <Button
              variant="ghost"
              size="icon"
              aria-label={tr("sessions.backOverview")}
              onClick={() => hub.select()}
            >
              <ArrowLeft size={18} />
            </Button>
            <AgentIcon agent={selected.agent} />
            <div>
              <h1>{displaySessionTitle(selected.title)}</h1>
              <p>
                {`${tr("sessions.local")} · ${workspace?.name ?? ""} · ${sessionAgentNames[selected.agent]}`}
              </p>
            </div>
          </div>
          <div className="session-header-actions">
            {workspace && selected.availability === "readable" && (
              <Button
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/workspace/$workspaceId/sessions",
                    params: { workspaceId: workspace.id },
                    search: { sessionId: selected.id },
                  })
                }
              >
                <ArrowUpRight size={16} />
                {tr("sessions.continueWorkspace")}
              </Button>
            )}
            <Button variant="outline" disabled={hub.refreshing} onClick={() => void hub.refresh()}>
              <RefreshCw size={16} className={hub.refreshing ? "animate-spin" : ""} />
              {tr("sessions.refresh")}
            </Button>
          </div>
        </header>
      )}
      <div className="session-hub-body" ref={historyRef}>
        {hub.workspacesError && (
          <Notice error>
            {hub.workspacesError}
            <Button variant="ghost" onClick={hub.retryWorkspaces}>
              {tr("sessions.retry")}
            </Button>
          </Notice>
        )}
        {Object.keys(hub.errors).length > 0 && (
          <Notice error>
            {tr("sessions.partialFailure", { count: Object.keys(hub.errors).length })}
          </Notice>
        )}
        {selected ? (
          <>
            <div className="session-history-meta">
              <span>
                <FileText size={15} />
                {sessionRecordLabel(selected)}
              </span>
              <span>
                <Clock size={15} />
                {selected.updated_at
                  ? formatDateTime(selected.updated_at)
                  : tr("conversations.unknownTime")}
              </span>
              {selected.git_branch && <span>{selected.git_branch}</span>}
            </div>
            <Notice>{tr("sessions.historyOnly")}</Notice>
            {history.error && (
              <Notice error>
                {history.error}
                <Button variant="ghost" onClick={() => void history.retry()}>
                  {tr("sessions.retry")}
                </Button>
              </Notice>
            )}
            {history.warnings.map((warning) => (
              <Notice key={warning}>{localizeMessage(warning)}</Notice>
            ))}
            {selected.availability === "metadata-only" ? (
              <div className="session-state session-state-inline">
                <FileText size={28} />
                <h2>{tr("conversations.filter.metadata")}</h2>
                <p>{tr("sessions.metadataDescription")}</p>
              </div>
            ) : history.loading ? (
              <div className="session-state session-state-inline" role="status">
                <RefreshCw className="animate-spin" size={24} />
                <p>{tr("sessions.loadingHistory")}</p>
              </div>
            ) : (
              <div className="session-transcript">
                {history.nextCursor && (
                  <Button
                    variant="outline"
                    className="self-center"
                    disabled={history.loadingEarlier}
                    onClick={() => void history.loadEarlier()}
                  >
                    {tr(
                      history.loadingEarlier ? "sessions.loadingHistory" : "sessions.loadEarlier",
                    )}
                  </Button>
                )}
                {!history.events.length && !history.error && (
                  <p className="session-state-inline text-muted-foreground">
                    {tr("conversations.noReadableEvents")}
                  </p>
                )}
                {history.events.map((event) => (
                  <ConversationEventRow key={event.id} event={event} variant="hub" />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="session-overview-description">{tr("sessions.overviewDescription")}</p>
            <div className="session-stats">
              {stats.map(([key, count]) => (
                <div key={key}>
                  <strong>{count}</strong>
                  <span>{tr(`sessions.stat.${key}`)}</span>
                </div>
              ))}
            </div>
            {hub.loading && <Notice>{tr("conversations.scanning")}</Notice>}
            <div className="session-overview-panels">
              <section className="session-overview-panel">
                <header>
                  <Clock size={18} />
                  <h2>{tr("sessions.recent")}</h2>
                  <span>{hub.filtered.length}</span>
                </header>
                {hub.filtered.slice(0, 12).map((session) => {
                  const source = hub.workspaces.find((item) => item.id === session.workspace_id);
                  return (
                    <Button
                      variant="bare"
                      size="content"
                      className="session-recent-item"
                      key={session.id}
                      onClick={() => hub.select(session.id)}
                      title={source?.path}
                    >
                      <AgentIcon agent={session.agent} compact />
                      <span>
                        <strong>{displaySessionTitle(session.title)}</strong>
                        <small>
                          {source?.name} · {sessionAgentNames[session.agent]} ·{" "}
                          {sessionRecordLabel(session)}
                        </small>
                      </span>
                      <time>
                        {session.updated_at
                          ? formatDateTime(session.updated_at)
                          : tr("conversations.unknownTime")}
                      </time>
                    </Button>
                  );
                })}
                {!hub.filtered.length && !hub.loading && (
                  <div className="session-state-inline">
                    <p>{tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}</p>
                    {hub.sessions.length > 0 && (
                      <Button variant="ghost" onClick={resetFilters}>
                        {tr("sessions.clearFilters")}
                      </Button>
                    )}
                  </div>
                )}
              </section>
              <section className="session-overview-panel">
                <header>
                  <Database size={18} />
                  <h2>{tr("sessions.indexStatus")}</h2>
                </header>
                {statusWorkspaces.map((item) => (
                  <div className="session-index-item" key={item.id}>
                    <strong title={item.path}>{item.name}</strong>
                    {hub.errors[item.id] && (
                      <p className="text-destructive">{hub.errors[item.id]}</p>
                    )}
                    {hub.statuses
                      .filter((status) => status.workspace_id === item.id)
                      .map((status) => (
                        <div className="session-index-status" key={`${item.id}:${status.agent}`}>
                          <span>{sessionAgentNames[status.agent]}</span>
                          <span>{tr(`sessions.index.${status.freshness}`)}</span>
                          <small>
                            {status.last_success_at
                              ? formatDateTime(status.last_success_at)
                              : tr("sessions.neverIndexed")}
                          </small>
                          {(status.error_key || status.error_detail) && (
                            <p className="text-destructive">
                              {status.error_key
                                ? tr(status.error_key)
                                : localizeMessage(status.error_detail ?? "")}
                            </p>
                          )}
                        </div>
                      ))}
                    {!hub.statuses.some((status) => status.workspace_id === item.id) && (
                      <p>
                        {tr(hub.refreshing ? "conversations.scanning" : "sessions.neverIndexed")}
                      </p>
                    )}
                  </div>
                ))}
                {!statusWorkspaces.length && (
                  <p className="session-state-inline">
                    {tr(hub.workspaces.length ? "sessions.noMatches" : "sessions.noWorkspaces")}
                  </p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
