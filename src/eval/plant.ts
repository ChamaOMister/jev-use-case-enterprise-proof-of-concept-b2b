/**
 * Phase 4: planted cases with known answers, built from clean (auto_approve) real invoices.
 *
 *   split  (same_order) one invoice's lines split into two invoices, gap_days apart
 *   rebill (same_order) an invoice, then a strict subset of its lines billed again gap_days later
 *   moved  (new_order)  a customer's next real order, moved to gap_days after the previous one
 *   rebill_changed (same_order, optional) some of an invoice's lines billed again gap_days later,
 *          every quantity changed: a rebill that an exact-quantity comparison can't see
 *
 * Each case gets the same Jev state Phase 3 would build: Phase 2 features of the current invoice
 * against the customer's earlier invoices plus the case's previous invoice.
 */
import { addDays, daysBetween } from "../check/dates.js";
import { compareInvoiceNumbers, History, lineSignature } from "../check/history.js";
import { DUPLICATE_LINES_DAYS, lineCommission, NEAR_DUPLICATE_DAYS, RULES } from "../check/rules.js";
import type { Catalog, InvoiceBundle, Line, Route, Split } from "../check/types.js";
import { featuresFor, type Features } from "../features/features.js";
import { stateFor, type JevState } from "../jev/state.js";

export type CaseKind = "split" | "rebill" | "rebill_changed" | "moved";
export type CaseLabel = "same_order" | "new_order";
export const LABEL: Readonly<Record<CaseKind, CaseLabel>> = {
  split: "same_order",
  rebill: "same_order",
  rebill_changed: "same_order",
  moved: "new_order",
};

export type EvalSplit = Exclude<Split, "demo">;
/** demo is never a source of planted cases. */
export const EVAL_SPLITS: readonly EvalSplit[] = ["tune", "test"];

export interface PlantedCase {
  case_id: string;
  kind: CaseKind;
  label: CaseLabel;
  split: EvalSplit;
  /** Real invoices the case is built from: [X] for split and the rebills, [P, N] for moved. */
  source_invoices: string[];
  gap_days: number;
  previous: InvoiceBundle;
  current: InvoiceBundle;
  features: Features;
  state: JevState;
}

export interface PlantInput {
  bundles: readonly InvoiceBundle[];
  /** Phase 1 route per invoice_number; only auto_approve invoices are sources. */
  routes: ReadonlyMap<string, Route>;
  fromPendingDelivery: ReadonlyMap<string, boolean>;
}

export interface PlantOptions {
  /** Cases per label and split. */
  perLabel: number;
  seed: number;
  /** gap in days → weight. Each split draws perLabel gaps and both labels use that same list. */
  gapWeights: ReadonlyMap<number, number>;
  /**
   * rebill_changed cases per split (0..perLabel, default 0). They are built last, from their own
   * PRNG and the first gaps of the list, so every other case stays exactly as without them.
   */
  changedPerSplit?: number;
}

/** Same boundaries as SPLIT_SQL in src/data/db.ts. */
export function splitOfDate(isoDate: string): Split {
  return isoDate < "2026-01-01" ? "tune" : isoDate < "2026-09-01" ? "test" : "demo";
}

/** A small seeded PRNG: uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Would Phase 1's duplicate_lines flag `current` against these earlier invoices of the customer? */
export function repeatsRecentLines(current: InvoiceBundle, earlier: readonly InvoiceBundle[]): boolean {
  const signature = lineSignature(current.lines);
  return earlier.some((e) => {
    const days = daysBetween(e.invoice.billing_date, current.invoice.billing_date);
    return days >= 0 && days <= DUPLICATE_LINES_DAYS && lineSignature(e.lines) === signature;
  });
}

const REBILLED_PRODUCTS = RULES.find((r) => r.id === "rebilled_products")!;
const NO_CATALOG: Catalog = { customers: new Map(), products: new Map() };

/**
 * Would Phase 1's rebilled_products flag the case's current invoice (and so send it to human
 * review before Jev)? The rule reads only the customer's previous invoice from the history.
 */
export function rebilledProducts({ previous, current }: Pick<PlantedCase, "previous" | "current">): boolean {
  const history = new History();
  history.add(previous);
  return REBILLED_PRODUCTS.evaluate(current, { catalog: NO_CATALOG, history }).outcome === "flag";
}

function shuffle<T>(xs: T[], rng: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

function drawGap(weights: readonly (readonly [number, number])[], rng: () => number): number {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [gap, w] of weights) {
    r -= w;
    if (r < 0) return gap;
  }
  return weights.at(-1)![0];
}

