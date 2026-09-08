export interface ConversationSessionSummary {
  id: string;
  workspace_id: string;
  agent: "codex" | "claude-code" | "opencode" | "open-claw" | "hermes" | "grok-build";
  title?: string;
  updated_at?: string;
  availability: "readable" | "metadata-only";
  archived: boolean;
  sidechain: boolean;
}
export interface ConversationEvent {
  id: string;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string | null;
  message_phase?: "commentary" | "final_answer" | null;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  truncated: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
export type Decision = "accept" | "decline" | "cancel";
export interface Access {
  status: "unpaired" | "pending" | "approved" | "ended";
  csrfToken: string;
  bootId: string;
  device?: { id: string; name: string; send: boolean; approve: boolean };
  pending?: { id: string; verification: string; expiresAt: string | number };
  experimentalEnabled: boolean;
}
export interface Approval {
  requestId: string | number;
  turnId: string;
  method: string;
  command?: unknown;
  cwd?: string;
  changes?: unknown;
  availableDecisions: Decision[];
  supported: boolean;
  unsupportedReason?: string | null;
  unsupportedMetadata?: { field: string; type: string }[];
  proposedExecpolicyAmendment?: string[] | null;
  environmentId?: "local" | null;
}
export interface Live {
  sessionId: string;
  status: string;
  revision: number;
  turnId?: string;
  sendEnabled: boolean;
  approvals: Approval[];
  reason?: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public controlOutcome?: "not-dispatched" | "unknown",
  ) {
    super(code);
  }
}
export class WebClient {
  csrfToken = "";
  constructor(private readonly transport?: typeof fetch) {}
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await (this.transport ?? fetch)(`/api/web/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers:
        body === undefined
          ? undefined
          : { "Content-Type": "application/json", "X-CSRF-Token": this.csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = "request_failed";
      let controlOutcome: ApiError["controlOutcome"];
      try {
        const value = await response.json();
        code = value.code ?? value.error ?? code;
        if (value.controlOutcome === "not-dispatched" || value.controlOutcome === "unknown")
          controlOutcome = value.controlOutcome;
      } catch {
        /* Never expose raw HTML/proxy bodies. */
      }
      throw new ApiError(
        response.status,
        typeof code === "string" ? code : "request_failed",
        controlOutcome,
      );
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  async access(signal?: AbortSignal) {
    const result = await this.request<Access>("access", undefined, signal);
    this.csrfToken = result.csrfToken;
    return result;
  }
  catalog(signal?: AbortSignal) {
    return this.request<{ sessions: ConversationSessionSummary[]; indexEnabled: boolean }>(
      "catalog",
      undefined,
      signal,
    );
  }
  events(sessionId: string, cursor?: string, signal?: AbortSignal) {
    const q = new URLSearchParams({ sessionId, limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return this.request<ConversationEventPage>(`events?${q}`, undefined, signal);
  }
  live(sessionId: string, signal?: AbortSignal) {
    return this.request<Live>(`live?${new URLSearchParams({ sessionId })}`, undefined, signal);
  }
}
