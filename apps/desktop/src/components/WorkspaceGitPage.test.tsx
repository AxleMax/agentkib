// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { initializeI18n } from "../i18n";
import type { GitCommitSummary, GitDiff, GitWorkspaceSummary, WorkspaceSummary } from "../types";
import { layoutCommitGraph, WorkspaceGitPage } from "./WorkspaceGitPage";

vi.mock("../api", () => ({
  api: {
    workspaceGitSummary: vi.fn(),
    workspaceGitHistory: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitDiff: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "workspace", path: "/tmp/workspace", name: "Workspace", status: "healthy",
  asset_count: 0, warning_count: 0, sources: [],
};

const summary: GitWorkspaceSummary = {
  repository_root: "/tmp/workspace", worktree_root: "/tmp/workspace", head: "main", head_oid: "c",
  ahead: 0, behind: 0, stash_count: 0, detached: false, refs: [], changes: [],
};

const fullDiff: GitDiff = {
  patch: "diff --git a/one.txt b/one.txt\n+full patch",
  binary: false, submodule: false, encoding_lossy: false, truncated: false,
};

function commit(oid: string, parents: string[]): GitCommitSummary {
  return { oid, parents, subject: oid, author_name: "Test", authored_at: "2026-08-17T00:00:00Z", refs: [] };
}

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.mocked(api.workspaceGitSummary).mockResolvedValue(summary);
  vi.mocked(api.workspaceGitHistory).mockResolvedValue({ commits: [commit("c", ["b"])], repository_fingerprint: "fingerprint" });
  vi.mocked(api.gitCommitFiles).mockResolvedValue([{ status: "M", path: "one.txt" }]);
  vi.mocked(api.gitDiff).mockResolvedValue(fullDiff);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("layoutCommitGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutCommitGraph([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.every((row) => row.lanes === 1)).toBe(true);
  });

  it("creates and rejoins lanes for a merge", () => {
    const rows = layoutCommitGraph([
      commit("merge", ["main", "feature"]),
      commit("main", ["base"]),
      commit("feature", ["base"]),
      commit("base", []),
    ]);
    expect(rows[0].edges).toHaveLength(2);
    expect(Math.max(...rows.map((row) => row.lanes))).toBeGreaterThan(1);
    expect(rows[3].lane).toBe(0);
  });
});

