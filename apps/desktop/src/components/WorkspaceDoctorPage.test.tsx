// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { initializeI18n } from "../i18n";
import type { ContextDoctorReport, WorkspaceSummary } from "../types";
import { WorkspaceDoctorPage } from "./WorkspaceDoctorPage";

vi.mock("../api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));

const workspace: WorkspaceSummary = {
  id: "workspace",
  path: "/tmp/workspace",
  name: "Workspace",
  status: "attention",
  asset_count: 1,
  warning_count: 1,
  sources: [],
};

const report: ContextDoctorReport = {
  summary: { workspace_id: "workspace", error_count: 0, warning_count: 1, info_count: 0, repairable_count: 1, checked_at: "2026-08-18T00:00:00Z" },
  matrix: [{
    agent: "codex", detected: true, installed: true, enabled: true, writable: true,
    instructions: { status: "attention", expected: 1, actual: 0 },
    skills: { status: "healthy", expected: 0, actual: 0 },
    mcp: { status: "healthy", expected: 1, actual: 1 },
  }],
  issues: [{ id: "issue", code: "managed.missing", severity: "warning", agent: "codex", asset_kind: "instruction", repairable: true, evidence: [{ path: "/tmp/workspace/AGENTS.md", detail: "missing", expected: "abc", actual: undefined }] }],
};

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("WorkspaceDoctorPage", () => {
  it("renders deterministic evidence and plans project repairs", async () => {
    const onRepair = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={onRepair} />);

    expect(await screen.findByText("Managed file is missing")).toBeInTheDocument();
    expect(screen.getByText("/tmp/workspace/AGENTS.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review repairs" }));
    await waitFor(() => expect(onRepair).toHaveBeenCalled());
  });

  it("renders empty and error states", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValueOnce({
      ...report,
      summary: { ...report.summary, warning_count: 0, repairable_count: 0 },
      issues: [],
    });
    const { unmount } = render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} />);
    expect(await screen.findByText("No deterministic configuration issues found")).toBeInTheDocument();
    unmount();

    vi.mocked(api.workspaceDoctorReport).mockRejectedValueOnce(new Error("diagnosis failed"));
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} />);
    expect(await screen.findByText("Error: diagnosis failed")).toBeInTheDocument();
  });

  it("ignores a stale report after switching workspaces", async () => {
    let resolveFirst!: (value: ContextDoctorReport) => void;
    let resolveSecond!: (value: ContextDoctorReport) => void;
    const first = new Promise<ContextDoctorReport>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<ContextDoctorReport>((resolve) => { resolveSecond = resolve; });
    vi.mocked(api.workspaceDoctorReport)
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const nextWorkspace = { ...workspace, id: "other-workspace", name: "Other workspace" };
    const nextReport: ContextDoctorReport = {
      ...report,
      summary: { ...report.summary, workspace_id: nextWorkspace.id, warning_count: 0, repairable_count: 0 },
      issues: [],
    };
    const { rerender } = render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} />);

    rerender(<WorkspaceDoctorPage workspace={nextWorkspace} onRepair={vi.fn()} />);
    await act(async () => { resolveSecond(nextReport); });
    expect(await screen.findByText("No deterministic configuration issues found")).toBeInTheDocument();

    await act(async () => { resolveFirst(report); });
    await waitFor(() => expect(screen.queryByText("/tmp/workspace/AGENTS.md")).not.toBeInTheDocument());
    expect(api.workspaceDoctorReport).toHaveBeenNthCalledWith(1, workspace.id);
    expect(api.workspaceDoctorReport).toHaveBeenNthCalledWith(2, nextWorkspace.id);
  });
});
