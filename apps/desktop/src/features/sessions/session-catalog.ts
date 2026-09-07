import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { tr } from "@/core/i18n";

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

export interface SessionCatalogFilter {
  query: string;
  agent: AgentKind | "all";
  filter: SessionRecordFilter;
  /** Auxiliary records are opt-in; unknown/missing origins remain visible. */
  showAuxiliary?: boolean;
}

export function isAuxiliarySession(session: ConversationSessionSummary) {
  return session.origin === "auxiliary";
}

/** Shared source-visibility rule for all session surfaces. */
export function isSessionVisible(session: ConversationSessionSummary, showAuxiliary = false) {
  return showAuxiliary || !isAuxiliarySession(session);
}

export function sortSessions(sessions: ConversationSessionSummary[]) {
  const timestamp = (session: ConversationSessionSummary) => {
    const value = Date.parse(session.updated_at ?? session.created_at ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  // Array#sort is stable, so equal or missing timestamps retain their input order.
  return [...sessions].sort((left, right) => timestamp(right) - timestamp(left));
}

export function filterSessions(
  sessions: ConversationSessionSummary[],
  workspaces: WorkspaceSummary[],
  { query, agent, filter, showAuxiliary = false }: SessionCatalogFilter,
  translate = tr,
) {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const search = query.trim().toLocaleLowerCase();
  return sortSessions(
    sessions.filter((session) => {
      if (!isSessionVisible(session, showAuxiliary)) return false;
      if (!names.has(session.workspace_id)) return false;
      if (agent !== "all" && session.agent !== agent) return false;
      if (filter === "current" && (session.archived || session.availability !== "readable")) {
        return false;
      }
      if (filter === "archived" && !session.archived) return false;
      if (filter === "metadata" && session.availability !== "metadata-only") return false;
      if (!search) return true;
      return [
        displaySessionTitle(session.title, translate),
        names.get(session.workspace_id) ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(search));
    }),
  );
}

export function sessionCatalogStats(sessions: ConversationSessionSummary[]) {
  return {
    total: sessions.length,
    readable: sessions.filter((session) => session.availability === "readable").length,
    archived: sessions.filter((session) => session.archived).length,
    metadata: sessions.filter((session) => session.availability === "metadata-only").length,
  };
}
