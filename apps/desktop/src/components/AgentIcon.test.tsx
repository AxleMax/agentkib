// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";
import type { AgentKind } from "../core/types";

afterEach(cleanup);

describe("AgentIcon", () => {
  it.each(["codex", "claude-code", "cursor", "open-claw", "hermes", "deepseek-harness"] as AgentKind[])(
    "renders the local %s brand asset instead of a letter placeholder",
    (agent) => {
      const { container } = render(<AgentIcon agent={agent} />);
      const icon = container.querySelector("img");

      expect(icon?.getAttribute("src")).toContain(".svg");
      expect(container.textContent).toBe("");
    },
  );
});
