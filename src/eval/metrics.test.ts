import { describe, expect, it } from "vitest";
import { auc, chooseThreshold, confusionAt, scoreCases, wilson, type Scored } from "./metrics.js";

describe("scoreCases", () => {
  it("makes the cases of the flagged kinds positive and every other kind negative", () => {
    const cases = [
      { kind: "rebill" as const, p_same_order: 0.5 },
      { kind: "split" as const, p_same_order: 0.1 },
      { kind: "moved" as const, p_same_order: 0.2 },
    ];
    expect(scoreCases(cases, ["rebill"])).toEqual([
      { p: 0.5, positive: true },
      { p: 0.1, positive: false },
      { p: 0.2, positive: false },
    ]);
    expect(scoreCases(cases, ["rebill", "split"]).map((s) => s.positive)).toEqual([true, true, false]);
  });

  it("leaves out the probe kind rebill_changed unless it is flagged", () => {
    const cases = [
      { kind: "rebill" as const, p_same_order: 0.5 },
      { kind: "rebill_changed" as const, p_same_order: 0.4 },
      { kind: "moved" as const, p_same_order: 0.2 },
    ];
    expect(scoreCases(cases, ["rebill"])).toEqual([
      { p: 0.5, positive: true },
      { p: 0.2, positive: false },
    ]);
    expect(scoreCases(cases, ["rebill", "rebill_changed"]).map((s) => s.positive)).toEqual([true, true, false]);
  });
});

const pos = (...ps: number[]): Scored[] => ps.map((p) => ({ p, positive: true }));
const neg = (...ps: number[]): Scored[] => ps.map((p) => ({ p, positive: false }));

describe("auc", () => {
  it("is 1 when every positive scores above every negative", () => {
    expect(auc([...pos(0.9, 0.8), ...neg(0.2, 0.1)])).toBe(1);
  });
  it("is 0 when inverted", () => {
    expect(auc([...pos(0.1), ...neg(0.9, 0.5)])).toBe(0);
  });
  it("counts ties as one half", () => {
    expect(auc([...pos(0.4, 0.4), ...neg(0.4)])).toBe(0.5);
    expect(auc([...pos(0.5, 0.3), ...neg(0.3)])).toBe(0.75);
  });
  it("is null without both classes", () => {
    expect(auc(pos(0.1, 0.2))).toBeNull();
    expect(auc(neg(0.1))).toBeNull();
  });
});

describe("wilson", () => {
  it("matches known 95% intervals", () => {
    const w = wilson(5, 10)!;
    expect(w.low).toBeCloseTo(0.2366, 4);
    expect(w.high).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 10)!.low).toBe(0);
    expect(wilson(10, 10)!.high).toBeCloseTo(1, 10);
  });
  it("is null for n = 0", () => {
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("confusionAt", () => {
  const xs = [...pos(0.9, 0.5, 0.2), ...neg(0.5, 0.1)];
  it("flags p ≥ threshold (p = threshold counts as flagged)", () => {
    const c = confusionAt(xs, 0.5);
    expect(c).toMatchObject({ positives: 3, negatives: 2, flagged_positives: 2, flagged_negatives: 1 });
    expect(c.recall).toBeCloseTo(2 / 3, 10);
    expect(c.false_alarm_rate).toBe(0.5);
    expect(c.recall_ci).toEqual(wilson(2, 3));
    expect(c.false_alarm_ci).toEqual(wilson(1, 2));
  });
  it("has null rates for an empty class", () => {
    const c = confusionAt(pos(0.3), 0.5);
    expect(c.false_alarm_rate).toBeNull();
    expect(c.false_alarm_ci).toBeNull();
  });
});

describe("chooseThreshold", () => {
  it("is the largest threshold whose recall meets the target", () => {
    const xs = [...pos(0.9, 0.8, 0.7, 0.6, 0.5), ...neg(0.65, 0.1)];
    const t = chooseThreshold(xs, 0.8);
    expect(t).toBe(0.6);
    expect(confusionAt(xs, t).recall!).toBeGreaterThanOrEqual(0.8);
    expect(confusionAt(xs, t + 1e-9).recall!).toBeLessThan(0.8);
  });
  it("handles tied positives", () => {
    expect(chooseThreshold([...pos(0.4, 0.4, 0.4), ...neg(0.4)], 0.9)).toBe(0.4);
  });
  it("needs every positive for a target of 1", () => {
    expect(chooseThreshold(pos(0.3, 0.7), 1)).toBe(0.3);
  });
  it("throws without positives or with a target outside (0, 1]", () => {
    expect(() => chooseThreshold(neg(0.2), 0.9)).toThrow(/positive/);
    expect(() => chooseThreshold(pos(0.2), 0)).toThrow(/target/);
    expect(() => chooseThreshold(pos(0.2), 1.1)).toThrow(/target/);
  });
});
