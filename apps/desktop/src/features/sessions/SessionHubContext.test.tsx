// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationIndexStatus,
  ConversationSessionSummary,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { SessionHubProvider, useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  catalog: vi.fn(),
  search: {} as { sessionId?: string },
  workspaceQuery: {
    data: [] as WorkspaceSummary[],
    isPending: false,
    error: null as Error | null,
    refetch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => doubles.navigate,
  useSearch: () => doubles.search,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeWorkspaces: () => doubles.workspaceQuery,
}));
vi.mock("./useSessionCatalog", () => ({
  useSessionCatalog: (...args: unknown[]) => doubles.catalog(...args),
}));

const workspace = {
  id: "workspace",
  name: "Project",
  path: "/projects/example",
} as WorkspaceSummary;
const session: ConversationSessionSummary = {
  id: "session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Review navigation",
  archived: false,
  sidechain: false,
  availability: "readable",
};

function catalogState() {
  return {
    sessions: [] as ConversationSessionSummary[],
    statuses: [] as ConversationIndexStatus[],
    errors: {} as Record<string, string>,
    loading: false,
    refreshing: false,
    ready: true,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return <SessionHubProvider>{children}</SessionHubProvider>;
}
function clearedSearch() {
  const navigation = doubles.navigate.mock.calls[0]?.[0] as {
    to: string;
    replace: boolean;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  expect(navigation.to).toBe("/sessions");
  expect(navigation.replace).toBe(true);
  return navigation.search({ sessionId: session.id, unrelated: "retained" });
}

describe("SessionHubProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().reset();
    useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo);
    useSessionViewStore.getState().resetFilters();
    doubles.search = { sessionId: session.id };
    doubles.workspaceQuery = {
      data: [workspace],
      isPending: false,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    };
    doubles.catalog.mockReturnValue(catalogState());
  });
  afterEach(cleanup);

  it("retains a deep link on partial read failure, then selects it when retry recovers", () => {
    const catalog = { ...catalogState(), errors: { [workspace.id]: "Cannot read index" } };
    doubles.catalog.mockReturnValue(catalog);
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();

    // A manual retry clears the old errors before the fresh records arrive.
    doubles.catalog.mockReturnValue({ ...catalogState(), refreshing: true });
    rerender();
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();

    doubles.catalog.mockReturnValue({ ...catalogState(), sessions: [session] });
    rerender();
    expect(result.current.selected).toEqual(session);
    expect(result.current.selectedWorkspace).toEqual(workspace);
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("clears a known session excluded by filters even if another workspace failed", () => {
    doubles.catalog.mockReturnValue({
      ...catalogState(),
      sessions: [session],
      refreshing: true,
      errors: { another: "Cannot read index" },
    });
    useSessionViewStore.getState().setAgent("claude-code");
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.filtered).toEqual([]);
    expect(doubles.navigate).toHaveBeenCalledOnce();
    expect(clearedSearch()).toEqual({ sessionId: undefined, unrelated: "retained" });
  });

  it("clears a truly missing session only after the complete initial load", () => {
    doubles.catalog.mockReturnValue({ ...catalogState(), ready: false, refreshing: true });
    const { rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.navigate).not.toHaveBeenCalled();
    doubles.catalog.mockReturnValue(catalogState());
    rerender();
    expect(doubles.navigate).toHaveBeenCalledOnce();
    expect(clearedSearch()).toEqual({ sessionId: undefined, unrelated: "retained" });
  });

  it("does not clear the selected URL while indexing is disabled", () => {
    useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    expect(result.current.enabled).toBe(false);
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("does not enable indexing or clear the selected URL before runtime initialization", () => {
    useAppStore.getState().setRuntime(undefined);
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    expect(result.current.runtimeReady).toBe(false);
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("retains the selected URL while workspace loading fails or is still pending", () => {
    doubles.workspaceQuery.isPending = true;
    const { rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.navigate).not.toHaveBeenCalled();
    doubles.workspaceQuery.isPending = false;
    doubles.workspaceQuery.error = new Error("Workspace list unavailable");
    rerender();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("increments history revision once after each completed refresh, not on unrelated renders", () => {
    doubles.search = {};
    const catalog = catalogState();
    doubles.catalog.mockReturnValue(catalog);
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.historyRevision).toBe(0);
    doubles.catalog.mockReturnValue({ ...catalog, refreshing: true });
    rerender();
    expect(result.current.historyRevision).toBe(0);
    doubles.catalog.mockReturnValue(catalog);
    rerender();
    expect(result.current.historyRevision).toBe(1);
    rerender();
    expect(result.current.historyRevision).toBe(1);
    doubles.catalog.mockReturnValue({ ...catalog, refreshing: true });
    rerender();
    doubles.catalog.mockReturnValue(catalog);
    rerender();
    expect(result.current.historyRevision).toBe(2);
  });

  it("does not increment history revision when disabling indexing interrupts a refresh", () => {
    doubles.search = {};
    doubles.catalog.mockReturnValue({ ...catalogState(), refreshing: true });
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    act(() => {
      useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
      doubles.catalog.mockReturnValue(catalogState());
      rerender();
    });
    expect(result.current.historyRevision).toBe(0);
  });

  it("delegates native refresh events to the current catalog callback and cleans up on unmount", async () => {
    doubles.search = {};
    const first = catalogState();
    doubles.catalog.mockReturnValue(first);
    const { rerender, unmount } = renderHook(() => useSessionHub(), { wrapper });
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(first.refresh).toHaveBeenCalledOnce();

    const replacement = catalogState();
    doubles.catalog.mockReturnValue(replacement);
    rerender();
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(first.refresh).toHaveBeenCalledOnce();
    expect(replacement.refresh).toHaveBeenCalledOnce();
    unmount();
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(replacement.refresh).toHaveBeenCalledOnce();
  });

  it("preserves unrelated search parameters for selection and overview navigation", () => {
    doubles.search = {};
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    act(() => result.current.select(session.id));
    const selectedNavigation = doubles.navigate.mock.calls[0][0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(selectedNavigation.search({ unrelated: "retained" })).toEqual({
      unrelated: "retained",
      sessionId: session.id,
    });
    act(() => result.current.select(undefined, true));
    const overviewNavigation = doubles.navigate.mock.calls[1][0] as {
      replace: boolean;
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(overviewNavigation.replace).toBe(true);
    expect(overviewNavigation.search({ sessionId: session.id })).toEqual({ sessionId: undefined });
  });
});
