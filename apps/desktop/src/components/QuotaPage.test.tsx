// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../core/i18n";
import { QuotaPage } from "./QuotaPage";

const {
  listen,
  quotaSnapshot,
  quotaCollectorStatus,
  quotaPopoverPreferences,
  setQuotaPopoverPreferences,
  refreshQuota,
  refreshStatus,
  requestRefresh,
} = vi.hoisted(() => ({
  listen: vi.fn(),
  quotaSnapshot: vi.fn(),
  quotaCollectorStatus: vi.fn(),
  quotaPopoverPreferences: vi.fn(),
  setQuotaPopoverPreferences: vi.fn(),
  refreshQuota: vi.fn(),
  refreshStatus: vi.fn(),
  requestRefresh: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("../core/api", () => ({
  api: {
    quotaSnapshot,
    quotaCollectorStatus,
    quotaPopoverPreferences,
    setQuotaPopoverPreferences,
    refreshQuota,
    refreshStatus,
    requestRefresh,
  },
}));

beforeEach(async () => {
  await initializeI18n("en-US");
  listen.mockResolvedValue(() => undefined);
  quotaCollectorStatus.mockResolvedValue({
    backend: "codex-bar-cli",
    platform_supported: true,
    sidecar_available: true,
    config_source: "codexbar",
    running: false,
  });
  refreshStatus.mockResolvedValue([]);
  quotaPopoverPreferences.mockResolvedValue({ hidden_providers: [], hidden_windows: [] });
  setQuotaPopoverPreferences.mockImplementation(async (preferences) => preferences);
  requestRefresh.mockResolvedValue({
    kind: "quota",
    disposition: "queued",
    request_id: "quota-auto",
    status: {
      kind: "quota",
      state: "queued",
      request_id: "quota-auto",
      queued_at: "2026-08-14T02:00:00Z",
    },
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

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Claude Code");
    expect(screen.getByText("claude@example.com")).toBeInTheDocument();
    expect(await screen.findByText("8% remaining")).toBeInTheDocument();
  });

  it("filters providers that are near their limit", async () => {
    render(<QuotaPage />);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Near limit" }));

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab")).toHaveTextContent("Claude Code");
  });

  it("hides providers that AgentKib has not verified", async () => {
    quotaSnapshot.mockResolvedValue({
      schema_version: 1,
      backend: "codex-bar-cli",
      generated_at: "2026-08-14T02:00:00Z",
      fetched_at: "2026-08-14T02:00:00Z",
      stale_after_seconds: 180,
      freshness: "fresh",
      providers: [
        provider("codex", "Codex", 72, "codex@example.com"),
        provider("antigravity", "Antigravity", 60, "antigravity@example.com"),
        provider("gemini", "Gemini", 50, "gemini@example.com"),
        provider("kiro", "Kiro", 40, "kiro@example.com"),
      ],
    });

    render(<QuotaPage />);

    expect(await screen.findByRole("tab", { name: /Codex/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Antigravity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Gemini/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Kiro/ })).not.toBeInTheDocument();
  });

  it("restores an already queued quota refresh without starting another one", async () => {
    quotaSnapshot.mockResolvedValue(undefined);
    refreshStatus.mockResolvedValue([{ kind: "quota", state: "queued", request_id: "existing" }]);

    render(<QuotaPage />);

    expect(await screen.findAllByText("Preparing quota collection…")).toHaveLength(1);
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByRole("button", { name: "Refresh quota" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("requests a stale snapshot without forcing a duplicate collector", async () => {
    quotaSnapshot.mockResolvedValue({
      schema_version: 1,
      backend: "codex-bar-cli",
      generated_at: "2026-08-14T01:00:00Z",
      fetched_at: "2026-08-14T01:00:00Z",
      stale_after_seconds: 180,
      freshness: "stale",
      providers: [],
    });

    render(<QuotaPage />);

    await waitFor(() => expect(requestRefresh).toHaveBeenCalledWith("quota", false));
    expect(await screen.findByText("Preparing quota collection…")).toBeInTheDocument();
  });

  it("subscribes to refresh events before requesting an initial collection", async () => {
    quotaSnapshot.mockResolvedValue(undefined);

    render(<QuotaPage />);

    await waitFor(() => expect(requestRefresh).toHaveBeenCalledWith("quota", false));
    expect(listen).toHaveBeenCalledTimes(3);
    expect(listen.mock.invocationCallOrder[2]).toBeLessThan(
      requestRefresh.mock.invocationCallOrder[0],
    );
  });

  it("polls an active refresh and recovers when the terminal event was missed", async () => {
    quotaSnapshot.mockResolvedValue(undefined);
    refreshStatus
      .mockResolvedValueOnce([{ kind: "quota", state: "queued", request_id: "existing" }])
      .mockResolvedValueOnce([
        { kind: "quota", state: "failed", request_id: "existing", error: "collector failed" },
      ]);

    render(<QuotaPage />);

    expect(await screen.findByText("Preparing quota collection…")).toBeInTheDocument();
    expect(
      await screen.findByText("Quota refresh failed", {}, { timeout: 2_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("collector failed")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: "Refresh quota" })
        .every((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps valid windows visible when a provider reports partial data", async () => {
    const codex = provider("codex", "Codex", 72, "codex@example.com");
    quotaSnapshot.mockResolvedValue({
      schema_version: 1,
      backend: "codex-bar-cli",
      generated_at: "2026-08-14T02:00:00Z",
      fetched_at: "2026-08-14T02:00:00Z",
      stale_after_seconds: 180,
      freshness: "fresh",
      providers: [{ ...codex, error: "secondary endpoint unavailable" }],
    });

    render(<QuotaPage />);

    expect(await screen.findByText("72% remaining")).toBeInTheDocument();
    expect(screen.getByText("Some data is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Provider unavailable")).not.toBeInTheDocument();
  });

  it("configures menu bar windows without hiding them from the dashboard", async () => {
    render(<QuotaPage configurePopoverRequest={1} popoverSupported />);
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Menu bar display" })).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await waitFor(() => expect(setQuotaPopoverPreferences).toHaveBeenCalled());
    expect(screen.getByText("8% remaining")).toBeInTheDocument();
  });

  it("does not expose macOS popover settings on Linux", async () => {
    render(<QuotaPage configurePopoverRequest={1} popoverSupported={false} />);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Menu bar display" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Menu bar display" }),
    ).not.toBeInTheDocument();
  });
});

function provider(id: string, name: string, remaining: number, account: string) {
  return {
    id,
    name,
    enabled: true,
    source: "oauth",
    identity: { account_email: account, plan: "Pro" },
    windows: [
      {
        kind: "session",
        label: "5 hour",
        used_percent: 100 - remaining,
        remaining_percent: remaining,
        reset_at: "2026-08-14T05:00:00Z",
      },
    ],
    accounts: [],
  };
}
