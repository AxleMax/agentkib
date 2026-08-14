// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlatformAttribute, normalizePlatform } from "./platform";

describe("desktop platform marker", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it.each([
    ["windows", "windows"],
    ["darwin", "macos"],
    ["linux", "linux"],
    [undefined, "web"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizePlatform(input)).toBe(expected);
  });

  it("marks the document root for Windows-specific layout", () => {
    applyPlatformAttribute("windows");

    expect(document.documentElement.dataset.platform).toBe("windows");
  });
});
