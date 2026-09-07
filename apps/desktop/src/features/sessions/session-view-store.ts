import { create } from "zustand";
import type { AgentKind, ConversationSessionSummary } from "@/core/types";

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

// View-only state survives navigation, but never persists transcript content to disk.
export const useSessionViewStore = create<{
  agent: AgentKind | "all";
  filter: SessionRecordFilter;
  collapsed: Record<string, boolean>;
  scrollTop: number;
  revealSession: (session: ConversationSessionSummary) => void;
  setAgent: (agent: AgentKind | "all") => void;
  setFilter: (filter: SessionRecordFilter) => void;
  toggleWorkspace: (id: string) => void;
  setScrollTop: (scrollTop: number) => void;
  resetFilters: () => void;
}>((set) => ({
  agent: "all",
  filter: "current",
  collapsed: {},
  scrollTop: 0,
  revealSession: (session) =>
    set((state) => ({
      agent: state.agent === "all" || state.agent === session.agent ? state.agent : "all",
      filter:
        (state.filter === "current" && (session.archived || session.availability !== "readable")) ||
        (state.filter === "archived" && !session.archived) ||
        (state.filter === "metadata" && session.availability !== "metadata-only")
          ? "all"
          : state.filter,
      collapsed: { ...state.collapsed, [session.workspace_id]: false },
    })),
  setAgent: (agent) => set({ agent }),
  setFilter: (filter) => set({ filter }),
  toggleWorkspace: (id) =>
    set((state) => ({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })),
  setScrollTop: (scrollTop) => set({ scrollTop }),
  resetFilters: () => set({ agent: "all", filter: "current" }),
}));
