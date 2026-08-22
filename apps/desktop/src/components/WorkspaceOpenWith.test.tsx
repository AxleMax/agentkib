// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../core/i18n";
import type { WorkspaceSummary } from "../core/types";
import { WorkspaceOpenWith } from "./WorkspaceOpenWith";
import { api } from "../core/api";

vi.mock("../core/api", () => ({
  api: {
    workspaceOpeners: vi.fn(),
    openWorkspaceWithApp: vi.fn(),
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

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.mocked(api.workspaceOpeners).mockResolvedValue([
    { id: "finder", name: "Finder", category: "file-manager", preferred: true },
    { id: "pycharm", name: "PyCharm", category: "editor", preferred: false },
  ]);
  vi.mocked(api.openWorkspaceWithApp).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceOpenWith", () => {
  it("opens with the preferred application from the main action", async () => {
    render(<WorkspaceOpenWith workspace={workspace} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Finder" }));
    await waitFor(() =>
      expect(api.openWorkspaceWithApp).toHaveBeenCalledWith("workspace", undefined),
    );
  });

  it("remembers a selected installed application", async () => {
    render(<WorkspaceOpenWith workspace={workspace} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose application" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "PyCharm" }));
    await waitFor(() =>
      expect(api.openWorkspaceWithApp).toHaveBeenCalledWith("workspace", "pycharm"),
    );
    expect(api.workspaceOpeners).toHaveBeenCalledTimes(2);
  });
});
