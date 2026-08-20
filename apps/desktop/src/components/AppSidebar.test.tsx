// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { Home, Library } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";

describe("AppSidebar", () => {
  it("marks only the active destination as the current page", () => {
    render(
      <AppSidebar
        active="home"
        entries={[
          { id: "home", label: "nav.home", icon: Home },
          { id: "assets", label: "nav.assets", icon: Library },
        ]}
        onNavigate={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const [home, assets] = screen.getAllByRole("button");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(assets).not.toHaveAttribute("aria-current");
  });
});
