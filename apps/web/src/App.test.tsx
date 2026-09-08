import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { Transcript, groupEvents, SafeMarkdown } from "@agentkib/session-ui";
import { WebClient, ApiError, type ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "./i18n";
const event = (
  id: string,
  kind: ConversationEvent["kind"],
  extra: Partial<ConversationEvent> = {},
): ConversationEvent => ({
  id,
  kind,
  attachment_count: 0,
  truncated: false,
  content: id,
  ...extra,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("safe transcript", () => {
  it("only folds explicit complete turns and leaves final/unclassified visible", () => {
    const events = [
      event("user", "user-message", { turn_id: "t" }),
      event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "t", tool_name: "exec" }),
      event("unknown", "agent-message", { turn_id: "t" }),
      event("final", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ];
    render(
      <Transcript
        events={events}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.queryByText("comment")).not.toBeInTheDocument();
    expect(screen.getByText("final")).toBeVisible();
    expect(screen.getByText("unknown")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Execution process/ }));
    expect(screen.getByText("comment")).toBeVisible();
  });
  it("keeps incomplete commentary and failed tools visible", () => {
    render(
      <Transcript
        events={[
          event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
          event("tool", "tool-summary", { turn_id: "t", tool_name: "exec", tool_status: "failed" }),
        ]}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.getByText("comment")).toBeVisible();
    expect(screen.getByRole("button", { name: /exec/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Execution process/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  it("does not group across unknown boundaries", () => {
    const result = groupEvents([
      event("a", "user-message", { turn_id: "t" }),
      event("b", "agent-message"),
      event("c", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ]);
    expect(result).toHaveLength(3);
    expect(result.every((g) => !g.complete)).toBe(true);
  });
  it("retains disclosure choice when earlier records complete a turn", () => {
    const end = [
      event("tool", "tool-summary", { turn_id: "t" }),
      event("final", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ];
    const { rerender } = render(
      <Transcript events={end} labels={dictionaries["en-US"]} onTool={() => {}} locale="en-US" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Execution process/ }));
    rerender(
      <Transcript
        events={[
          event("user", "user-message", { turn_id: "t" }),
          event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
          ...end,
        ]}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.getByText("comment")).toBeVisible();
  });
  it("does not load remote images or dangerous links", () => {
    const { container } = render(
      <SafeMarkdown
        text={
          "![tracker](https://tracker.example/a) [bad](javascript:alert(1)) [good](https://example.com) <script>alert(1)</script>"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  });
  it("does not fold commentary when paging warns about missing records", () => {
    const g = groupEvents(
      [
        event("u", "user-message", { turn_id: "t" }),
        event("c", "agent-message", { turn_id: "t", message_phase: "commentary" }),
        event("f", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
      ],
      true,
    );
    expect(g[0].segments[1].process).toBe(false);
  });
});
describe("browser client", () => {
  it("uses same origin cookies and CSRF without automatic mutation retries", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new WebClient(transport);
    client.csrfToken = "csrf";
    await client.request("send", { text: "hello" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": "csrf" },
    });
  });
  it("does not leak proxy HTML as error text", async () => {
    const c = new WebClient(
      vi.fn().mockResolvedValue(new Response("<html>secret</html>", { status: 503 })),
    );
    await expect(c.request("access")).rejects.toEqual(new ApiError(503, "request_failed"));
  });
  it("encodes cursor rather than accepting URL fragments", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    await new WebClient(fetcher).events("a&b", "c#d");
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/web/v1/events?sessionId=a%26b&limit=50&cursor=c%23d",
    );
  });
});
class FakeEvents {
  static instances: FakeEvents[] = [];
  listeners: Record<string, (e: Event) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEvents.instances.push(this);
  }
  addEventListener(name: string, fn: (e: Event) => void) {
    this.listeners[name] = fn;
  }
  emit(name: string, value: unknown) {
    this.listeners[name]?.(new MessageEvent(name, { data: JSON.stringify(value) }));
  }
}
function mockServer(initial = "approved") {
  let access = {
    status: initial,
    csrfToken: "x",
    bootId: "b",
    experimentalEnabled: false,
    device: { id: "d", name: "Browser", send: false, approve: false },
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/access")) return Response.json(access);
    if (path.includes("/catalog"))
      return Response.json({
        indexEnabled: true,
        sessions: [
          {
            id: "s",
            title: "Test session",
            workspace_id: "w",
            agent: "codex",
            availability: "readable",
          },
        ],
      });
    if (path.includes("/events"))
      return Response.json({ events: [event("Secret history", "agent-message")], warnings: [] });
    if (path.includes("/live"))
      return Response.json({
        sessionId: "s",
        status: "idle",
        revision: 1,
        sendEnabled: false,
        approvals: [],
      });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", FakeEvents);
  return {
    fetcher,
    setAccess: (value: typeof access) => {
      access = value;
    },
  };
}
describe("Web access UI", () => {
  it("shows the command directory and only owner-offered approval decisions", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: false, approve: true },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "running",
          revision: 2,
          sendEnabled: false,
          approvals: [
            {
              requestId: 42,
              turnId: "t",
              method: "item/commandExecution/requestApproval",
              cwd: "/tmp/qa",
              command: ["true"],
              supported: true,
              availableDecisions: ["accept", "cancel"],
            },
          ],
        });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    fireEvent.click(await screen.findByRole("button", { name: "等待审批" }));
    expect(screen.getByText("/tmp/qa")).toBeVisible();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消轮次" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
    act(() => FakeEvents.instances.at(-1)!.emit("access-ended", {}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("/tmp/qa")).toBeNull();
  });
  it("requires exactly eight digits and explains grant scope", async () => {
    mockServer("unpaired");
    render(<App />);
    await screen.findByText("用桌面端授权这个浏览器");
    const code = screen.getByLabelText("配对码");
    fireEvent.change(code, { target: { value: "123456" } });
    expect(screen.getByRole("button", { name: "请求连接" })).toBeDisabled();
    fireEvent.change(code, { target: { value: "12345678" } });
    expect(screen.getByRole("button", { name: "请求连接" })).toBeEnabled();
    expect(screen.getByText(/全部已登记及以后新增/)).toBeVisible();
  });
  it("does not offer control without independent grants", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    expect(await screen.findByText("Secret history")).toBeVisible();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: /停止|中断/ })).toBeNull();
  });
  it("clears history and dialogs immediately on access-ended", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    FakeEvents.instances.at(-1)!.emit("access-ended", {});
    await waitFor(() => expect(screen.queryByText("Secret history")).toBeNull());
    expect(screen.getByText("远程访问已结束")).toBeVisible();
  });
  it("clears private history when the stream reports unavailable", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    act(() => FakeEvents.instances.at(-1)!.emit("unavailable", {}));
    expect(screen.queryByText("Secret history")).toBeNull();
    expect(screen.queryByRole("button", { name: /Test session/ })).toBeNull();
  });
  it("clears history and catalog when indexing is disabled", async () => {
    const server = mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) =>
      String(url).endsWith("/catalog")
        ? Response.json({ sessions: [], indexEnabled: false })
        : original(url),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await screen.findByText("历史索引未开启");
    expect(screen.queryByText("Secret history")).toBeNull();
    expect(screen.queryByRole("button", { name: /Test session/ })).toBeNull();
  });
  it("provides all UI strings in four locales", () => {
    for (const words of Object.values(dictionaries)) {
      expect(Object.keys(words).sort()).toEqual(Object.keys(dictionaries["en-US"]).sort());
      expect(Object.values(words).every((v) => v.length > 0)).toBe(true);
    }
  });
  it("disables experimental sending immediately on stream disconnect", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    act(() => FakeEvents.instances.at(-1)!.onerror?.());
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
  it("never retries a failed send and marks outcome uncertain", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      if (String(url).endsWith("/send")) throw new TypeError("offline");
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/结果未确认/);
    expect(
      server.fetcher.mock.calls.filter((call) => String(call[0]).endsWith("/send")),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
