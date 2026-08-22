import { describe, expect, it } from "vitest";
import { buildHeatmapMonthMarkers } from "./insights";
import type { HeatmapPoint } from "@/core/types";

function point(date: string): HeatmapPoint {
  return {
    date,
    tokens: 0,
    my_commits: 0,
    all_commits: 0,
    attributed_commits: 0,
    sessions: 0,
    quality: "exact",
  };
}

describe("heatmap month markers", () => {
  it("places one marker per month on the first visible week", () => {
    const markers = buildHeatmapMonthMarkers(
      [
        point("2025-12-29"),
        point("2025-12-31"),
        point("2026-01-01"),
        point("2026-01-07"),
        point("2026-02-01"),
      ],
      1,
      "en-US",
    );

    expect(markers.map(({ key, column }) => [key, column])).toEqual([
      ["2025-11", 1],
      ["2026-0", 1],
      ["2026-1", 1],
    ]);
    expect(markers).toHaveLength(3);
  });

  it("returns no markers for an empty range", () => {
    expect(buildHeatmapMonthMarkers([], 0, "zh-CN")).toEqual([]);
  });
});
