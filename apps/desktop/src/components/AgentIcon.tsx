import claudeCodeIcon from "../assets/agent-icons/claude-code.svg";
import codexIcon from "../assets/agent-icons/codex.svg";
import cursorIcon from "../assets/agent-icons/cursor.svg";
import hermesIcon from "../assets/agent-icons/hermes.svg";
import openClawIcon from "../assets/agent-icons/open-claw.svg";
import deepSeekHarnessIcon from "../assets/agent-icons/deepseek-harness.svg";
import type { AgentKind } from "../types";
import { cn } from "@/lib/utils";

const agentIcons: Record<AgentKind, string> = {
  codex: codexIcon,
  "claude-code": claudeCodeIcon,
  cursor: cursorIcon,
  "open-claw": openClawIcon,
  hermes: hermesIcon,
  "deepseek-harness": deepSeekHarnessIcon,
};

export function AgentIcon({ agent }: { agent: AgentKind }) {
  return (
    <div className={cn("agent-logo grid size-[35px] place-items-center overflow-hidden rounded-[9px] bg-[#20242d]", agent === "codex" && "codex bg-[#171b22]", agent === "claude-code" && "claude-code bg-[#38251f]", agent === "cursor" && "cursor bg-[#1d1d1f]", agent === "open-claw" && "open-claw bg-[#391e26]", agent === "hermes" && "hermes bg-[#173730]", agent === "deepseek-harness" && "deepseek-harness bg-[#20242d]")} aria-hidden="true">
      <img className={cn("block size-[23px] object-contain", agent === "hermes" && "opacity-[0.92] invert")} src={agentIcons[agent]} alt="" />
    </div>
  );
}
