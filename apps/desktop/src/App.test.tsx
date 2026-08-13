// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { diffLines } from "./diff";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./api", () => ({
  api: {
    workspaces: vi.fn().mockResolvedValue([]),
    agentInstallations: vi.fn().mockResolvedValue([]),
    catalogAssets: vi.fn().mockResolvedValue([]),
    globalMemories: vi.fn().mockResolvedValue([]),
    activity: vi.fn().mockResolvedValue([]),
    scanRoots: vi.fn().mockResolvedValue([]),
    excludedWorkspaces: vi.fn().mockResolvedValue([]),
    runtime: vi.fn().mockResolvedValue({ close_behavior: "minimize-to-tray" }),
    discoverWorkspaces: vi.fn().mockResolvedValue({ started_at: new Date().toISOString(), finished_at: new Date().toISOString(), discovered_count: 0, removed_count: 0, errors: [] }),
  },
}));

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  } });
});
afterEach(cleanup);

describe("AgentHub desktop", () => {
  it("keeps the supported agent labels stable", () => {
    const agents = ["Codex", "Claude Code", "OpenClaw", "Hermes"];
    expect(agents).toHaveLength(4);
    expect(new Set(agents).size).toBe(4);
  });

  it("shows both removed and added lines in a changeset diff", () => {
    const result = diffLines("keep\nold", "keep\nnew");
    expect(result).toContainEqual({ type: "removed", content: "old" });
    expect(result).toContainEqual({ type: "added", content: "new" });
  });

  it("opens the global asset center without forcing folder selection", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    expect(screen.getByText("没有发现可用工作区")).toBeInTheDocument();
    expect(screen.queryByText("选择本地项目")).not.toBeInTheDocument();
  });
});
