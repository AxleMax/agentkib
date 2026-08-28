// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { AppSidebar } from "./AppSidebar";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";

describe("AppSidebar shortcut help", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("opens the shared shortcut help from the sidebar", async () => {
    const user = userEvent.setup();
    let opened = false;
    render(
      <ShortcutHelpProvider openShortcutHelp={() => (opened = true)}>
        <AppSidebar
          active="home"
          entries={[
            { id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" },
          ]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          onBrandClick={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    const helpButton = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(helpButton.getAttribute("aria-keyshortcuts")).toBe("Control+/");
    await user.click(helpButton);
    expect(opened).toBe(true);
  });
});
