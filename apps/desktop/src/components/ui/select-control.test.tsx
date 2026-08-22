// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SelectControl } from "./select-control";

function LocalizedSelect() {
  const [value, setValue] = useState("system");
  return (
    <SelectControl
      aria-label="语言"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    >
      <option value="system">跟随系统</option>
      <option value="zh-CN">简体中文</option>
    </SelectControl>
  );
}

describe("SelectControl", () => {
  it("renders the selected option label and updates it after selection", async () => {
    const user = userEvent.setup();
    render(<LocalizedSelect />);

    const trigger = screen.getByRole("combobox", { name: "语言" });
    expect(trigger).toHaveTextContent("跟随系统");

    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 32,
      height: 32,
      left: 0,
      right: 120,
      top: 0,
      width: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "简体中文" }));

    expect(trigger).toHaveTextContent("简体中文");
  });

  it("uses the first textual option as an accessible fallback name", () => {
    render(
      <SelectControl value="all">
        <option value="all">全部工作区</option>
        <option value="one">工作区一</option>
      </SelectControl>,
    );

    expect(screen.getByRole("combobox", { name: "全部工作区" })).toBeInTheDocument();
  });
});
