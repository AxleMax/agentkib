// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../core/api";
import { initializeI18n } from "../core/i18n";
import type { StorageNode, StorageOverview, WorkspaceSummary } from "../core/types";
import { WorkspaceStoragePage } from "./WorkspaceStoragePage";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../core/api", () => ({
  api: {
    storageOverview: vi.fn(),
    requestRefresh: vi.fn(),
    cancelStorageScan: vi.fn(),
    workspaceStorageChildren: vi.fn(),
    openWorkspaceStoragePath: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "workspace", path: "/tmp/workspace", name: "Workspace", status: "healthy",
  asset_count: 0, warning_count: 0, sources: [{ agent: "codex", evidence: "session-cwd", session_count: 1 }],
};

function node(name: string, relativePath: string, bytes: number, children: StorageNode[] = []): StorageNode {
  return {
    id: `directory:${relativePath}`,
    name,
    relative_path: relativePath,
    kind: relativePath ? "directory" : "workspace",
    allocated_bytes: bytes,
    logical_bytes: bytes,
    regenerable_bytes: relativePath.startsWith("target") ? bytes : 0,
    agent_asset_bytes: 0,
    file_count: 1,
    directory_count: children.length,
    child_count: children.length,
    children,
    expandable: children.length > 0,
    partial: false,
  };
}

const debug = node("debug", "target/debug", 600);
const target = node("target", "target", 600, [debug]);
const source = node("src", "src", 400);
const root = node("Workspace", "", 1_000, [target, source]);
const overview: StorageOverview = {
  total_workspace_count: 1,
  scanned_workspace_count: 1,
  allocated_bytes: 1_000,
  logical_bytes: 1_000,
  regenerable_bytes: 600,
  agent_asset_bytes: 0,
  last_scanned_at: new Date().toISOString(),
  workspaces: [{
    workspace_id: "workspace", name: "Workspace", path: "/tmp/workspace", snapshot_version: 2, root,
    measurement: "allocated-exact", quality: "complete", allocated_bytes: 1_000, logical_bytes: 1_000,
    regenerable_bytes: 600, agent_asset_bytes: 0, file_count: 2, directory_count: 2, breakdown: [],
    last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(),
  }],
};

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.mocked(api.storageOverview).mockResolvedValue(overview);
  vi.mocked(api.workspaceStorageChildren).mockResolvedValue(target);
  vi.mocked(api.openWorkspaceStoragePath).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceStoragePage", () => {
  it("drills from the virtual root into recursive directory nodes", async () => {
    render(<WorkspaceStoragePage workspaces={[workspace]} />);

    const workspaceTile = await screen.findByRole("treeitem", { name: /Workspace/ });
    fireEvent.doubleClick(workspaceTile);
    expect(await screen.findByRole("treeitem", { name: /target/ })).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole("treeitem", { name: /target/ }));
    expect(await screen.findByRole("treeitem", { name: /debug/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "target" })).toHaveAttribute("aria-current", "page");
  });

  it("selects a node without navigating and opens its inspector", async () => {
    render(<WorkspaceStoragePage workspaces={[workspace]} />);
    fireEvent.doubleClick(await screen.findByRole("treeitem", { name: /Workspace/ }));
    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));

    expect(await screen.findByText("Share of parent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in file manager" }));
    await waitFor(() => expect(api.openWorkspaceStoragePath).toHaveBeenCalledWith("workspace", "src"));
  });

  it("highlights search matches without removing non-matching tiles", async () => {
    render(<WorkspaceStoragePage workspaces={[workspace]} />);
    fireEvent.doubleClick(await screen.findByRole("treeitem", { name: /Workspace/ }));
    fireEvent.change(screen.getByPlaceholderText("Search names or relative paths"), { target: { value: "src" } });

    expect(screen.getByRole("treeitem", { name: /src/ })).toHaveClass("search-match");
    expect(screen.getByRole("treeitem", { name: /target/ })).toHaveClass("search-dim");
  });
});
