// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { ContextDoctorReport, WorkspaceSummary } from "@/core/types";
import { WorkspaceDoctorPage } from "./WorkspaceDoctorPage";

vi.mock("@/core/api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));

const workspace = { id: "workspace-1", name: "Workspace" } as WorkspaceSummary;
const report: ContextDoctorReport = {
  summary: {
    workspace_id: workspace.id,
    error_count: 0,
    warning_count: 0,
    info_count: 0,
    repairable_count: 0,
    checked_at: "2026-08-27T00:00:00Z",
  },
  matrix: [],
  issues: [],
};

describe("WorkspaceDoctorPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.mocked(api.workspaceDoctorReport).mockReset());
  afterEach(cleanup);

  it("records a successful diagnosis", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const onDiagnosed = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={onDiagnosed} />,
    );

    await waitFor(() => expect(onDiagnosed).toHaveBeenCalledWith(report.summary));
    expect(await screen.findByText("No deterministic configuration issues found")).toBeTruthy();
  });

  it("shows the one-time repair verification result", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, repairable_count: 2 },
    });

    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
        verification="applied"
      />,
    );

    expect(
      await screen.findByText("Repairs were applied and rechecked. 2 repairable issues remain."),
    ).toBeTruthy();
  });
});
