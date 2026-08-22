// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../core/i18n";
import { QuotaPopover } from "./QuotaPopover";

const {
  listen,
  quotaSnapshot,
  quotaPopoverPreferences,
  refreshStatus,
  requestRefresh,
  refreshQuota,
  openQuotaDashboard,
  runtime,
  hide,
} = vi.hoisted(() => ({
  listen: vi.fn(),
  quotaSnapshot: vi.fn(),
  quotaPopoverPreferences: vi.fn(),
  refreshStatus: vi.fn(),
  requestRefresh: vi.fn(),
  refreshQuota: vi.fn(),
  openQuotaDashboard: vi.fn(),
  runtime: vi.fn(),
  hide: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide }) }));
vi.mock("../core/api", () => ({
  api: {
    quotaSnapshot,
    quotaPopoverPreferences,
    refreshStatus,
    requestRefresh,
    refreshQuota,
    openQuotaDashboard,
    runtime,
  },
}));

beforeEach(async () => {
  await initializeI18n("en-US");
  listen.mockResolvedValue(() => undefined);
  refreshStatus.mockResolvedValue([]);
  quotaPopoverPreferences.mockResolvedValue({ hidden_providers: ["claude"], hidden_windows: [] });
  runtime.mockResolvedValue({ effective_locale: "en-US", effective_theme: "light" });
  quotaSnapshot.mockResolvedValue({
    schema_version: 1,
    backend: "codex-bar-cli",
    generated_at: "2026-08-14T02:00:00Z",
    fetched_at: "2026-08-14T02:00:00Z",
    stale_after_seconds: 300,
    freshness: "fresh",
    providers: [
      provider("codex", "Codex", 72),
      provider("claude", "Claude", 8),
      provider("gemini", "Gemini", 50),
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QuotaPopover", () => {
  it("shows only enabled providers with usable windows", async () => {
    render(<QuotaPopover />);

    expect(await screen.findByRole("tab", { name: /Codex/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Claude/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Gemini/ })).not.toBeInTheDocument();
    expect(await screen.findByText("72% remaining")).toBeInTheDocument();
  });

  it("opens the main dashboard at the selected window", async () => {
    render(<QuotaPopover />);
    const window = await screen.findByRole("button", { name: /5 hour/ });

    fireEvent.click(window);

    await waitFor(() =>
      expect(openQuotaDashboard).toHaveBeenCalledWith(
        "codex",
        {
          provider_id: "codex",
          account_id: undefined,
          kind: "session",
          label: "5 hour",
        },
        false,
      ),
    );
  });

  it("hides when Escape is pressed", async () => {
    render(<QuotaPopover />);
    await screen.findByRole("tab", { name: /Codex/ });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(hide).toHaveBeenCalledOnce();
  });
});

function provider(id: string, name: string, remaining: number) {
  return {
    id,
    name,
    enabled: true,
    identity: { account_email: `${id}@example.com` },
    windows: [
      {
        kind: "session",
        label: "5 hour",
        used_percent: 100 - remaining,
        remaining_percent: remaining,
      },
    ],
    accounts: [],
  };
}
