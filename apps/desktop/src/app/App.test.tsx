// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { AppDialogProvider } from "../components/AppDialogProvider";
import { api } from "../core/api";
import { diffLines } from "../core/diff";
import { initializeI18n } from "../core/i18n";
import { open } from "@tauri-apps/plugin-dialog";
import type { RuntimeInfo } from "../core/types";

function testRuntime(trayAvailable: boolean): RuntimeInfo {
  return {
    data_dir: "/tmp/agentkib",
    database_path: "/tmp/agentkib/agentkib.db",
    mcp_package_root: "/tmp/agentkib/mcp",
    mcp_hub: { running: true, bind_address: "127.0.0.1", port: 47831, lan_enabled: false, accessible_addresses: ["127.0.0.1"], runtime_count: 0, error_count: 0 },
    mcp_network: { port: 47831, lan_enabled: false, lan_risk_accepted: false },
    close_behavior: "minimize-to-tray",
    locale_preference: "system",
    effective_locale: "en-US",
    theme_preference: "system",
    effective_theme: "dark",
    app_icon_preference: "white",
    tray_available: trayAvailable,
    session_index_enabled: true,
  };
}

const tauriListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
  tauriListeners.set(event, handler);
  return Promise.resolve(() => tauriListeners.delete(event));
}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../core/api", () => ({
  api: {
    workspaces: vi.fn().mockResolvedValue([]),
    agentInstallations: vi.fn().mockResolvedValue([]),
    workspaceDoctorSummaries: vi.fn().mockResolvedValue([]),
    workspaceDoctorReport: vi.fn(),
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
    runtime: vi.fn().mockResolvedValue({ close_behavior: "minimize-to-tray", locale_preference: "system", effective_locale: "en-US", theme_preference: "system", effective_theme: "dark", app_icon_preference: "white", session_index_enabled: true }),
    quitApp: vi.fn().mockResolvedValue(undefined),
    openFilesAndFoldersSettings: vi.fn().mockResolvedValue(undefined),
    setLocale: vi.fn().mockImplementation((locale: string) => Promise.resolve({ close_behavior: "minimize-to-tray", locale_preference: locale, effective_locale: locale === "system" ? "en-US" : locale, theme_preference: "system", effective_theme: "dark", app_icon_preference: "white" })),
    setThemePreference: vi.fn().mockImplementation((preference: string) => Promise.resolve({ close_behavior: "minimize-to-tray", locale_preference: "system", effective_locale: "en-US", theme_preference: preference, effective_theme: preference === "light" ? "light" : "dark", app_icon_preference: "white" })),
    setAppIconPreference: vi.fn().mockImplementation((preference: string) => Promise.resolve({ ...testRuntime(true), app_icon_preference: preference })),
    workspaceSessions: vi.fn().mockResolvedValue([]),
    refreshWorkspaceSessions: vi.fn().mockResolvedValue([]),
    sessionEvents: vi.fn().mockResolvedValue({ events: [], warnings: [] }),
    prepareSessionHandoff: vi.fn(),
    summarizeSessionHandoff: vi.fn(),
    planSessionHandoff: vi.fn(),
    continueSessionHandoff: vi.fn(),
    launchSessionHandoff: vi.fn(),
    workspaceSessionStatus: vi.fn().mockResolvedValue([]),
    clearSessionIndex: vi.fn().mockResolvedValue(undefined),
    setSessionIndexEnabled: vi.fn().mockImplementation((enabled: boolean) => Promise.resolve({ ...testRuntime(true), session_index_enabled: enabled })),
    workspaceOpeners: vi.fn().mockResolvedValue([{ id: "finder", name: "Finder", category: "file-manager", preferred: true }]),
    openWorkspaceWithApp: vi.fn().mockResolvedValue(undefined),
    workspaceGitSummary: vi.fn().mockResolvedValue(undefined),
    workspaceGitHistory: vi.fn().mockResolvedValue(undefined),
    gitCommitFiles: vi.fn().mockResolvedValue(undefined),
    gitDiff: vi.fn().mockResolvedValue(undefined),
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
    addWorkspace: vi.fn(),
    addScanRoot: vi.fn(),
    refreshWorkspace: vi.fn().mockResolvedValue(undefined),
    excludeWorkspace: vi.fn().mockResolvedValue(undefined),
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
    plan: vi.fn(),
    apply: vi.fn(),
  },
}));

