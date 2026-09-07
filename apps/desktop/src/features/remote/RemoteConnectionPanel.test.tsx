// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, localizeMessage, tr } from "@/core/i18n";
import type { RemoteStatus } from "@/core/remote-types";
import { RemoteConnectionPanel, RemoteConnectionSettings } from "./RemoteConnectionPanel";
import { useRemoteStore } from "./remote-store";

const status: RemoteStatus = {
  local: { id: "local", name: "Desk", enabled: false, address: null },
  interfaces: [{ name: "Wi-Fi", address: "192.168.1.3" }],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const run = vi.fn();
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  run.mockReset();
  useRemoteStore.setState({
    snapshot: status,
    loading: false,
    busy: false,
    error: "",
    operationError: false,
    pairing: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    run,
  });
});
afterEach(cleanup);

describe("remote connections UI", () => {
  it("retranslates a displayed structured error in all four languages and still clears it", async () => {
    const failure = { key: "errors.generic", detail: "REMOTE_PAIRING_DENIED" };
    useRemoteStore.setState({ error: failure, operationError: true });
    render(<RemoteConnectionSettings />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(localizeMessage(failure));

    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("alert")).toBe(alert);
        expect(alert.textContent).toContain(localizeMessage(failure));
        expect(alert.textContent).toContain("REMOTE_PAIRING_DENIED");
        expect(useRemoteStore.getState().error).toBe(failure);
      }
      fireEvent.click(screen.getByRole("button", { name: tr("common.close") }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(useRemoteStore.getState().error).toBe("");
      expect(useRemoteStore.getState().operationError).toBe(false);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  it("translates an open pairing panel immediately without losing address/code input", async () => {
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    const address = screen.getByRole("textbox", { name: tr("remote.address") });
    fireEvent.change(address, { target: { value: "192.168.1.20:42987" } });
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("heading", { name: tr("settings.section.remote") })).toBeTruthy();
        expect(screen.getByRole("textbox", { name: tr("remote.address") })).toBe(address);
        expect((address as HTMLInputElement).value).toBe("192.168.1.20:42987");
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  it("does not optimistically authorize a failed approval or retry it during status polling", async () => {
    const pending = {
      id: "request",
      device_id: "device",
      name: "Laptop",
      verification: "321 654",
      expires_at: Date.now() / 1000 + 300,
    };
    useRemoteStore.setState({ snapshot: { ...status, pending: [pending] } });
    run.mockImplementation(async () => {
      useRemoteStore.setState({ error: "Approval failed" });
      return null;
    });
    render(<RemoteConnectionSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Digits match — approve" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Approval failed"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(useRemoteStore.getState().snapshot?.authorized).toEqual([]);
    expect(useRemoteStore.getState().snapshot?.pending).toEqual([pending]);
    expect(screen.getByText("321 654")).toBeTruthy();
  });
  it("does not expose a stale pairing code while sharing is off or after expiry", () => {
    const { rerender } = render(<RemoteConnectionSettings />);
    expect(screen.queryByRole("button", { name: "Generate new code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    useRemoteStore.setState({
      snapshot: {
        ...status,
        local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
        pairing_code: "87654321",
        pairing_expires_at: Date.now() / 1000 - 1,
      },
    });
    rerender(<RemoteConnectionSettings />);
    expect(screen.queryByText("87654321")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate new code" })).toBeTruthy();
  });
  it("shows sharing-disabled remote state without any message or execution controls", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        connections: [
          {
            id: "host",
            name: "Host",
            address: "192.168.1.5:42987",
            status: "sharing-disabled",
            last_seen: null,
            error: null,
          },
        ],
      },
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByText("Sharing is off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(send|stop|run|execute|approve)$/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
  });
  it("shares only after an explicit switch action with a private address and port", () => {
    render(<RemoteConnectionSettings />);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Allow local network access" }));
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: true,
      name: "Desk",
      address: "192.168.1.3:42987",
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
  it("shows one-time credentials using Unix seconds and requires host approval", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
        pairing_code: "87654321",
        pairing_expires_at: Date.now() / 1000 + 300,
        pending: [
          {
            id: "request",
            device_id: "device",
            name: "Laptop",
            verification: "321 654",
            expires_at: Date.now() / 1000 + 300,
          },
        ],
      },
    });
    render(<RemoteConnectionSettings />);
    expect(screen.getByText("87654321")).toBeTruthy();
    expect(screen.getByText(/including workspaces added later/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Digits match — approve" }));
    expect(run).toHaveBeenCalledWith({ operation: "approve", id: "request" });
  });
  it("pairs manually without enabling this device's sharing", async () => {
    run.mockResolvedValue({
      id: "host",
      verification: "123 456",
      status: "pending",
      expires_at: Date.now() / 1000 + 300,
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Host IPv4 address and port"), {
      target: { value: "192.168.1.5:42987" },
    });
    fireEvent.change(screen.getByLabelText("One-time pairing code"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair a host" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        operation: "pair",
        address: "192.168.1.5:42987",
        code: "12345678",
      }),
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("requires confirmation before revoking and offers no forced reconnect after identity change", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        authorized: [{ id: "device", name: "Laptop", approved_at: 1_700_000_000, last_seen: null }],
        connections: [
          {
            id: "host",
            name: "Host",
            address: "192.168.1.5:42987",
            status: "identity-changed",
            last_seen: null,
            error: null,
          },
        ],
      },
    });
    render(<RemoteConnectionSettings />);
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(run).toHaveBeenCalledWith({ operation: "revoke", id: "device" });
  });
});
