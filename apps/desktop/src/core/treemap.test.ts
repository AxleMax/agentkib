import { describe, expect, it } from "vitest";
import { squarifyTreemap } from "./treemap";

describe("squarifyTreemap", () => {
  it("fills the requested area without overlapping the value ratio", () => {
    const values = squarifyTreemap([
      { id: "large", value: 75 },
      { id: "small", value: 25 },
    ]);
    expect(values).toHaveLength(2);
    const area = values.reduce((sum, item) => sum + item.width * item.height, 0);
    expect(area).toBeCloseTo(10_000);
    const large = values.find((item) => item.id === "large")!;
    const small = values.find((item) => item.id === "small")!;
    expect((large.width * large.height) / (small.width * small.height)).toBeCloseTo(3);
  });

  it("ignores empty and negative values", () => {
    expect(
      squarifyTreemap([
        { id: "zero", value: 0 },
        { id: "negative", value: -1 },
      ]),
    ).toEqual([]);
  });
});
