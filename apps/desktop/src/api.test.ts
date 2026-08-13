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

  it("keeps remote gateway credentials inside the native IPC boundary", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "gateway", state: "connected" });

    await api.saveRemoteGateway({ kind: "open-claw", name: "Server", url: "wss://gateway.test", auth_kind: "token", secret: "local-only" });

    expect(invoke).toHaveBeenCalledWith("save_remote_gateway", {
      input: { kind: "open-claw", name: "Server", url: "wss://gateway.test", auth_kind: "token", secret: "local-only" },
    });
  });
});