describe("WorkspaceGitPage Diff", () => {
  it("loads the complete commit Diff by default and switches to a file Diff", async () => {
    vi.mocked(api.gitDiff).mockImplementation(async (_workspaceId, request) => request.path
      ? { ...fullDiff, patch: `single:${request.path}` }
      : fullDiff);

    render(<WorkspaceGitPage workspace={workspace} />);

    fireEvent.click(await screen.findByRole("option", { name: /c Test/ }));
    await waitFor(() => expect(api.gitDiff).toHaveBeenCalledWith("workspace", { kind: "commit", oid: "c", path: undefined }));
    expect(await screen.findByText("+full patch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All changes/ })).toHaveClass("active");

    fireEvent.click(await screen.findByRole("button", { name: /one.txt/ }));
    await waitFor(() => expect(api.gitDiff).toHaveBeenLastCalledWith("workspace", { kind: "commit", oid: "c", path: "one.txt" }));
    expect(await screen.findByText("single:one.txt")).toBeInTheDocument();
  });

  it("keeps the complete Diff visible when the file list fails", async () => {
    vi.mocked(api.gitCommitFiles).mockRejectedValue(new Error("file list failed"));

    render(<WorkspaceGitPage workspace={workspace} />);

    fireEvent.click(await screen.findByRole("option", { name: /c Test/ }));
    expect(await screen.findByText("+full patch")).toBeInTheDocument();
    expect(await screen.findByText("File changes could not be loaded")).toBeInTheDocument();
  });

  it("shows a retryable error instead of an endless loading state", async () => {
    vi.mocked(api.gitDiff).mockRejectedValueOnce(new Error("diff failed")).mockResolvedValueOnce(fullDiff);

    render(<WorkspaceGitPage workspace={workspace} />);

    fireEvent.click(await screen.findByRole("option", { name: /c Test/ }));
    expect(await screen.findByText("Diff could not be loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("+full patch")).toBeInTheDocument();
  });

  it("ignores an older Diff response after selecting another commit", async () => {
    let resolveFirst: ((value: GitDiff) => void) | undefined;
    const first = new Promise<GitDiff>((resolve) => { resolveFirst = resolve; });
    vi.mocked(api.workspaceGitHistory).mockResolvedValue({ commits: [commit("c", ["b"]), commit("b", ["a"])], repository_fingerprint: "fingerprint" });
    vi.mocked(api.gitDiff)
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ...fullDiff, patch: "newer commit patch" });

    render(<WorkspaceGitPage workspace={workspace} />);
    fireEvent.click(await screen.findByRole("option", { name: /c Test/ }));
    await waitFor(() => expect(api.gitDiff).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Back to Git" }));
    fireEvent.click(screen.getByRole("option", { name: /b Test/ }));
    expect(await screen.findByText("newer commit patch")).toBeInTheDocument();
    resolveFirst?.({ ...fullDiff, patch: "stale patch" });
    await Promise.resolve();
    expect(screen.queryByText("stale patch")).not.toBeInTheDocument();
  });

  it("keeps list filters when returning from a commit detail", async () => {
    render(<WorkspaceGitPage workspace={workspace} />);
    const search = await screen.findByPlaceholderText("Search commits or hashes");
    fireEvent.change(search, { target: { value: "c" } });
    fireEvent.click(screen.getByRole("option", { name: /c Test/ }));
    expect(await screen.findByRole("button", { name: "Back to Git" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Git" }));
    expect(screen.getByPlaceholderText("Search commits or hashes")).toHaveValue("c");
  });

  it("restores the commit list scroll position after returning", async () => {
    render(<WorkspaceGitPage workspace={workspace} />);
    const list = await screen.findByRole("listbox", { name: "Commit History" });
    list.scrollTop = 180;
    fireEvent.click(screen.getByRole("option", { name: /c Test/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to Git" }));
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Commit History" }).scrollTop).toBe(180));
  });

  it("returns to the Git list with Escape", async () => {
    render(<WorkspaceGitPage workspace={workspace} />);
    fireEvent.click(await screen.findByRole("option", { name: /c Test/ }));
    expect(await screen.findByRole("button", { name: "Back to Git" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByPlaceholderText("Search commits or hashes")).toBeInTheDocument();
  });

  it("keeps staged and unstaged files in separate worktree details", async () => {
    vi.mocked(api.workspaceGitSummary).mockResolvedValue({
      ...summary,
      changes: [
        { path: "staged.txt", kind: "modified", index_status: "M", conflicted: false },
        { path: "unstaged.txt", kind: "modified", worktree_status: "M", conflicted: false },
      ],
    });
    render(<WorkspaceGitPage workspace={workspace} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Working Tree/ }));
    fireEvent.click(screen.getAllByText("staged.txt")[0].closest("button")!);

    await waitFor(() => expect(api.gitDiff).toHaveBeenLastCalledWith("workspace", { kind: "staged", path: "staged.txt" }));
    expect(screen.getByText("All staged changes")).toBeInTheDocument();
    expect(screen.queryByText("unstaged.txt")).not.toBeInTheDocument();
  });

  it("does not request a fabricated Diff for an untracked file", async () => {
    vi.mocked(api.workspaceGitSummary).mockResolvedValue({
      ...summary,
      changes: [{ path: "new.txt", kind: "untracked", worktree_status: "?", conflicted: false }],
    });
    render(<WorkspaceGitPage workspace={workspace} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Working Tree/ }));
    fireEvent.click(screen.getAllByText("new.txt")[0].closest("button")!);

    expect(await screen.findByText("Untracked files do not have a Git Diff yet")).toBeInTheDocument();
    expect(api.gitDiff).not.toHaveBeenCalled();
  });
});
