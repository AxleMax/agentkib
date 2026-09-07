import type { AgentKind, ConversationSessionSummary } from "@/core/types";
import { tr } from "@/core/i18n";

export const sessionAgentNames: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

export function sessionRecordLabel(session: ConversationSessionSummary) {
  return [
    tr(
      session.availability === "metadata-only"
        ? "conversations.filter.metadata"
        : "sessions.readable",
    ),
    session.archived ? tr("conversations.filter.archived") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
