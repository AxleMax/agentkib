import claudeCodeIcon from "../assets/agent-icons/claude-code.svg";
import codexIcon from "../assets/agent-icons/codex.svg";
import cursorIcon from "../assets/agent-icons/cursor.svg";
import hermesIcon from "../assets/agent-icons/hermes.svg";
import openClawIcon from "../assets/agent-icons/open-claw.svg";
import type { AgentKind } from "../types";

const agentIcons: Record<AgentKind, string> = {
  codex: codexIcon,
  "claude-code": claudeCodeIcon,
  cursor: cursorIcon,
  "open-claw": openClawIcon,
  hermes: hermesIcon,
};

export function AgentIcon({ agent }: { agent: AgentKind }) {
  return (
    <div className={`agent-logo ${agent}`} aria-hidden="true">
      <img src={agentIcons[agent]} alt="" />
    </div>
  );
}