/** Indices of a random non-empty strict subset of 0..n-1 (n ≥ 2), in ascending order. */
function strictSubset(n: number, rng: () => number): Set<number> {
  const k = 1 + Math.floor(rng() * (n - 1));
  const idx = shuffle(
    Array.from({ length: n }, (_, i) => i),
    rng,
  );
  return new Set(idx.slice(0, k));
}

/** A different whole quantity ≥ 1: a partial amount (1..q-1) when q ≥ 2, otherwise 2. */
function changedQuantity(q: number, rng: () => number): number {
  return q >= 2 ? 1 + Math.floor(rng() * (q - 1)) : 2;
}

/** A copy of `src` with these lines on this date: lines renumbered, totals recomputed, no installments. */
function rebuild(src: InvoiceBundle, lines: readonly Line[], date: string, suffix: string): InvoiceBundle {
  const invoice_number = `${src.invoice.invoice_number}${suffix}`;
  const newLines = lines.map((l, i) => ({ ...l, invoice_number, line_number: i + 1, billing_date: date }));
  return {
    invoice: {
      ...src.invoice,
      invoice_number,
      billing_date: date,
      line_count: newLines.length,
      invoice_total_cents: newLines.reduce((s, l) => s + l.line_amount_cents, 0),
      commission_total_cents: newLines.reduce((s, l) => s + l.commission_amount_cents, 0),
      split: splitOfDate(date),
    },
    lines: newLines,
    installments: [],
  };
}

