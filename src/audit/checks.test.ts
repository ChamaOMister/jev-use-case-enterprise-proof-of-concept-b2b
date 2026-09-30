import { describe, expect, it } from "vitest";
import { cramersV } from "./checks.js";

const table = (cells: [string, string, number][]) => cells.map(([a, b, n]) => ({ a, b, n }));

describe("cramersV", () => {
  it("is 0 when the two variables are independent", () => {
    const rows = table([["x", "p", 10], ["x", "q", 20], ["y", "p", 30], ["y", "q", 60]]);
    expect(cramersV(rows, "a", "b", "n")).toBeCloseTo(0, 10);
  });

  it("is 1 when one variable fully determines the other", () => {
    const rows = table([["x", "p", 25], ["y", "q", 40], ["z", "r", 7]]);
    expect(cramersV(rows, "a", "b", "n")).toBeCloseTo(1, 10);
  });

  it("treats missing cells as zero counts", () => {
    const sparse = table([["x", "p", 5], ["y", "q", 5]]);
    const dense = table([["x", "p", 5], ["x", "q", 0], ["y", "p", 0], ["y", "q", 5]]);
    expect(cramersV(sparse, "a", "b", "n")).toBeCloseTo(cramersV(dense, "a", "b", "n"), 10);
  });
});
