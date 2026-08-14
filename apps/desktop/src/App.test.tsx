// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";
import { diffLines } from "./diff";
import { initializeI18n } from "./i18n";

const tauriListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
  tauriListeners.set(event, handler);
  return Promise.resolve(() => tauriListeners.delete(event));
}) }));
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
    obsidianIntegration: vi.fn().mockResolvedValue({ installation: { installed: false, cli_available: false }, vaults: [], workspace_links: [] }),
    addObsidianVault: vi.fn(),
    linkWorkspaceToObsidian: vi.fn(),
    unlinkWorkspaceFromObsidian: vi.fn(),
    openObsidian: vi.fn(),
    openWorkspaceInObsidian: vi.fn(),
    remoteGateways: vi.fn().mockResolvedValue([]),
    saveRemoteGateway: vi.fn(),
    refreshRemoteGateway: vi.fn(),
    removeRemoteGateway: vi.fn(),
    runtime: vi.fn().mockResolvedValue({ close_behavior: "minimize-to-tray", locale_preference: "system", effective_locale: "en-US", theme_preference: "system", effective_theme: "dark" }),
    quitApp: vi.fn().mockResolvedValue(undefined),
    openFilesAndFoldersSettings: vi.fn().mockResolvedValue(undefined),
    setLocale: vi.fn().mockImplementation((locale: string) => Promise.resolve({ close_behavior: "minimize-to-tray", locale_preference: locale, effective_locale: locale === "system" ? "en-US" : locale, theme_preference: "system", effective_theme: "dark" })),
    setThemePreference: vi.fn().mockImplementation((preference: string) => Promise.resolve({ close_behavior: "minimize-to-tray", locale_preference: "system", effective_locale: "en-US", theme_preference: preference, effective_theme: preference === "light" ? "light" : "dark" })),
    requestRefresh: vi.fn().mockResolvedValue({ kind: "discovery", disposition: "queued", request_id: "test-refresh" }),
    refreshStatus: vi.fn().mockResolvedValue([]),
    storageOverview: vi.fn().mockResolvedValue({ total_workspace_count: 1, scanned_workspace_count: 0, allocated_bytes: 0, logical_bytes: 0, regenerable_bytes: 0, agent_asset_bytes: 0, workspaces: [] }),
    cancelStorageScan: vi.fn().mockResolvedValue(true),
    discoverWorkspaces: vi.fn().mockResolvedValue({ kind: "discovery", disposition: "queued", request_id: "test-refresh" }),
    insightsSummary: vi.fn().mockResolvedValue({ total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, my_commits: 8, all_commits: 20, attributed_commits: 3, active_days: 6, current_streak: 2, longest_streak: 4, quality: "incomplete", coverage_from: "2026-08-01", coverage_to: "2026-08-13" }),
    insightsHeatmap: vi.fn().mockResolvedValue([{ date: "2026-08-13", tokens: 120000, my_commits: 8, all_commits: 20, attributed_commits: 3, sessions: 12, quality: "exact" }]),
    agentUsageBreakdown: vi.fn().mockResolvedValue([{ agent: "codex", total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, quality: "exact" }]),
    modelUsageBreakdown: vi.fn().mockResolvedValue([{ model: "gpt-5", total_tokens: 120000, session_count: 12 }]),
    workspaceUsageBreakdown: vi.fn().mockResolvedValue([{ name: "未关联工作区", total_tokens: 120000, session_count: 12 }]),
    repositoryCommitBreakdown: vi.fn().mockResolvedValue([]),
    achievements: vi.fn().mockResolvedValue([]),
    insightsStatus: vi.fn().mockResolvedValue({ providers: [], running: false }),
    quotaSnapshot: vi.fn().mockResolvedValue(undefined),
    quotaCollectorStatus: vi.fn().mockResolvedValue({ backend: "codex-bar-cli", platform_supported: true, sidecar_available: true, config_source: "agentkib-managed", running: false }),
    quotaPopoverPreferences: vi.fn().mockResolvedValue({ hidden_providers: [], hidden_windows: [] }),
    setQuotaPopoverPreferences: vi.fn().mockImplementation((preferences) => Promise.resolve(preferences)),
    refreshQuota: vi.fn().mockResolvedValue({ kind: "quota", disposition: "queued", request_id: "quota-refresh" }),
    insightsView: vi.fn().mockResolvedValue({
      summary: { total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, my_commits: 8, all_commits: 20, attributed_commits: 3, active_days: 6, current_streak: 2, longest_streak: 4, quality: "incomplete", coverage_from: "2026-08-01", coverage_to: "2026-08-13" },
      heatmap: [{ date: "2026-08-13", tokens: 120000, my_commits: 8, all_commits: 20, attributed_commits: 3, sessions: 12, quality: "exact" }],
      agents: [{ agent: "codex", total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, quality: "exact" }],
      models: [{ model: "gpt-5", total_tokens: 120000, session_count: 12 }],
      workspaces: [{ name: "未关联工作区", total_tokens: 120000, session_count: 12 }],
      repositories: [], achievements: [], status: { providers: [], running: false },
    }),
    gitIdentities: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue({ root: "/tmp/project", manifest_exists: false, agents: [], assets: [], warnings: [] }),
    manifest: vi.fn().mockResolvedValue({ schema_version: 1, workspace: { id: "project", name: "Project" }, instructions: { shared: "", scoped: [], platform_overrides: {} }, skills: [], mcp: { config: ".agentkib/mcp.json" }, connections: [], memories: { require_approval: true }, adapters: {} }),
  },
}));