export function plantCases(
  { bundles, routes, fromPendingDelivery }: PlantInput,
  { perLabel, seed, gapWeights, changedPerSplit = 0 }: PlantOptions,
): PlantedCase[] {
  if (!(Number.isSafeInteger(perLabel) && perLabel > 0)) throw new Error(`perLabel must be a positive integer, got ${perLabel}`);
  if (!(Number.isSafeInteger(changedPerSplit) && changedPerSplit >= 0 && changedPerSplit <= perLabel)) {
    throw new Error(`changedPerSplit must be a whole number in 0..perLabel (${perLabel}), got ${changedPerSplit}`);
  }
  const weights = [...gapWeights].filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (weights.length === 0) throw new Error("gapWeights needs at least one gap with weight > 0");
  for (const [gap] of weights) {
    if (!(Number.isSafeInteger(gap) && gap >= 0 && gap <= NEAR_DUPLICATE_DAYS)) {
      throw new Error(`gap ${gap} is not a whole number of days in 0..${NEAR_DUPLICATE_DAYS} (Phase 1 would not route it to Jev)`);
    }
  }

  const ordered = [...bundles].sort((a, b) => compareInvoiceNumbers(a.invoice.invoice_number, b.invoice.invoice_number));
  const byCustomer = new Map<string, InvoiceBundle[]>();
  for (const b of ordered) {
    const list = byCustomer.get(b.invoice.customer_id) ?? [];
    list.push(b);
    byCustomer.set(b.invoice.customer_id, list);
  }
  /** The customer's invoices before `b`, oldest first. */
  const historyBefore = (b: InvoiceBundle): InvoiceBundle[] => {
    const list = byCustomer.get(b.invoice.customer_id)!;
    return list.slice(0, list.indexOf(b));
  };

  const pending = new Map(fromPendingDelivery);
  const used = new Set<string>();
  const cases: PlantedCase[] = [];

  for (const [splitIndex, split] of EVAL_SPLITS.entries()) {
    const rng = mulberry32(seed * 1000 + splitIndex);
    const clean = (b: InvoiceBundle): boolean => routes.get(b.invoice.invoice_number) === "auto_approve" && b.invoice.split === split;
    const counts: Record<CaseKind, number> = { split: 0, rebill: 0, rebill_changed: 0, moved: 0 };
    // One gap sequence for both labels: the k-th new_order and the k-th same_order case share a gap.
    const gaps = Array.from({ length: perLabel }, () => drawGap(weights, rng));

    /** Validates and completes a case; null if it leaves the split or year, or duplicate_lines would flag it. */
    const complete = (
      kind: CaseKind,
      sources: readonly InvoiceBundle[],
      previous: InvoiceBundle,
      current: InvoiceBundle,
      gap: number,
    ): PlantedCase | null => {
      const year = sources[0]!.invoice.billing_date.slice(0, 4);
      if (splitOfDate(current.invoice.billing_date) !== split || current.invoice.billing_date.slice(0, 4) !== year) return null;
      const history = historyBefore(sources[0]!);
      if (repeatsRecentLines(current, [...history, previous])) return null;
      const source = kind === "moved" ? sources[1]! : sources[0]!;
      for (const b of [previous, current]) {
        if (!pending.has(b.invoice.invoice_number)) pending.set(b.invoice.invoice_number, pending.get(source.invoice.invoice_number)!);
      }
      const features = featuresFor(current, [...history, previous]);
      counts[kind] += 1;
      return {
        case_id: `${split}-${kind}-${String(counts[kind]).padStart(3, "0")}`,
        kind,
        label: LABEL[kind],
        split,
        source_invoices: sources.map((s) => s.invoice.invoice_number),
        gap_days: gap,
        previous,
        current,
        features,
        state: stateFor({ current, previous, features, fromPendingDelivery: pending }),
      };
    };
    const take = (c: PlantedCase | null): void => {
      if (!c) return;
      for (const n of c.source_invoices) used.add(n);
      cases.push(c);
    };

    // moved: consecutive clean invoices P → N of one customer in one year. If N repeats P's lines,
    // `complete` drops it (duplicate_lines would flag N moved next to P).
    const pairs: [InvoiceBundle, InvoiceBundle][] = [];
    for (const list of byCustomer.values()) {
      for (let i = 1; i < list.length; i++) {
        const [p, n] = [list[i - 1]!, list[i]!];
        if (clean(p) && clean(n) && p.invoice.billing_date.slice(0, 4) === n.invoice.billing_date.slice(0, 4)) pairs.push([p, n]);
      }
    }
    for (const [p, n] of shuffle(pairs, rng)) {
      if (counts.moved === perLabel) break;
      if (used.has(p.invoice.invoice_number) || used.has(n.invoice.invoice_number)) continue;
      const gap = gaps[counts.moved]!;
      if (daysBetween(p.invoice.billing_date, n.invoice.billing_date) <= gap) continue; // not a real move
      take(complete("moved", [p, n], p, rebuild(n, n.lines, addDays(p.invoice.billing_date, gap), "-m"), gap));
    }

    // same_order: ⌈N/2⌉ splits, then ⌊N/2⌋ rebills, from unused clean invoices with ≥ 2 lines.
    const want: Record<CaseKind, number> = {
      moved: perLabel,
      split: Math.ceil(perLabel / 2),
      rebill: Math.floor(perLabel / 2),
      rebill_changed: changedPerSplit,
    };
    const xs = shuffle(
      ordered.filter((b) => clean(b) && b.lines.length >= 2),
      rng,
    );
    for (const x of xs) {
      const kind: CaseKind | null = counts.split < want.split ? "split" : counts.rebill < want.rebill ? "rebill" : null;
      if (!kind) break;
      if (used.has(x.invoice.invoice_number)) continue;
      const gap = gaps[counts.split + counts.rebill]!;
      const date = addDays(x.invoice.billing_date, gap);
      const chosen = strictSubset(x.lines.length, rng);
      const inSubset = x.lines.filter((_, i) => chosen.has(i));
      if (kind === "split") {
        const rest = x.lines.filter((_, i) => !chosen.has(i));
        take(complete("split", [x], rebuild(x, inSubset, x.invoice.billing_date, "-a"), rebuild(x, rest, date, "-b"), gap));
      } else {
        take(complete("rebill", [x], x, rebuild(x, inSubset, date, "-r"), gap));
      }
    }

    // rebill_changed: its own PRNG, after everything else, so the cases above never change.
    const changedRng = mulberry32(seed * 1000 + 100 + splitIndex);
    for (const x of shuffle(
      ordered.filter((b) => clean(b) && b.lines.length >= 2),
      changedRng,
    )) {
      if (counts.rebill_changed === want.rebill_changed) break;
      if (used.has(x.invoice.invoice_number)) continue;
      const gap = gaps[counts.rebill_changed]!;
      const k = 1 + Math.floor(changedRng() * x.lines.length);
      const chosen = new Set(
        shuffle(
          Array.from({ length: x.lines.length }, (_, i) => i),
          changedRng,
        ).slice(0, k),
      );
      const lines = x.lines
        .filter((_, i) => chosen.has(i))
        .map((l) => {
          const package_quantity = changedQuantity(l.package_quantity, changedRng);
          const line_amount_cents = package_quantity * l.unit_price_cents;
          return { ...l, package_quantity, line_amount_cents, commission_amount_cents: lineCommission(line_amount_cents) };
        });
      take(complete("rebill_changed", [x], x, rebuild(x, lines, addDays(x.invoice.billing_date, gap), "-c"), gap));
    }

    for (const kind of ["moved", "split", "rebill", "rebill_changed"] as const) {
      if (counts[kind] < want[kind]) {
        throw new Error(`Not enough ${kind} candidates in ${split}: built ${counts[kind]} of ${want[kind]}`);
      }
    }
  }
  return cases;
}
