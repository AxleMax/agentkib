import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("AgentKib API boundary", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("normalizes omitted legacy connections in manifest drafts", async () => {
    vi.mocked(invoke).mockResolvedValue({
      schema_version: 2,
      workspace: { id: "workspace", name: "Workspace" },
      instructions: { shared: "", scoped: [], platform_overrides: {} },
      skills: [],
      mcp: { config: "mcp.json" },
      memories: { require_approval: true },
      adapters: {},
    });

    await expect(api.manifest("/tmp/workspace")).resolves.toMatchObject({ connections: [] });
    expect(invoke).toHaveBeenCalledWith("prepare_manifest", { project: "/tmp/workspace" });
  });

  it("keeps Obsidian linking explicit at the IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ workspace_id: "workspace", vault_path: "/Notes", target_path: "/Notes/Projects" });

    await api.linkWorkspaceToObsidian("workspace", "/Notes", "Projects");

    expect(invoke).toHaveBeenCalledWith("link_workspace_to_obsidian", {
      workspaceId: "workspace",
      vaultPath: "/Notes",
      relativeTarget: "Projects",
    });
  });

  it("sends theme preferences through the desktop preference boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ theme_preference: "light", effective_theme: "light" });

    await api.setThemePreference("light");

    expect(invoke).toHaveBeenCalledWith("set_theme_preference", { preference: "light" });
  });

  it("queues refresh work without waiting for collector results", async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: "insights", disposition: "queued", request_id: "refresh-1", status: { kind: "insights", state: "queued" } });

    await expect(api.requestRefresh("insights", true)).resolves.toMatchObject({ disposition: "queued" });

    expect(invoke).toHaveBeenCalledWith("request_refresh", { kind: "insights", force: true });
  });

  it("exposes quota refresh as a non-blocking IPC request", async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: "quota", disposition: "queued", request_id: "quota-1", status: { kind: "quota", state: "queued" } });

    await expect(api.refreshQuota()).resolves.toMatchObject({ kind: "quota", disposition: "queued" });

    expect(invoke).toHaveBeenCalledWith("refresh_quota");
  });

  it("keeps workspace storage scanning explicit", async () => {
    vi.mocked(invoke).mockResolvedValue({ total_workspace_count: 2, scanned_workspace_count: 0, workspaces: [] });

    await api.storageOverview();
    expect(invoke).toHaveBeenCalledWith("get_storage_overview");

    vi.mocked(invoke).mockResolvedValue({ kind: "storage", disposition: "queued", request_id: "storage-1", status: { kind: "storage", state: "queued" } });
    await api.requestRefresh("storage", true);
    expect(invoke).toHaveBeenCalledWith("request_refresh", { kind: "storage", force: true });
  });

  it("persists quota popover display preferences through desktop preferences", async () => {
    const preferences = {
      hidden_providers: ["claude"],
      hidden_windows: [{ provider_id: "codex", kind: "weekly", label: "Weekly" }],
    };
    vi.mocked(invoke).mockResolvedValue(preferences);

    await expect(api.setQuotaPopoverPreferences(preferences)).resolves.toEqual(preferences);

    expect(invoke).toHaveBeenCalledWith("set_quota_popover_preferences", { preferences });
  });

  it("opens the quota dashboard at an exact provider window", async () => {
    const window = { provider_id: "codex", account_id: "work", kind: "weekly", label: "Weekly" };
    vi.mocked(invoke).mockResolvedValue(undefined);

    await api.openQuotaDashboard("codex", window, false);

    expect(invoke).toHaveBeenCalledWith("open_quota_dashboard", {
      provider: "codex",
      window,
      configurePopover: false,
    });
  });

  it("keeps remote gateway credentials inside the native IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "gateway", state: "connected" });

    await api.saveRemoteGateway({ kind: "open-claw", name: "Server", url: "wss://gateway.test", auth_kind: "token", secret: "local-only" });

    expect(invoke).toHaveBeenCalledWith("save_remote_gateway", {
      input: { kind: "open-claw", name: "Server", url: "wss://gateway.test", auth_kind: "token", secret: "local-only" },
    });
  });
});
