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
});
