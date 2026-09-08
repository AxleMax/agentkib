// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, ServerResponse } from "node:http";
import { WebAccessService } from "./service";

describe("WebAccessService loopback security boundary", () => {
  let dir: string;
  let service: WebAccessService;
  let origin: string;
  let port: number;
  let cookie: string;
  let csrf: string;
  let bootId: string;
  const runtime = vi.fn(async (_params: unknown): Promise<unknown> => ({
    runtimeBootId: "runtime-one",
    revision: 4,
    sendEnabled: true,
    events: [],
  }));
  async function http(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
      json: () => Record<string, any>;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method || "GET",
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.body !== undefined
              ? { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf }
              : {}),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body,
              json: () => JSON.parse(body),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  }
  async function bootstrap() {
    const result = await http("/api/web/v1/access");
    cookie = result.headers["set-cookie"]![0].split(";")[0];
    csrf = result.json().csrfToken;
    bootId = result.json().bootId;
    return result;
  }
  async function pair(send = false, approve = false) {
    const admin = await service.request({ operation: "generate-code" });
    const paired = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: admin.code!.value, name: "Test browser" },
    });
    expect(paired.status).toBe(200);
    const id = paired.json().pending.id;
    await service.request({ operation: "approve", id, send, approve });
    return id;
  }
  beforeEach(async () => {
    runtime.mockReset();
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: true,
      events: [],
    });
    cookie = "";
    csrf = "";
    bootId = "";
    dir = await mkdtemp(join(tmpdir(), "agentkib-web-unit-"));
    await writeFile(join(dir, "index.html"), "<html>local web</html>");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      verifiedExperimental: true,
    });
    await service.initialize();
    expect((await service.request({ operation: "status" })).running).toBe(false);
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("requires pairing, same origin and CSRF; exposes no arbitrary runtime methods", async () => {
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    const access = await bootstrap();
    expect(access.headers["set-cookie"]![0]).toContain("HttpOnly; SameSite=Strict");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: {},
          headers: { Origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: {},
          headers: { "X-CSRF-Token": "bad" },
        })
      ).status,
    ).toBe(403);
    expect((await http("/", { headers: { Host: "evil.test" } })).status).toBe(403);
    expect((await http("/", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    await pair();
    expect((await http("/api/web/v1/catalog")).status).toBe(200);
    expect(
      (await http("/api/web/v1/rpc", { method: "POST", body: { method: "delete_everything" } }))
        .status,
    ).toBe(404);
    expect(runtime).toHaveBeenCalledTimes(1);
    expect((await http("/api/web/v1/events?sessionId=x&limit=10000")).status).toBe(400);
  });
  it("requires desktop confirmation, persists only hashed credentials, and revokes access", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    expect(status.code!.value).toMatch(/^\d{8}$/);
    const result = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: status.code!.value, name: "Phone" },
    });
    expect((await http("/api/web/v1/access")).json().status).toBe("pending");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    const id = result.json().pending.id;
    await service.request({ operation: "approve", id, send: false, approve: false });
    const saved = await readFile(join(dir, "web-access.json"), "utf8");
    expect(saved).not.toContain(cookie.split("=")[1]);
    expect(saved).not.toContain(csrf);
    expect((await http("/api/web/v1/access")).json().status).toBe("approved");
    await service.request({ operation: "revoke", id });
    expect((await http("/api/web/v1/access")).json().status).toBe("ended");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
  });
  it("fails closed after five incorrect pairing attempts and on desktop rejection", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    for (let i = 0; i < 5; i++)
      expect(
        (await http("/api/web/v1/pair", { method: "POST", body: { code: "wrong", name: "Phone" } }))
          .status,
      ).toBe(403);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: status.code!.value, name: "Phone" },
        })
      ).status,
    ).toBe(429);
    cookie = "";
    await bootstrap();
    await service.request({ operation: "generate-code" });
    const next = await service.request({ operation: "status" });
    const result = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: next.code!.value, name: "Phone" },
    });
    await service.request({ operation: "reject", id: result.json().pending.id });
    expect((await http("/api/web/v1/access")).json().status).toBe("ended");
  });
  it("isolates send/approve permissions and prevents duplicate or stale control requests", async () => {
    await bootstrap();
    await pair(true, false);
    const body = {
      sessionId: "session",
      text: "hello",
      requestId: "one",
      bootId,
      expectedRevision: 4,
    };
    expect(
      (
        await http("/api/web/v1/approve", {
          method: "POST",
          body: { ...body, turnId: "t", approvalId: "a", decision: "accept" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, bootId: "old" } })).status,
    ).toBe(409);
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...body, expectedRevision: 3, requestId: "stale" },
        })
      ).status,
    ).toBe(409);
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send", runtimeBootId: "runtime-one", text: "hello" }),
    );
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
    service.runtimeUnavailable();
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "new" } }))
        .status,
    ).toBe(409);
  });
  it("rejects concurrent control and withholds results after authorization is revoked", async () => {
    await bootstrap();
    const id = await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "runtime-one", revision: 4, sendEnabled: true },
    );
    const body = {
      sessionId: "session",
      text: "hello",
      requestId: "one",
      bootId,
      expectedRevision: 4,
    };
    const first = http("/api/web/v1/send", { method: "POST", body });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "two" } }))
        .status,
    ).toBe(409);
    await service.request({ operation: "revoke", id });
    finish({ ok: true });
    expect((await first).status).toBe(401);
  });
  it("blocks traversal and escaping symlinks and serves local assets without a dev server", async () => {
    expect((await http("/")).body).toContain("local web");
    expect((await http("/%2e%2e/secrets")).status).toBe(403);
    await symlink(join(dir, ".."), join(dir, "escape"));
    expect((await http(`/escape/${dir.split("/").at(-1)}/index.html`)).status).toBe(200);
    await symlink("/etc/hosts", join(dir, "outside"));
    expect((await http("/outside")).status).toBe(403);
  });
  it("uses configured external HTTPS origin, never trusts forwarded headers", async () => {
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "https://web.example",
      experimentalEnabled: false,
    });
    const result = await http("/api/web/v1/access", { headers: { Host: "web.example" } });
    expect(result.headers["set-cookie"]![0]).toContain("; Secure");
    expect(
      (await http("/", { headers: { Host: "evil.example", "X-Forwarded-Host": "web.example" } }))
        .status,
    ).toBe(403);
  });
  it("preserves approved credentials across restart but invalidates control boot", async () => {
    await bootstrap();
    await pair(true);
    const oldBoot = bootId;
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      verifiedExperimental: true,
    });
    await service.initialize();
    const access = await http("/api/web/v1/access");
    expect(access.json().status).toBe("approved");
    expect(access.json().bootId).not.toBe(oldBoot);
    csrf = access.json().csrfToken;
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: {
            sessionId: "s",
            text: "x",
            requestId: "old",
            bootId: oldBoot,
            expectedRevision: 4,
          },
        })
      ).status,
    ).toBe(409);
    expect(runtime).not.toHaveBeenCalled();
  });
  it("closes SSE immediately on revoke and never forwards subsequent snapshots", async () => {
    await bootstrap();
    const id = await pair();
    const chunks: string[] = [];
    let first!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      first = resolve;
    });
    const ended = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=s",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.on("data", (chunk) => {
            chunks.push(String(chunk));
            if (String(chunk).includes("event: snapshot")) first();
          });
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
    await snapshot;
    await service.request({ operation: "revoke", id });
    await ended;
    expect(chunks.join("")).toContain("event: access-ended");
    expect(runtime).toHaveBeenCalledTimes(1);
  });
  it("expires pairing codes and enforces bounded bodies", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    try {
      expect((await service.request({ operation: "status" })).code).toBeUndefined();
    } finally {
      now.mockRestore();
    }
    cookie = "";
    await bootstrap();
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: status.code!.value, name: "Phone" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: "1", name: "x".repeat(70_000) },
        })
      ).status,
    ).toBe(413);
  });
  it("keeps secure and insecure credentials isolated", async () => {
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "https://web.example",
      experimentalEnabled: false,
    });
    await bootstrap();
    await pair();
    const external = await http("/api/web/v1/access", { headers: { Host: "web.example" } });
    expect(external.json().status).toBe("unpaired");
    const secureCookie = external.headers["set-cookie"]![0].split(";")[0];
    expect(secureCookie).toMatch(/^ak_web_secure=/);
    const local = await http("/api/web/v1/access", { headers: { Cookie: secureCookie } });
    expect(local.json().status).toBe("unpaired");
    expect((await http("/api/web/v1/catalog", { headers: { Host: "web.example" } })).status).toBe(
      401,
    );
  });
  it("rejects unavailable send and only forwards exact supported numeric approvals", async () => {
    await bootstrap();
    await pair(true, true);
    const body = { sessionId: "s", text: "x", requestId: "disabled", bootId, expectedRevision: 4 };
    runtime.mockResolvedValue({
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      approvals: [
        {
          requestId: 860,
          turnId: "turn",
          supported: true,
          availableDecisions: ["accept", "cancel"],
        },
      ],
    });
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
    const approval = {
      ...body,
      requestId: "decline",
      turnId: "turn",
      approvalId: 860,
      decision: "decline",
    };
    expect((await http("/api/web/v1/approve", { method: "POST", body: approval })).status).toBe(
      409,
    );
    expect(
      (
        await http("/api/web/v1/approve", {
          method: "POST",
          body: { ...approval, requestId: "accept", decision: "accept" },
        })
      ).status,
    ).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "approve", approvalId: 860, decision: "accept" }),
    );
  });
  it("rechecks revoked grants between live read and mutation dispatch", async () => {
    await bootstrap();
    const id = await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await service.request({ operation: "revoke", id });
    finish({ runtimeBootId: "runtime-one", revision: 4, sendEnabled: true });
    expect((await pending).status).toBe(401);
    expect(runtime).toHaveBeenCalledTimes(1);
  });
  it("invalidates in-flight read/control success after runtime disconnect", async () => {
    await bootstrap();
    await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = http("/api/web/v1/live?sessionId=s");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    service.runtimeUnavailable();
    finish({ runtimeBootId: "old", revision: 4 });
    expect((await pending).status).toBe(409);
    const access = await http("/api/web/v1/access");
    bootId = access.json().bootId;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "new", revision: 4, sendEnabled: true },
    );
    finish = undefined!;
    const send = http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    service.runtimeUnavailable();
    finish({ accepted: true });
    expect((await send).status).toBe(409);
  });
  it("retains unknown outcome after timeout, late success and runtime restart", async () => {
    await bootstrap();
    await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "r", revision: 4, sendEnabled: true },
    );
    const body = { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 };
    const timeout = await http("/api/web/v1/send", { method: "POST", body });
    expect(timeout.status).toBe(504);
    expect(timeout.json().error).toBe("outcome_unknown");
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "r2" } }))
        .status,
    ).toBe(409);
    finish({ accepted: true });
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
    service.runtimeUnavailable();
    const access = await http("/api/web/v1/access");
    const next = await http("/api/web/v1/send", {
      method: "POST",
      body: { ...body, requestId: "after-restart", bootId: access.json().bootId },
    });
    expect(next.status).toBe(409);
    expect(next.json().error).toBe("outcome_unknown");
    const live = await http("/api/web/v1/live?sessionId=s");
    expect(live.json()).toMatchObject({
      status: "outcome-unknown",
      sendEnabled: false,
      approvals: [],
    });
    expect(
      runtime.mock.calls.filter(([p]) => (p as { operation: string }).operation === "send"),
    ).toHaveLength(1);
  }, 30_000);
  it("retains failed dispatch protection when the runtime recovers with a fresh idle snapshot", async () => {
    await bootstrap();
    await pair(true, true);
    runtime.mockImplementation(async (p) => {
      if ((p as { operation: string }).operation === "send")
        throw new Error("runtime disconnected");
      return { runtimeBootId: "new-runtime", revision: 4, sendEnabled: true, approvals: [] };
    });
    const body = { sessionId: "s", text: "x", requestId: "first", bootId, expectedRevision: 4 };
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(500);
    service.runtimeUnavailable();
    const freshBoot = (await http("/api/web/v1/access")).json().bootId;
    for (const path of ["send", "approve"]) {
      const result = await http(`/api/web/v1/${path}`, {
        method: "POST",
        body: { ...body, bootId: freshBoot, requestId: path },
      });
      expect(result.status).toBe(409);
      expect(result.json().error).toBe("outcome_unknown");
    }
    expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(false);
    expect((await http("/api/web/v1/live?sessionId=other")).json().sendEnabled).toBe(true);
    const stream = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=s",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.once("data", (chunk) => {
            resolve(String(chunk));
            res.destroy();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(stream).toContain('"reason":"control-outcome-unconfirmed"');
  });
  it("clears the dispatch fence only after a successful acknowledgement response", async () => {
    await bootstrap();
    await pair(true);
    for (const requestId of ["one", "two"]) {
      expect(
        (
          await http("/api/web/v1/send", {
            method: "POST",
            body: {
              sessionId: "s",
              text: "x",
              requestId,
              bootId,
              expectedRevision: 4,
            },
          })
        ).status,
      ).toBe(200);
    }
    expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(true);
  });
  it("keeps the fence when the browser disconnects before a late acknowledgement", async () => {
    await bootstrap();
    await pair(true);
    // Client close only confirms the local socket closed. Wait for the server
    // to observe it before simulating a late runtime acknowledgement.
    let serverClosed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      serverClosed = resolve;
    });
    const emit = ServerResponse.prototype.emit;
    vi.spyOn(ServerResponse.prototype, "emit").mockImplementation(function (
      this: ServerResponse,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const result = emit.call(this, event, ...args);
      if (event === "close" && this.req.url === "/api/web/v1/send") serverClosed();
      return result;
    });
    let finish!: (value: unknown) => void;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "r", revision: 4, sendEnabled: true },
    );
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/api/web/v1/send",
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end(
      JSON.stringify({ sessionId: "s", text: "x", requestId: "lost", bootId, expectedRevision: 4 }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await new Promise<void>((resolve) => {
      req.once("close", resolve);
      req.destroy();
    });
    await disconnected;
    finish({ accepted: true });
    const live = await http("/api/web/v1/live?sessionId=s");
    expect(live.json()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
    const next = await http("/api/web/v1/send", {
      method: "POST",
      body: {
        sessionId: "s",
        text: "x",
        requestId: "new",
        bootId,
        expectedRevision: 4,
      },
    });
    expect(next.status).toBe(409);
    expect(
      runtime.mock.calls.filter(([p]) => (p as { operation: string }).operation === "send"),
    ).toHaveLength(1);
  });
  it("limits local acceptance controls to one session and rejects remote configuration", async () => {
    await service.shutdown();
    const sessionId = "a".repeat(64);
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      acceptanceSessionId: sessionId,
    });
    await service.initialize();
    await bootstrap();
    await pair(true, true);
    runtime.mockClear();
    for (const path of ["send", "approve"]) {
      const result = await http(`/api/web/v1/${path}`, {
        method: "POST",
        body: { sessionId: "other", requestId: "outside", bootId, expectedRevision: 4, text: "x" },
      });
      expect(result.status).toBe(403);
    }
    expect(runtime).not.toHaveBeenCalled();
    await http("/api/web/v1/live?sessionId=other");
    expect(runtime).toHaveBeenLastCalledWith({
      operation: "live",
      sessionId: "other",
      experimentalEnabled: false,
    });
    const result = await http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId, requestId: "allowed", bootId, expectedRevision: 4, text: "x" },
    });
    expect(result.status).toBe(200);
    await expect(
      service.request({
        operation: "configure",
        enabled: true,
        port,
        experimentalEnabled: true,
        externalOrigin: "https://example.com",
      }),
    ).rejects.toThrow("acceptance_is_local_only");
  });
  it("defaults to release-gated read-only even when stored host and device grants allow control", async () => {
    await bootstrap();
    await pair(true, true);
    await service.shutdown();
    service = new WebAccessService({ dataDir: dir, staticDir: dir, runtimeRequest: runtime });
    await service.initialize();
    const status = await service.request({ operation: "status" });
    expect(status.config.experimentalEnabled).toBe(true);
    expect(status.experimentalAvailable).toBe(false);
    const access = await http("/api/web/v1/access");
    csrf = access.json().csrfToken;
    bootId = access.json().bootId;
    expect(access.json().experimentalEnabled).toBe(false);
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
        })
      ).status,
    ).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
    expect((await http("/api/web/v1/live?sessionId=s")).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith({
      operation: "live",
      sessionId: "s",
      experimentalEnabled: false,
    });
  });
});
