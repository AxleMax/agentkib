import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useHomeWorkspaces } from "@/features/home/home-query";
import { useAppStore } from "@/stores/app-store";
import { localizeMessage } from "@/core/i18n";
import { useSessionCatalog } from "./useSessionCatalog";
import { filterSessions } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";
import "./sessions.css";

function useHub() {
  const workspaceQuery = useHomeWorkspaces();
  const workspaces = useMemo(() => workspaceQuery.data ?? [], [workspaceQuery.data]);
  const runtime = useAppStore((state) => state.runtime);
  const enabled = runtime?.session_index_enabled === true;
  const catalog = useSessionCatalog(workspaces, enabled);
  const refreshCatalog = catalog.refresh;
  const [historyRevision, setHistoryRevision] = useState(0);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !catalog.refreshing && catalog.ready && enabled) {
      setHistoryRevision((revision) => revision + 1);
    }
    wasRefreshing.current = catalog.refreshing;
  }, [catalog.refreshing, catalog.ready, enabled]);
  useEffect(() => {
    const refresh = () => void refreshCatalog();
    window.addEventListener(SESSION_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(SESSION_REFRESH_EVENT, refresh);
  }, [refreshCatalog]);
  const agent = useSessionViewStore((state) => state.agent);
  const filter = useSessionViewStore((state) => state.filter);
  const filtered = useMemo(
    () => filterSessions(catalog.sessions, workspaces, { query: "", agent, filter }),
    [catalog.sessions, workspaces, agent, filter],
  );
  const navigate = useNavigate();
  const { sessionId } = useSearch({ strict: false }) as { sessionId?: string };
  const selected = enabled ? filtered.find((session) => session.id === sessionId) : undefined;
  const selectedWorkspace = selected
    ? workspaces.find((workspace) => workspace.id === selected.workspace_id)
    : undefined;
  const select = (id?: string, replace = false) =>
    void navigate({
      to: "/sessions",
      replace,
      search: (current) => ({ ...current, sessionId: id }),
    });
  useEffect(() => {
    // Wait until every workspace cache has been read before validating a deep link.
    if (
      sessionId &&
      catalog.ready &&
      enabled &&
      !workspaceQuery.isPending &&
      !workspaceQuery.error &&
      !selected &&
      (catalog.sessions.some((session) => session.id === sessionId) ||
        (!catalog.refreshing && Object.keys(catalog.errors).length === 0))
    ) {
      void navigate({
        to: "/sessions",
        replace: true,
        search: (current) => ({ ...current, sessionId: undefined }),
      });
    }
  }, [
    sessionId,
    catalog.ready,
    catalog.refreshing,
    catalog.sessions,
    catalog.errors,
    enabled,
    selected,
    workspaceQuery.isPending,
    workspaceQuery.error,
    navigate,
  ]);
  return {
    ...catalog,
    historyRevision,
    workspaces,
    filtered,
    selected,
    selectedWorkspace,
    select,
    enabled,
    runtimeReady: runtime !== undefined,
    workspacesLoading: workspaceQuery.isPending,
    workspacesError: workspaceQuery.error ? localizeMessage(workspaceQuery.error) : "",
    retryWorkspaces: () => void workspaceQuery.refetch(),
  };
}

const SessionHubContext = createContext<ReturnType<typeof useHub> | null>(null);

export function SessionHubProvider({ children }: { children: ReactNode }) {
  return <SessionHubContext.Provider value={useHub()}>{children}</SessionHubContext.Provider>;
}

export function useSessionHub() {
  const context = useContext(SessionHubContext);
  if (!context) throw new Error("SessionHubProvider is required");
  return context;
}
