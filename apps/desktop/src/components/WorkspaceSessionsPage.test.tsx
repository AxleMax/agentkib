// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../api";
import type { ConversationSessionSummary, WorkspaceSummary } from "../types";
import { WorkspaceSessionsPage } from "./WorkspaceSessionsPage";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  path: "/tmp/workspace",
  name: "Workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};

const sessions: ConversationSessionSummary[] = [
  {
    id: "current",
    workspace_id: "workspace",
    agent: "codex",
    title: "Current task",
    updated_at: "2026-08-13T10:00:00Z",
    message_count: 3,
    archived: false,
    sidechain: false,
    availability: "readable",
  },
  {
    id: "archive",
    workspace_id: "workspace",
    agent: "claude-code",
    title: "Old task",
    updated_at: "2026-08-12T10:00:00Z",
    archived: true,
    sidechain: true,
    availability: "metadata-only",
  },
];

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.mocked(api.workspaceSessions).mockResolvedValue(sessions);
  vi.mocked(api.workspaceSessionStatus).mockResolvedValue([
    { workspace_id: "workspace", agent: "codex", freshness: "fresh", session_count: 1 },
    { workspace_id: "workspace", agent: "claude-code", freshness: "fresh", session_count: 1 },
  ]);
  vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue(sessions);
  vi.mocked(api.sessionEvents).mockResolvedValue({
    events: [
      { id: "message", kind: "user-message", content: "Visible message", attachment_count: 0, truncated: false },
      { id: "tool", kind: "tool-summary", tool_name: "Read", tool_status: "completed", attachment_count: 0, truncated: false },
    ],
    warnings: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSessionsPage", () => {
  it("defaults to readable current sessions and reads the selected transcript on demand", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled onRuntimeChanged={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Current task")).toBeInTheDocument());
    expect(screen.queryByText("Old task")).not.toBeInTheDocument();
    await waitFor(() => expect(api.sessionEvents).toHaveBeenCalledWith("current"));
    expect(await screen.findByText("Visible message")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows archived metadata-only sessions without trying to read a missing transcript", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled onRuntimeChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Current task")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.click(await screen.findByText("Old task"));

    expect(await screen.findByText("The original transcript is no longer available.")).toBeInTheDocument();
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  });

  it("separates indexed records from readable transcripts and links to metadata", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled onRuntimeChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Current task")).toBeInTheDocument());

    expect(screen.getByText("1 indexed · 1 readable")).toBeInTheDocument();
    expect(screen.getByText("1 indexed · 0 readable")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent filter"), { target: { value: "claude-code" } });

    expect(screen.getByRole("tab", { name: /Current 0/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Metadata only 1/ })).toBeInTheDocument();
    expect(screen.getByText("Historical records found: 1. Original transcripts are unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View metadata" }));
    expect(await screen.findByRole("button", { name: /Old task/ })).toBeInTheDocument();
  });

  it("does not access native history while indexing is disabled", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled={false} onRuntimeChanged={vi.fn()} />);

    expect(screen.getByText("Session indexing is disabled")).toBeInTheDocument();
    expect(api.workspaceSessions).not.toHaveBeenCalled();
  });
});