const storage = new Map<string, string>();
const renderApp = () => render(<AppDialogProvider><App /></AppDialogProvider>);
const waitForHome = async () => {
  const home = await screen.findByRole("button", { name: "Home" });
  await waitFor(() => expect(home).toHaveAttribute("aria-current", "page"));
  return home;
};
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
  vi.mocked(api.workspaceDoctorSummaries).mockResolvedValue([]);
  vi.mocked(api.runtime).mockResolvedValue(testRuntime(true));
  vi.mocked(api.workspaceSessions).mockResolvedValue([]);
  vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
  vi.mocked(api.plan).mockReset();
  vi.mocked(api.apply).mockReset();
  vi.mocked(api.continueSessionHandoff).mockReset();
  vi.mocked(api.launchSessionHandoff).mockReset();
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

  it("applies a ChangeSet once and clears it after success", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy",
      asset_count: 0, warning_count: 0, sources: [],
    }]);
    vi.mocked(api.plan).mockResolvedValue({
      id: "change-set", project_root: "/tmp/project", created_at: "2026-08-18T00:00:00Z",
      requires_home_approval: false,
      changes: [{ target: "/tmp/project/AGENTS.md", scope: "project", before: "", after: "updated", risk: "low", validator: "markdown" }],
    });
    let finishApply!: () => void;
    vi.mocked(api.apply).mockImplementation(() => new Promise<void>((resolve) => { finishApply = resolve; }));

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));
    fireEvent.change(await screen.findByLabelText("Shared Project Instructions"), { target: { value: "updated" } });
    const review = screen.getByRole("button", { name: "Review changes" });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);

    const apply = await screen.findByRole("button", { name: "Apply 1 Changes" });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(api.apply).toHaveBeenCalledTimes(1);

    await act(async () => { finishApply(); });
    expect(await screen.findByText("No changes to apply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply 1 Changes" })).not.toBeInTheDocument();
  });

  it("ignores ChangeSet completion after leaving its workspace", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy",
      asset_count: 0, warning_count: 0, sources: [],
    }]);
    vi.mocked(api.plan).mockResolvedValue({
      id: "change-set", project_root: "/tmp/project", created_at: "2026-08-18T00:00:00Z",
      requires_home_approval: false,
      changes: [{ target: "/tmp/project/AGENTS.md", scope: "project", before: "", after: "updated", risk: "low", validator: "markdown" }],
    });
    let finishApply!: () => void;
    vi.mocked(api.apply).mockImplementation(() => new Promise<void>((resolve) => { finishApply = resolve; }));

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));
    fireEvent.change(await screen.findByLabelText("Shared Project Instructions"), { target: { value: "updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply 1 Changes" }));
    const scanCount = vi.mocked(api.scan).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitForHome();
    await act(async () => { finishApply(); });

    await waitForHome();
    expect(api.scan).toHaveBeenCalledTimes(scanCount);
  });

  it("renders structured ChangeSet errors instead of object coercion", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy",
      asset_count: 0, warning_count: 0, sources: [],
    }]);
    vi.mocked(api.plan).mockResolvedValue({
      id: "change-set", project_root: "/tmp/project", created_at: "2026-08-18T00:00:00Z",
      requires_home_approval: false,
      changes: [{ target: "/tmp/project/AGENTS.md", scope: "project", before: "", after: "updated", risk: "low", validator: "markdown" }],
    });
    vi.mocked(api.apply).mockRejectedValue({ key: "errors.generic", detail: "file hash changed" });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));
    fireEvent.change(await screen.findByLabelText("Shared Project Instructions"), { target: { value: "updated" } });
    const review = screen.getByRole("button", { name: "Review changes" });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: "Apply 1 Changes" }));

    const error = await screen.findByText(/file hash changed/);
    expect(error).not.toHaveTextContent("[object Object]");
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });

  it("applies a handoff once and retries only the Agent launch after partial success", async () => {
    const workspace = {
      id: "project", path: "/tmp/project", name: "Project", status: "healthy" as const,
      asset_count: 0, warning_count: 0, sources: [],
    };
    const launchRequest = { workspace_id: "project", filename: "handoff.md", target_agent: "claude-code" as const };
    const handoffChangeSet = {
      id: "handoff-change", project_root: "/tmp/project", created_at: "2026-08-18T00:00:00Z",
      requires_home_approval: false,
      changes: [{ target: "/tmp/project/.agentkib/handoffs/handoff.md", scope: "project" as const, before: "", after: "# Handoff", risk: "low" as const, validator: "markdown" }],
    };
    vi.mocked(api.workspaces).mockResolvedValue([workspace]);
    vi.mocked(api.agentInstallations).mockResolvedValue([{ agent: "claude-code", installed: true, configured: true, warnings: [] }]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([{
      id: "session", workspace_id: "project", agent: "codex", title: "Current task",
      archived: false, sidechain: false, availability: "readable",
    }]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([
      { workspace_id: "project", agent: "codex", freshness: "fresh", session_count: 1 },
      { workspace_id: "project", agent: "claude-code", freshness: "fresh", session_count: 0 },
    ]);
    vi.mocked(api.sessionEvents).mockResolvedValue({
      events: [{ id: "message", kind: "user-message", content: "Continue this", attachment_count: 0, truncated: false }], warnings: [],
    });
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
      status: "ready",
      draft: { filename: "handoff.md", format: "markdown", content: "# Handoff", redaction_count: 0, included_message_count: 1, omitted_tool_count: 0, context_source: "full-transcript", warnings: [] },
    });
    vi.mocked(api.planSessionHandoff).mockResolvedValue({ change_set: handoffChangeSet, launch_request: launchRequest });
    let finishContinuation!: (result: { status: "applied-launch-failed"; error: { key: string; detail: string } }) => void;
    vi.mocked(api.continueSessionHandoff).mockImplementation(() => new Promise((resolve) => { finishContinuation = resolve; }));
    vi.mocked(api.launchSessionHandoff).mockResolvedValue({ target_agent: "claude-code", terminal: "Terminal.app" });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Sessions" }));
    expect(await screen.findByText("Current task")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Create handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    expect(await screen.findByDisplayValue("# Handoff")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review save changes" }));

    const continueButton = await screen.findByRole("button", { name: "Apply and continue in Claude Code" });
    expect(screen.getByRole("button", { name: "Apply only" })).toBeInTheDocument();
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);
    expect(api.continueSessionHandoff).toHaveBeenCalledTimes(1);
    expect(api.apply).not.toHaveBeenCalled();

    await act(async () => finishContinuation({
      status: "applied-launch-failed",
      error: { key: "errors.handoff.launchAfterApplyFailed", detail: "Terminal unavailable" },
    }));
    expect(await screen.findByText("The handoff was saved, but the Agent could not be opened")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply and continue in Claude Code" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry opening Claude Code" }));
    await waitFor(() => expect(api.launchSessionHandoff).toHaveBeenCalledWith(launchRequest));
    expect(api.continueSessionHandoff).toHaveBeenCalledTimes(1);
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("opens the global asset center without forcing folder selection", async () => {
    renderApp();
    await waitForHome();
    expect(screen.getByText("No workspaces found")).toBeInTheDocument();
    expect(screen.queryByText("选择本地项目")).not.toBeInTheDocument();
  });

  it("keeps unavailable usage providers out of Home attention", async () => {
    vi.mocked(api.insightsStatus).mockResolvedValueOnce({
      running: false,
      providers: [{ agent: "open-claw", available: false, quality: "incomplete", imported_events: 0, error: "gateway offline" }],
    });
    renderApp();
    await waitForHome();
    expect(screen.getByText("Everything is in order")).toBeInTheDocument();
    expect(screen.queryByText("gateway offline")).not.toBeInTheDocument();
  });

  it("counts only Doctor errors and warnings on Home", async () => {
    vi.mocked(api.workspaces).mockResolvedValueOnce([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    vi.mocked(api.workspaceDoctorSummaries).mockResolvedValueOnce([{
      workspace_id: "project", error_count: 1, warning_count: 2, info_count: 9, repairable_count: 1, checked_at: "2026-08-18T00:00:00Z",
    }]);
    renderApp();
    const attention = await screen.findByText("Needs attention");
    expect(within(attention.closest("section")!).getByText("3")).toBeInTheDocument();
    expect(within(attention.closest("section")!).getByText("3 configuration warnings")).toBeInTheDocument();
  });

  it("discards a Doctor repair plan after switching workspaces", async () => {
    const firstWorkspace = {
      id: "first", path: "/tmp/first", name: "First", status: "attention" as const,
      asset_count: 0, warning_count: 1, sources: [],
    };
    const secondWorkspace = {
      id: "second", path: "/tmp/second", name: "Second", status: "healthy" as const,
      asset_count: 0, warning_count: 0, sources: [],
    };
    vi.mocked(api.workspaces).mockResolvedValue([firstWorkspace, secondWorkspace]);
    vi.mocked(api.scan).mockImplementation(async (path) => ({
      root: path, manifest_exists: true, agents: [], assets: [], warnings: [],
    }));
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      summary: { workspace_id: "first", error_count: 0, warning_count: 1, info_count: 0, repairable_count: 1, checked_at: "2026-08-18T00:00:00Z" },
      matrix: [],
      issues: [{ id: "missing", code: "managed.missing", severity: "warning", agent: "codex", asset_kind: "instruction", repairable: true, evidence: [{ path: "/tmp/first/AGENTS.md", detail: "missing" }] }],
    });
    let finishPlan!: (value: Awaited<ReturnType<typeof api.plan>>) => void;
    vi.mocked(api.plan).mockImplementation(() => new Promise((resolve) => { finishPlan = resolve; }));

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /First \/tmp\/first/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Doctor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review repairs" }));
    await waitFor(() => expect(api.plan).toHaveBeenCalledWith("/tmp/first", expect.anything(), false));

    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Workspaces" }));
    fireEvent.click(await screen.findByRole("button", { name: /Second.*\/tmp\/second/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument());
    await act(async () => finishPlan({
      id: "stale-repair", project_root: "/tmp/first", created_at: "2026-08-18T00:00:00Z",
      requires_home_approval: false,
      changes: [{ target: "/tmp/first/AGENTS.md", scope: "project", before: "", after: "fixed", risk: "low", validator: "markdown" }],
    }));

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
    expect(screen.queryByText("stale-repair")).not.toBeInTheDocument();
  });

  it("hides the empty recent activity panel and links every Home metric", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    renderApp();
    await waitForHome();
    expect(screen.queryByText("Recent Activity")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("queues manual discovery without replacing the cached workspace view", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspaces" })).toBeInTheDocument());
    vi.mocked(api.requestRefresh).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Refresh Discovery/i }));

    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("discovery", true));
    expect(screen.getByRole("button", { name: /Project.*\/tmp\/project/ })).toBeInTheDocument();
  });

  it("filters the workspace table and keeps row actions separate from navigation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.workspaces).mockResolvedValue([
      {
        id: "healthy-project", path: "/tmp/healthy", name: "Healthy Project", status: "healthy", asset_count: 0, warning_count: 0,
        last_active_at: "2026-08-13T10:00:00Z", sources: [{ agent: "codex", evidence: "session-cwd", session_count: 2 }],
      },
      {
        id: "attention-project", path: "/tmp/attention", name: "Attention Project", status: "attention", asset_count: 3, warning_count: 1,
        last_active_at: "2026-08-13T11:00:00Z", sources: [{ agent: "claude-code", evidence: "session-cwd", session_count: 1 }],
      },
    ]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*2/ }));

    expect(screen.getAllByText("2 workspaces")).toHaveLength(2);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    const healthyRow = screen.getByRole("row", { name: /Healthy Project/ });
    const attentionRow = screen.getByRole("row", { name: /Attention Project/ });
    expect(within(healthyRow).getByText("0")).toBeInTheDocument();
    expect(within(attentionRow).getByText("Needs attention")).toBeInTheDocument();
    expect(within(attentionRow).getByText("3")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "All Agents" }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    expect(screen.getAllByText("1 workspaces")).toHaveLength(2);
    expect(screen.queryByText("Healthy Project")).not.toBeInTheDocument();
    expect(screen.getByText("Attention Project")).toBeInTheDocument();

    vi.mocked(api.scan).mockClear();
    await user.click(screen.getByLabelText("Attention Project · More actions"));
    await user.click(await screen.findByRole("menuitem", { name: "Scan" }));
    await waitFor(() => expect(api.refreshWorkspace).toHaveBeenCalledWith("attention-project"));
    expect(api.scan).not.toHaveBeenCalled();
  });

  it("opens workspace storage from cache and only scans after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy", asset_count: 0, warning_count: 0, sources: [],
    }]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Workspaces\s*1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Space" }));

    expect(await screen.findByText("Workspace space has not been scanned")).toBeInTheDocument();
    expect(api.requestRefresh).not.toHaveBeenCalledWith("storage", true);
    await user.click(screen.getByRole("button", { name: "Start Scan" }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("storage", true));
  });

  it("defers discovery cache reads while the window is hidden", async () => {
    renderApp();
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
    renderApp();
    await waitForHome();
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
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Codex" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quota" }));
    expect(await screen.findByPlaceholderText("Search providers or accounts")).toBeInTheDocument();
    expect(screen.getByText("No quota snapshot yet")).toBeInTheDocument();
  });

  it("handles native menu navigation and Settings sections", async () => {
    renderApp();
    await waitFor(() => expect(tauriListeners.has("agentkib:navigate")).toBe(true));

    act(() => tauriListeners.get("agentkib:navigate")?.({ payload: { page: "agents" } }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();

    act(() => tauriListeners.get("agentkib:navigate")?.({ payload: { page: "settings", settings_section: "diagnostics" } }));
    expect(await screen.findByRole("heading", { name: "Quota collector" })).toBeInTheDocument();
  });

  it("reuses the existing workspace picker for native menu commands", async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    renderApp();
    await waitFor(() => expect(tauriListeners.has("agentkib:app-command")).toBe(true));

    act(() => tauriListeners.get("agentkib:app-command")?.({ payload: { command: "add-workspace" } }));

    await waitFor(() => expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "Add workspace manually" }));
  });

  it("maps native refresh commands to the active page", async () => {
    renderApp();
    await waitFor(() => expect(tauriListeners.has("agentkib:navigate")).toBe(true));
    act(() => tauriListeners.get("agentkib:navigate")?.({ payload: { page: "quota" } }));
    expect(await screen.findByRole("heading", { name: "Quota" })).toBeInTheDocument();
    vi.mocked(api.requestRefresh).mockClear();

    act(() => tauriListeners.get("agentkib:app-command")?.({ payload: { command: "refresh-current" } }));

    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("quota", true));
  });

  it("confirms before refreshing every data source from the native menu", async () => {
    renderApp();
    await waitFor(() => expect(tauriListeners.has("agentkib:app-command")).toBe(true));
    vi.mocked(api.requestRefresh).mockClear();

    act(() => tauriListeners.get("agentkib:app-command")?.({ payload: { command: "refresh-all" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledTimes(4));
    expect(api.requestRefresh).toHaveBeenCalledWith("discovery", true);
    expect(api.requestRefresh).toHaveBeenCalledWith("insights", true);
    expect(api.requestRefresh).toHaveBeenCalledWith("gateways", true);
    expect(api.requestRefresh).toHaveBeenCalledWith("quota", true);
  });

  it("does not count DeepSeek Harness residual data as an installation", async () => {
    vi.mocked(api.agentInstallations).mockResolvedValue([{
      agent: "deepseek-harness",
      installed: false,
      configured: true,
      home: "/tmp/.dsh",
      warnings: [],
    }]);
    renderApp();

    expect(await screen.findByRole("button", { name: "Installed Agents 0" })).toBeInTheDocument();
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
    renderApp();
    const project = await screen.findByRole("button", { name: /Project \/tmp\/project/ });
    fireEvent.click(project);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    const navigation = within(screen.getByRole("navigation", { name: "Primary navigation" }));
    expect(navigation.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
  });

  it("shows and clears the Git detail breadcrumb", async () => {
    vi.mocked(api.workspaces).mockResolvedValue([{
      id: "project", path: "/tmp/project", name: "Project", status: "healthy",
      asset_count: 0, warning_count: 0, sources: [],
    }]);
    vi.mocked(api.workspaceGitSummary).mockResolvedValue({
      repository_root: "/tmp/project", worktree_root: "/tmp/project", head: "main",
      head_oid: "cccccccc", ahead: 0, behind: 0, stash_count: 0, detached: false, refs: [], changes: [],
    });
    vi.mocked(api.workspaceGitHistory).mockResolvedValue({
      commits: [{ oid: "cccccccc", parents: [], subject: "Commit subject", author_name: "Test", authored_at: "2026-08-17T00:00:00Z", refs: [] }],
      repository_fingerprint: "fingerprint",
    });
    vi.mocked(api.gitCommitFiles).mockResolvedValue([]);
    vi.mocked(api.gitDiff).mockResolvedValue({ patch: "+change", binary: false, submodule: false, encoding_lossy: false, truncated: false });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Git" }));
    fireEvent.click(await screen.findByRole("option", { name: /Commit subject Test/ }));

    expect(await screen.findByText("Commit subject")).toBeInTheDocument();
    expect(screen.getByText("ccccccc")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Git" }));
    expect(await screen.findByPlaceholderText("Search commits or hashes")).toBeInTheDocument();
    expect(screen.queryByText("ccccccc")).not.toBeInTheDocument();
  });

  it("treats the native quit request as a real app exit", async () => {
    renderApp();
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
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Assets" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Shared Project Instructions" }), { target: { value: "Keep this draft" } });
    await waitFor(() => expect(tauriListeners.has("agentkib:quit-requested")).toBe(true));

    let quitRequest: Promise<void> | void = undefined;
    await act(async () => {
      quitRequest = tauriListeners.get("agentkib:quit-requested")?.({ payload: undefined });
      await Promise.resolve();
    });
    expect(await screen.findByText("Discard unsaved workspace drafts and quit AgentKib?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => { await quitRequest; });

    await waitFor(() => expect(api.quitApp).not.toHaveBeenCalled());
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
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /Project \/tmp\/project/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Interface" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Project" })).toBeInTheDocument();
  });

  it("shows token and commit achievements without a cloud account", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText(/120K Token/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Achievements" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument());
    expect(await screen.findByText("Activity Heatmap")).toBeInTheDocument();
    expect(screen.getAllByText("My Commits")).toHaveLength(2);
  });

  it("renders only the panels for the selected achievement section", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Achievements" }));
    expect(await screen.findByText("Activity Heatmap")).toBeInTheDocument();
    expect(screen.queryByText("Agent Usage")).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("tablist", { name: "Achievements" })).getByRole("tab", { name: "Token" }));
    expect(await screen.findByText("Agent Usage")).toBeInTheDocument();
    expect(screen.queryByText("Activity Heatmap")).not.toBeInTheDocument();
  });

  it("renders a unified achievement wall and opens track and secret details", async () => {
    const user = userEvent.setup();
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
    renderApp();
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
    await waitFor(() => expect(within(trackDialog).getByRole("button", { name: "Close" })).toHaveFocus());
    await user.tab({ shift: true });
    await waitFor(() => expect(within(trackDialog).getAllByRole("button")).toContain(document.activeElement));
    const nextMilestone = within(trackDialog).getByRole("button", { name: /Million Context/ });
    fireEvent.click(nextMilestone);
    expect(nextMilestone).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(tokenCard).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "View achievement details: Mystery Achievement" }));
    const secretDialog = screen.getByRole("dialog", { name: "Mystery Achievement" });
    expect(within(secretDialog).getByText("Unlock condition is secret")).toBeInTheDocument();
    expect(within(secretDialog).queryByText("Night Owl")).not.toBeInTheDocument();
    await user.click(document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    ["zh-CN", "没有发现可用工作区"],
    ["zh-TW", "找不到可用工作區"],
    ["ja-JP", "ワークスペースが見つかりません"],
    ["en-US", "No workspaces found"],
  ] as const)("renders the home empty state in %s", async (locale, emptyText) => {
    await initializeI18n(locale);
    renderApp();
    expect(await screen.findByText(emptyText)).toBeInTheDocument();
  });

  it("switches language immediately from Settings", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "简体中文" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "界面" })).toBeInTheDocument());
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("switches appearance immediately without leaving Settings", async () => {
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(screen.getByRole("navigation", { name: "Settings navigation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Interface" })).toBeInTheDocument();
    expect(api.setThemePreference).toHaveBeenCalledWith("light");
  });

  it("uses the white app icon by default and switches it from Settings", async () => {
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("button", { name: "White" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Black" }));

    await waitFor(() => expect(api.setAppIconPreference).toHaveBeenCalledWith("black"));
    expect(screen.getByRole("navigation", { name: "Settings navigation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Interface" })).toBeInTheDocument();
  });

  it("disables background hiding when the system tray is unavailable", async () => {
    const user = userEvent.setup();
    vi.mocked(api.runtime).mockResolvedValueOnce(testRuntime(false));
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText(/System tray unavailable/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: /When Closing the Window/i }));
    expect(await screen.findByRole("option", { name: /Hide in (Menu Bar|System Tray)/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("tracks macOS appearance changes only while following the system", async () => {
    renderApp();
    await waitFor(() => expect(tauriListeners.has("tauri://theme-changed")).toBe(true));

    act(() => tauriListeners.get("tauri://theme-changed")?.({ payload: "light" }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });

  it("shows Obsidian as a neutral local integration in Settings", async () => {
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Remote Gateways" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Obsidian" })).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByText("CLI not enabled (optional)")).toBeInTheDocument();
  });

  it.runIf(["darwin", "windows"].includes(import.meta.env.TAURI_ENV_PLATFORM))("opens system file access settings from Data & Privacy", async () => {
    renderApp();
    await waitForHome();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Data & Privacy" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Files & Folders" }));

    await waitFor(() => expect(api.openFilesAndFoldersSettings).toHaveBeenCalledOnce());
  });

  it("collapses the sidebar completely and restores the preference", async () => {
    const first = renderApp();
    await waitForHome();
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.closest("[data-tauri-drag-region]")).toHaveAttribute("data-tauri-drag-region", "true");
    expect(collapse.closest(".brand")).toBeNull();
    fireEvent.click(collapse);
    expect(storage.get("agentkib.sidebar.collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand sidebar" }).closest("[data-tauri-drag-region]")).toBeInTheDocument();
    first.unmount();
    renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument());
  });
});
