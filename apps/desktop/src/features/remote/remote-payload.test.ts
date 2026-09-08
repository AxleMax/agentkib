import { describe, expect, it } from "vitest";
import { parseRemoteCatalog, parseRemoteEvents } from "./remote-payload";

const workspace = { id: "w", name: "Demo", path: "/projects/demo" };
const session = {
  id: "s",
  workspace_id: "w",
  agent: "codex",
  archived: false,
  sidechain: false,
  availability: "readable",
};
describe("remote payload validation", () => {
  it("preserves whitelisted turn metadata and degrades old or unknown phases", () => {
    const event = {
      id: "e",
      kind: "agent-message",
      content: "unchanged",
      attachment_count: 0,
      truncated: false,
    };
    for (const phase of ["commentary", "final_answer", "future-phase", undefined, null, {}]) {
      const parsed = parseRemoteEvents({
        events: [
          { ...event, turn_id: "turn", message_phase: phase, remote: { host_id: "forged" } },
        ],
        warnings: [],
      }).events[0];
      expect(parsed.turn_id).toBe("turn");
      expect(parsed.message_phase).toBe(
        phase === "commentary" || phase === "final_answer" ? phase : undefined,
      );
      expect(parsed.content).toBe("unchanged");
      expect(parsed).not.toHaveProperty("remote");
    }
    expect(parseRemoteEvents({ events: [event], warnings: [] }).events[0].turn_id).toBeUndefined();
    expect(() =>
      parseRemoteEvents({ events: [{ ...event, turn_id: "t".repeat(257) }], warnings: [] }),
    ).toThrow("REMOTE_INVALID_RESPONSE");
  });
  it("accepts OpenCode and removes self-referential source relationships", () => {
    const result = parseRemoteCatalog({
      workspaces: [workspace],
      sessions: [
        { ...session, agent: "opencode", spawned_by_session_id: "s", forked_from_session_id: "s" },
      ],
    });
    expect(result.sessions[0]).toMatchObject({ agent: "opencode", origin: "unknown" });
    expect(result.sessions[0].spawned_by_session_id).toBeUndefined();
    expect(result.sessions[0].forked_from_session_id).toBeUndefined();
  });
  it("normalizes nullable Rust fields and strips remote-provided provenance", () => {
    const result = parseRemoteCatalog({
      workspaces: [{ ...workspace, remote: { host_id: "forged" } }],
      sessions: [{ ...session, title: null }],
    });
    expect(result.sessions[0].title).toBeUndefined();
    expect(result.workspaces[0].remote).toBeUndefined();
    expect(result.workspaces[0].sources).toEqual([]);
    expect(result.sessions[0].origin).toBe("unknown");
    expect(result.sessions[0].spawned_by_session_id).toBeUndefined();
    expect(result.sessions[0].forked_from_session_id).toBeUndefined();
  });
  it("preserves independent provenance and tolerates future origin values", () => {
    const result = parseRemoteCatalog({
      workspaces: [workspace],
      sessions: [
        {
          ...session,
          origin: "auxiliary",
          spawned_by_session_id: "parent",
          forked_from_session_id: "fork",
        },
        { ...session, id: "future", origin: "future-source", forked_from_session_id: null },
      ],
    });
    expect(result.sessions[0]).toMatchObject({
      origin: "auxiliary",
      spawned_by_session_id: "parent",
      forked_from_session_id: "fork",
    });
    expect(result.sessions[1].origin).toBe("unknown");
    expect(result.sessions[1].forked_from_session_id).toBeUndefined();
  });
  it.each([
    { workspaces: null, sessions: [] },
    { workspaces: [workspace], sessions: [{ ...session, id: {} }] },
    { workspaces: [workspace, workspace], sessions: [] },
    { workspaces: [workspace], sessions: [session, session] },
    { workspaces: [], sessions: [session] },
    { workspaces: [workspace], sessions: [{ ...session, origin: {} }] },
    { workspaces: [workspace], sessions: [{ ...session, spawned_by_session_id: "" }] },
    { workspaces: [workspace], sessions: [{ ...session, forked_from_session_id: {} }] },
  ])("rejects invalid and ambiguous directory records", (input) => {
    expect(() => parseRemoteCatalog(input)).toThrow("REMOTE_INVALID_RESPONSE");
  });
  it("rejects invalid event content and excessive page sizes", () => {
    const event = {
      id: "e",
      kind: "user-message",
      content: {},
      attachment_count: 0,
      truncated: false,
    };
    expect(() => parseRemoteEvents({ events: [event], warnings: [] })).toThrow(
      "REMOTE_INVALID_RESPONSE",
    );
    expect(() =>
      parseRemoteEvents({
        events: Array.from({ length: 101 }, (_, i) => ({ ...event, id: String(i), content: "ok" })),
        warnings: [],
      }),
    ).toThrow("REMOTE_INVALID_RESPONSE");
    expect(
      parseRemoteEvents({ events: [], warnings: [], next_cursor: null }).next_cursor,
    ).toBeUndefined();
  });
});
