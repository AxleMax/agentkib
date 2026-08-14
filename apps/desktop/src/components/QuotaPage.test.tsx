// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { QuotaPage } from "./QuotaPage";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

const { quotaSnapshot, quotaCollectorStatus, refreshQuota } = vi.hoisted(() => ({
  quotaSnapshot: vi.fn(),
  quotaCollectorStatus: vi.fn(),
  refreshQuota: vi.fn(),
}));
vi.mock("../api", () => ({
  api: { quotaSnapshot, quotaCollectorStatus, refreshQuota },
}));

beforeEach(async () => {
  await initializeI18n("en-US");
  quotaCollectorStatus.mockResolvedValue({
    backend: "codex-bar-cli",
    platform_supported: true,
    sidecar_available: true,
    config_source: "codexbar",
    running: false,
  });
  quotaSnapshot.mockResolvedValue({
    schema_version: 1,
    backend: "codex-bar-cli",
    backend_version: "0.49.5",
    generated_at: "2026-08-14T02:00:00Z",
    fetched_at: "2026-08-14T02:00:00Z",
    stale_after_seconds: 180,
    freshness: "fresh",
    providers: [
      provider("codex", "Codex", 72, "codex@example.com"),
      provider("claude", "Claude Code", 8, "claude@example.com"),
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QuotaPage", () => {
  it("orders providers by remaining quota and preserves full account identity", async () => {
    render(<QuotaPage />);

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Claude Code");
    expect(screen.getByText("claude@example.com")).toBeInTheDocument();
    expect(await screen.findByText("8% remaining")).toBeInTheDocument();
  });

  it("filters providers that are near their limit", async () => {
    render(<QuotaPage />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Near limit" }));

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Claude Code");
  });
});

function provider(id: string, name: string, remaining: number, account: string) {
  return {
    id,
    name,
    enabled: true,
    source: "oauth",
    identity: { account_email: account, plan: "Pro" },
    windows: [{ kind: "session", label: "5 hour", used_percent: 100 - remaining, remaining_percent: remaining, reset_at: "2026-08-14T05:00:00Z" }],
    accounts: [],
  };
}
