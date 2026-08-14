import { describe, expect, it } from "vitest";
import { groupCatalogAssets, workspaceAssetCounts } from "./catalog";

describe("catalog presentation", () => {
  it("groups the same workspace asset while retaining every visible Agent", () => {
    const groups = groupCatalogAssets([
      { id: "1", scope: "workspace", workspace_id: "w", agent: "codex", kind: "instruction", name: "AGENTS.md", path: "/repo/AGENTS.md", summary: "", size: 10 },
      { id: "2", scope: "workspace", workspace_id: "w", agent: "claude-code", kind: "instruction", name: "AGENTS.md", path: "/repo/AGENTS.md", summary: "", size: 10 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].agents).toEqual(["codex", "claude-code"]);
    expect(workspaceAssetCounts(groups).get("w")).toBe(1);
  });
});