const storage = new Map<string, string>();
beforeEach(async () => {
  storage.clear();
  tauriListeners.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  } });
  await initializeI18n("en-US");
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
});
afterEach(() => {
  cleanup();
  vi.mocked(api.quitApp).mockClear();
  vi.mocked(api.workspaces).mockResolvedValue([]);
  vi.mocked(api.agentInstallations).mockResolvedValue([]);
  vi.mocked(api.insightsView).mockResolvedValue({
    summary: { total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, my_commits: 8, all_commits: 20, attributed_commits: 3, active_days: 6, current_streak: 2, longest_streak: 4, quality: "incomplete", coverage_from: "2026-08-01", coverage_to: "2026-08-13" },
    heatmap: [{ date: "2026-08-13", tokens: 120000, my_commits: 8, all_commits: 20, attributed_commits: 3, sessions: 12, quality: "exact" }],
    agents: [{ agent: "codex", total_tokens: 120000, input_tokens: 80000, output_tokens: 40000, cache_tokens: 10000, reasoning_tokens: 5000, session_count: 12, quality: "exact" }],
    models: [{ model: "gpt-5", total_tokens: 120000, session_count: 12 }],
    workspaces: [{ name: "未关联工作区", total_tokens: 120000, session_count: 12 }],
    repositories: [], achievements: [], status: { providers: [], running: false },
  });
});

