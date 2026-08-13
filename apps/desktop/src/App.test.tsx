// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";
import { diffLines } from "./diff";
import { initializeI18n } from "./i18n";

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
    runtime: vi.fn().mockResolvedValue({ close_behavior: "minimize-to-tray", locale_preference: "system", effective_locale: "en-US" }),
    setLocale: vi.fn().mockImplementation((locale: string) => Promise.resolve({ close_behavior: "minimize-to-tray", locale_preference: locale, effective_locale: locale === "system" ? "en-US" : locale })),
    discoverWorkspaces: vi.fn().mockResolvedValue({ started_at: new Date().toISOString(), finished_at: new Date().toISOString(), discovered_count: 0, removed_count: 0, errors: [] }),
    insightsSummary: vi.fn().mockResolvedValue({ total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, my_commits: 8, all_commits: 20, attributed_commits: 3, active_days: 6, current_streak: 2, longest_streak: 4, quality: "incomplete", coverage_from: "2026-08-01", coverage_to: "2026-08-13" }),
    insightsHeatmap: vi.fn().mockResolvedValue([{ date: "2026-08-13", tokens: 120000, my_commits: 8, all_commits: 20, attributed_commits: 3, sessions: 12, quality: "exact" }]),
    agentUsageBreakdown: vi.fn().mockResolvedValue([{ agent: "codex", total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, quality: "exact" }]),
    modelUsageBreakdown: vi.fn().mockResolvedValue([{ model: "gpt-5", total_tokens: 120000, session_count: 12 }]),
    workspaceUsageBreakdown: vi.fn().mockResolvedValue([{ name: "未关联工作区", total_tokens: 120000, session_count: 12 }]),
    repositoryCommitBreakdown: vi.fn().mockResolvedValue([]),
    achievements: vi.fn().mockResolvedValue([]),
    insightsStatus: vi.fn().mockResolvedValue({ providers: [], running: false }),
    gitIdentities: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue({ root: "/tmp/project", manifest_exists: false, agents: [], assets: [], warnings: [] }),
    manifest: vi.fn().mockResolvedValue({ schema_version: 1, workspace: { id: "project", name: "Project" }, instructions: { shared: "", scoped: [], platform_overrides: {} }, skills: [], mcp: { config: ".agentkib/mcp.json" }, connections: [], memories: { require_approval: true }, adapters: {} }),
  },
}));

const storage = new Map<string, string>();
beforeEach(async () => {
  storage.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  } });
  await initializeI18n("en-US");
});
afterEach(() => {
  cleanup();
  vi.mocked(api.workspaces).mockResolvedValue([]);
});

describe("AgentKib desktop", () => {
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
    expect(screen.getByText("No workspaces found")).toBeInTheDocument();
    expect(screen.queryByText("选择本地项目")).not.toBeInTheDocument();
  });

  it("keeps low-frequency tasks out of the global navigation", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    const navigation = within(screen.getByRole("navigation", { name: "Primary navigation" }));
    expect(navigation.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Home",
      "Workspaces",
      "Assets",
      "Agents",
      "Achievements",
      "Settings",
    ]);
    expect(navigation.queryByRole("button", { name: "Memory Inbox" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();

    fireEvent.click(navigation.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("button", { name: "Catalog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP" })).toBeInTheDocument();
  });

  it("keeps the global sidebar when opening a workspace without a manifest", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project",
      path: "/tmp/project",
      name: "Project",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [{ agent: "codex", evidence: "session-cwd", session_count: 1 }],
    }]);
    render(<App />);
    const project = await screen.findByRole("button", { name: /Project \/tmp\/project/ });
    fireEvent.click(project);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument());
    const navigation = within(screen.getByRole("navigation", { name: "Primary navigation" }));
    expect(navigation.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
  });

  it("shows token and commit achievements without a cloud account", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/120K Token/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Achievements" }));
    await waitFor(() => expect(screen.getByText("Your Agent Collaboration Journey")).toBeInTheDocument());
    expect(screen.getByText("Activity Heatmap")).toBeInTheDocument();
    expect(screen.getAllByText("My Commits")).toHaveLength(2);
  });

  it.each([
    ["zh-CN", "首页", "没有发现可用工作区"],
    ["zh-TW", "首頁", "找不到可用工作區"],
    ["ja-JP", "ホーム", "ワークスペースが見つかりません"],
    ["en-US", "Home", "No workspaces found"],
  ] as const)("renders the home empty state in %s", async (locale, heading, emptyText) => {
    await initializeI18n(locale);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument());
    expect(screen.getByText(emptyText)).toBeInTheDocument();
  });

  it("switches language immediately from Settings", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument());
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
