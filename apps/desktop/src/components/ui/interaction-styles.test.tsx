// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

function StatefulTabs() {
  const [value, setValue] = useState("first");
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList variant="line" aria-label="Sections">
        <TabsTrigger value="first">First</TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

describe("interaction style primitives", () => {
  it("lets full-surface buttons own their dimensions and chrome", () => {
    render(<Button variant="bare" size="content">Workspace row</Button>);
    const button = screen.getByRole("button", { name: "Workspace row" });

    expect(button).toHaveClass("h-auto", "rounded-none", "border-0", "bg-transparent", "active:translate-y-0");
    expect(button).not.toHaveClass("h-8", "rounded-lg");
  });

  it("keeps exactly one active tab and switches it with Base UI state", async () => {
    const user = userEvent.setup();
    const { container } = render(<StatefulTabs />);

    expect(container.querySelectorAll('[data-slot="tabs-trigger"][data-active]')).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("data-active");

    await user.click(screen.getByRole("tab", { name: "Second" }));

    expect(container.querySelectorAll('[data-slot="tabs-trigger"][data-active]')).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("data-active");
    expect(screen.getByRole("tab", { name: "First" })).not.toHaveAttribute("data-active");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveClass(
      "group-data-[variant=line]/tabs-list:focus-visible:ring-0",
      "group-data-[variant=line]/tabs-list:focus-visible:outline-none",
      "group-data-[variant=line]/tabs-list:data-active:font-semibold",
      "data-active:text-foreground",
      "after:absolute",
      "group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
    );

    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("tab", { name: "First" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(container.querySelectorAll('[data-slot="tabs-trigger"][data-active]')).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("data-active");
  });
});