describe("AgentKib desktop", () => {
  it("keeps the supported agent labels stable", () => {
    const agents = ["Codex", "Claude Code", "Cursor", "OpenClaw", "Hermes", "DeepSeek Harness"];
    expect(agents).toHaveLength(6);
    expect(new Set(agents).size).toBe(6);
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

  it("keeps unavailable usage providers out of Home attention", async () => {
    vi.mocked(api.insightsStatus).mockResolvedValueOnce({
      running: false,
      providers: [{ agent: "open-claw", available: false, quality: "incomplete", imported_events: 0, error: "gateway offline" }],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    expect(screen.getByText("Everything is in order")).toBeInTheDocument();
    expect(screen.queryByText("gateway offline")).not.toBeInTheDocument();
  });

  it("hides the empty recent activity panel and links every Home metric", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    expect(screen.queryByText("Recent Activity")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("queues manual discovery without replacing the cached workspace view", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspaces" })).toBeInTheDocument());
    vi.mocked(api.requestRefresh).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Refresh Discovery/i }));

    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("discovery", true));
    expect(screen.getByRole("button", { name: /Project \/tmp\/project/ })).toBeInTheDocument();
  });

  it("opens workspace storage from cache and only scans after confirmation", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Space" }));

    expect(await screen.findByText("Workspace space has not been scanned")).toBeInTheDocument();
    expect(api.requestRefresh).not.toHaveBeenCalledWith("storage", true);
    fireEvent.click(screen.getByRole("button", { name: "Start Scan" }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("storage", true));
  });

  it("defers discovery cache reads while the window is hidden", async () => {
    render(<App />);
    await waitFor(() => expect(tauriListeners.has("agentkib:refresh-state")).toBe(true));
    vi.mocked(api.workspaces).mockClear();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    act(() => tauriListeners.get("agentkib:refresh-state")?.({ payload: { kind: "discovery", state: "succeeded" } }));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(api.workspaces).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.workspaces).toHaveBeenCalledTimes(1));
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
      "Quota",
      "Achievements",
    ]);
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(navigation.queryByRole("button", { name: "Memory Inbox" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("button", { name: "Activity" })).not.toBeInTheDocument();

    fireEvent.click(navigation.getByRole("button", { name: "Assets" }));
    expect(await screen.findByRole("tab", { name: /Instructions/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Skills/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Memory/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^MCP\s*0$/ })).toBeInTheDocument();
  });

  it("loads Agent and quota pages on demand", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Codex" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quota" }));
    expect(await screen.findByPlaceholderText("Search providers or accounts")).toBeInTheDocument();
    expect(screen.getByText("No quota snapshot yet")).toBeInTheDocument();
  });

  it("does not count DeepSeek Harness residual data as an installation", async () => {
    vi.mocked(api.agentInstallations).mockResolvedValue([{
      agent: "deepseek-harness",
      installed: false,
      configured: true,
      home: "/tmp/.dsh",
      warnings: [],
    }]);
    render(<App />);

    expect(await screen.findByText("0 / 6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(await screen.findByText("Local data found")).toBeInTheDocument();
    expect(screen.getAllByText("DeepSeek Harness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    const navigation = within(screen.getByRole("navigation", { name: "Primary navigation" }));
    expect(navigation.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
  });

  it("treats the native quit request as a real app exit", async () => {
    render(<App />);
    await waitFor(() => expect(tauriListeners.has("agentkib:quit-requested")).toBe(true));

    await act(async () => {
      await tauriListeners.get("agentkib:quit-requested")?.({ payload: undefined });
    });

    expect(api.quitApp).toHaveBeenCalledOnce();
  });

  it("asks before quitting with an unsaved workspace draft", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project",
      path: "/tmp/project",
      name: "Project",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [{ agent: "codex", evidence: "session-cwd", session_count: 1 }],
    }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Shared Project Instructions" }), { target: { value: "Keep this draft" } });
    await waitFor(() => expect(tauriListeners.has("agentkib:quit-requested")).toBe(true));

    await act(async () => {
      await tauriListeners.get("agentkib:quit-requested")?.({ payload: undefined });
    });

    expect(confirm).toHaveBeenCalledWith("Discard unsaved workspace drafts and quit AgentKib?");
    expect(api.quitApp).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("returns from the dedicated Settings shell to the active workspace", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to AgentKib" }));
    expect(await screen.findByRole("heading", { name: "Project" })).toBeInTheDocument();
  });

  it("shows token and commit achievements without a cloud account", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/120K Token/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Achievements" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument());
    expect(await screen.findByText("Activity Heatmap")).toBeInTheDocument();
    expect(screen.getAllByText("My Commits")).toHaveLength(2);
  });

  it("renders only the panels for the selected achievement section", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Achievements" }));
    expect(await screen.findByText("Activity Heatmap")).toBeInTheDocument();
    expect(screen.queryByText("Agent Usage")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Token" }));
    expect(await screen.findByText("Agent Usage")).toBeInTheDocument();
    expect(screen.queryByText("Activity Heatmap")).not.toBeInTheDocument();
  });

  it("renders a unified achievement wall and opens track and secret details", async () => {
    const view = await api.insightsView();
    vi.mocked(api.insightsView).mockResolvedValue({ ...view, achievements: [
      { code: "token-100000", category: "token", threshold: 100_000, progress: 120_000, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "token-1000000", category: "token", threshold: 1_000_000, progress: 120_000 },
      { code: "session-10", category: "session", threshold: 10, progress: 12, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "commit-1", category: "commit", threshold: 1, progress: 8, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "commit-10", category: "commit", threshold: 10, progress: 8 },
      { code: "active-days-7", category: "active-days", threshold: 7, progress: 9, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "streak-3", category: "streak", threshold: 3, progress: 4, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "workspaces-1", category: "workspaces", threshold: 1, progress: 2, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "agents-2", category: "agents", threshold: 2, progress: 1 },
      { code: "special-first-changeset", category: "special", threshold: 1, progress: 1, unlocked_at: "2026-08-01T00:00:00Z" },
      { code: "special-first-memory", category: "special", threshold: 1, progress: 0 },
      { code: "special-night-owl", category: "special", threshold: 1, progress: 0 },
      { code: "special-comeback", category: "special", threshold: 1, progress: 1, unlocked_at: "2026-08-02T00:00:00Z" },
    ] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Achievements" }));
    fireEvent.click(screen.getByRole("tab", { name: "Achievement Wall" }));

    expect(await screen.findByRole("heading", { name: "Achievement Wall" })).toBeInTheDocument();
    expect(screen.getByText("Milestones 6 / 9")).toBeInTheDocument();
    expect(screen.getByText("Special 2 / 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Token achievement path" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Safe Landing")).toBeInTheDocument();
    expect(screen.getByText("Welcome Back")).toBeInTheDocument();
    expect(screen.getByText("Mystery Achievement")).toBeInTheDocument();
    expect(screen.queryByText("Night Owl")).not.toBeInTheDocument();

    const tokenCard = screen.getByRole("button", { name: "View Token achievement path" });
    tokenCard.focus();
    fireEvent.click(tokenCard);
    const trackDialog = screen.getByRole("dialog", { name: "Token" });
    expect(within(trackDialog).getByRole("progressbar")).toBeInTheDocument();
    expect(within(trackDialog).getByText("Next target")).toBeInTheDocument();
    expect(within(trackDialog).getAllByText("Token Launch").length).toBeGreaterThan(0);
    expect(within(trackDialog).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(within(trackDialog).getAllByRole("button").at(-1)).toHaveFocus();
    const nextMilestone = within(trackDialog).getByRole("button", { name: /Million Context/ });
    fireEvent.click(nextMilestone);
    expect(nextMilestone).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tokenCard).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "View achievement details: Mystery Achievement" }));
    const secretDialog = screen.getByRole("dialog", { name: "Mystery Achievement" });
    expect(within(secretDialog).getByText("Unlock condition is secret")).toBeInTheDocument();
    expect(within(secretDialog).queryByText("Night Owl")).not.toBeInTheDocument();
    fireEvent.mouseDown(secretDialog.parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "常规" })).toBeInTheDocument());
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("switches appearance immediately without leaving Settings", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(api.setThemePreference).toHaveBeenCalledWith("light");
  });

  it("tracks macOS appearance changes only while following the system", async () => {
    render(<App />);
    await waitFor(() => expect(tauriListeners.has("tauri://theme-changed")).toBe(true));

    act(() => tauriListeners.get("tauri://theme-changed")?.({ payload: "light" }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });

  it("shows Obsidian as a neutral local integration in Settings", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Remote Gateways" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Obsidian" })).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByText("CLI not enabled (optional)")).toBeInTheDocument();
  });

  it.runIf(import.meta.env.TAURI_ENV_PLATFORM === "darwin")("opens macOS Files & Folders settings from Data & Privacy", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Data & Privacy" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Files & Folders" }));

    await waitFor(() => expect(api.openFilesAndFoldersSettings).toHaveBeenCalledOnce());
  });

  it("collapses the sidebar completely and restores the preference", async () => {
    const first = render(<App />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Home" })).toHaveAttribute("data-tauri-drag-region"));
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.closest(".window-toolbar")).toHaveAttribute("data-tauri-drag-region");
    expect(collapse.closest(".brand")).toBeNull();
    fireEvent.click(collapse);
    expect(storage.get("agentkib.sidebar.collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand sidebar" }).closest(".window-toolbar")).toBeInTheDocument();
    first.unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument());
  });
});
