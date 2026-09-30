/**
 * Phase 4: scores Jev's p_same_order on planted cases. Positive = a case of a kind that must reach
 * human review (by default only rebills: they bill twice, a split bills each line once); a case is
 * flagged (→ human_review, as in Phase 3's routeAfterJev) when p ≥ threshold.
 */
import type { CaseKind } from "./plant.js";

/** Kinds that must be caught: a partial rebill bills twice; a split order and a new order don't. */
export const DEFAULT_FLAG_KINDS: readonly CaseKind[] = ["rebill"];

/**
 * Kinds that only probe how far Jev generalizes: left out of the threshold metrics unless flagged,
 * so a probe case above the threshold never counts as a false alarm. They are reported per kind.
 */
export const PROBE_KINDS: readonly CaseKind[] = ["rebill_changed"];

export function scoreCases(cases: readonly { kind: CaseKind; p_same_order: number }[], flagKinds: readonly CaseKind[]): Scored[] {
  return cases
    .filter((c) => flagKinds.includes(c.kind) || !PROBE_KINDS.includes(c.kind))
    .map((c) => ({ p: c.p_same_order, positive: flagKinds.includes(c.kind) }));
}

export interface Scored {
  p: number;
  positive: boolean;
}

export interface Interval {
  low: number;
  high: number;
}

export interface Confusion {
  positives: number;
  negatives: number;
  flagged_positives: number;
  flagged_negatives: number;
  recall: number | null;
  recall_ci: Interval | null;
  false_alarm_rate: number | null;
  false_alarm_ci: Interval | null;
}

/** Share of (positive, negative) pairs where the positive scores higher; ties count ½. Null without both classes. */
export function auc(xs: readonly Scored[]): number | null {
  const ps = xs.filter((x) => x.positive).map((x) => x.p);
  const ns = xs.filter((x) => !x.positive).map((x) => x.p);
  if (ps.length === 0 || ns.length === 0) return null;
  let wins = 0;
  for (const p of ps) for (const n of ns) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (ps.length * ns.length);
}

/** Wilson score 95% interval for k successes out of n. Null when n = 0. */
export function wilson(k: number, n: number): Interval | null {
  if (n === 0) return null;
  const z = 1.959964;
  const phat = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function confusionAt(xs: readonly Scored[], threshold: number): Confusion {
  const positives = xs.filter((x) => x.positive).length;
  const negatives = xs.length - positives;
  const flagged_positives = xs.filter((x) => x.positive && x.p >= threshold).length;
  const flagged_negatives = xs.filter((x) => !x.positive && x.p >= threshold).length;
  return {
    positives,
    negatives,
    flagged_positives,
    flagged_negatives,
    recall: positives === 0 ? null : flagged_positives / positives,
    recall_ci: wilson(flagged_positives, positives),
    false_alarm_rate: negatives === 0 ? null : flagged_negatives / negatives,
    false_alarm_ci: wilson(flagged_negatives, negatives),
  };
}

/**
 * The largest threshold whose recall is at least `targetRecall`: the k-th largest positive p,
 * k = ⌈target × positives⌉. Any higher threshold flags fewer than k positives.
 */
export function chooseThreshold(xs: readonly Scored[], targetRecall: number): number {
  if (!(targetRecall > 0 && targetRecall <= 1)) throw new Error(`target recall must be in (0, 1], got ${targetRecall}`);
  const ps = xs
    .filter((x) => x.positive)
    .map((x) => x.p)
    .sort((a, b) => b - a);
  if (ps.length === 0) throw new Error("chooseThreshold needs at least one positive case");
  // The epsilon keeps float error in target × n (e.g. 0.9 × 60) from demanding one case too many.
  const k = Math.ceil(targetRecall * ps.length - 1e-9);
  return ps[k - 1]!;
}
