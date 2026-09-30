import { describe, expect, it } from "vitest";
import { bundle, type LineSpec } from "../check/test-fixtures.js";
import type { InvoiceBundle, Line, Route, Split } from "../check/types.js";
import { daysBetween } from "../check/dates.js";
import { featuresFor } from "../features/features.js";
import { LABEL, mulberry32, plantCases, rebilledProducts, repeatsRecentLines, splitOfDate, type PlantedCase, type PlantInput } from "./plant.js";

const splitOf = (d: string): Split => (d < "2026-01-01" ? "tune" : d < "2026-09-01" ? "test" : "demo");

/** Two customers, one invoice every 9 days each, from 2025-01-02 to 2026-09-20, all clean. */
function world(): { bundles: InvoiceBundle[]; routes: Map<string, Route>; pending: Map<string, boolean> } {
  const raw: { date: string; customer: string; lines: LineSpec[] }[] = [];
  for (const [c, customer] of ["C1", "C2"].entries()) {
    for (let i = 0; i < 70; i++) {
      const date = new Date(Date.UTC(2025, 0, 2 + c + 9 * i)).toISOString().slice(0, 10);
      const lines: LineSpec[] = [
        { product_id: "P1", qty: 1 + (i % 7), price: 1000 },
        { product_id: "P2", qty: 1 + (i % 3), price: 5000 },
      ];
      if (i % 2 === 0) lines.push({ product_id: "P1", qty: 2, price: 1000 }); // a product on two lines
      raw.push({ date, customer, lines });
    }
  }
  // The last invoice of 2025 for C1, so a shift of 1+ days crosses into 2026.
  raw.push({ date: "2025-12-31", customer: "C1", lines: [{ product_id: "P1", qty: 3, price: 1000 }, { product_id: "P2", qty: 3, price: 5000 }] });
  raw.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.customer < b.customer ? -1 : 1));
  const bundles = raw.map((r, i) =>
    bundle({ invoice_number: String(i + 1).padStart(6, "0"), billing_date: r.date, customer_id: r.customer, lines: r.lines, split: splitOf(r.date) }),
  );
  const routes = new Map<string, Route>(bundles.map((b) => [b.invoice.invoice_number, "auto_approve"]));
  const pending = new Map(bundles.map((b) => [b.invoice.invoice_number, b.invoice.customer_id === "C2"]));
  return { bundles, routes, pending };
}

const W = world();
const input: PlantInput = { bundles: W.bundles, routes: W.routes, fromPendingDelivery: W.pending };
const gapWeights = new Map([
  [0, 0],
  [1, 3],
  [2, 2],
]);
const options = { perLabel: 6, seed: 7, gapWeights, changedPerSplit: 4 };
const cases = plantCases(input, options);
const byNumber = new Map(W.bundles.map((b) => [b.invoice.invoice_number, b]));
const src = (n: string): InvoiceBundle => byNumber.get(n)!;

const multiset = (lines: readonly Line[]): string[] => lines.map((l) => `${l.product_id}×${l.package_quantity}@${l.unit_price_cents}`).sort();
const ofKind = (k: PlantedCase["kind"]) => cases.filter((c) => c.kind === k);

function checkInvoice(b: InvoiceBundle): void {
  expect(b.lines.length).toBeGreaterThan(0);
  expect(b.invoice.line_count).toBe(b.lines.length);
  expect(b.invoice.invoice_total_cents).toBe(b.lines.reduce((s, l) => s + l.line_amount_cents, 0));
  expect(b.lines.map((l) => l.line_number)).toEqual(b.lines.map((_, i) => i + 1));
  for (const l of b.lines) {
    expect(l.billing_date).toBe(b.invoice.billing_date);
    expect(l.invoice_number).toBe(b.invoice.invoice_number);
  }
  expect(b.invoice.split).toBe(splitOf(b.invoice.billing_date));
}

describe("splitOfDate", () => {
  it("uses the SPLIT_SQL boundaries", () => {
    expect(splitOfDate("2025-12-31")).toBe("tune");
    expect(splitOfDate("2026-01-01")).toBe("test");
    expect(splitOfDate("2026-08-31")).toBe("test");
    expect(splitOfDate("2026-09-01")).toBe("demo");
  });
});

describe("mulberry32", () => {
  it("is deterministic and in [0, 1)", () => {
    const a = mulberry32(3);
    const b = mulberry32(3);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBe(50);
  });
});

describe("repeatsRecentLines", () => {
  const earlier = bundle({ invoice_number: "000001", billing_date: "2025-03-01", lines: [{ product_id: "P1", qty: 2, price: 1000 }] });
  it("is true for the same products and quantities ≤ 7 days earlier", () => {
    const current = bundle({ invoice_number: "000002", billing_date: "2025-03-08", lines: [{ product_id: "P1", qty: 2, price: 1000 }] });
    expect(repeatsRecentLines(current, [earlier])).toBe(true);
  });
  it("is false after 7 days or with other quantities", () => {
    const late = bundle({ invoice_number: "000002", billing_date: "2025-03-09", lines: [{ product_id: "P1", qty: 2, price: 1000 }] });
    const other = bundle({ invoice_number: "000003", billing_date: "2025-03-02", lines: [{ product_id: "P1", qty: 3, price: 1000 }] });
    expect(repeatsRecentLines(late, [earlier])).toBe(false);
    expect(repeatsRecentLines(other, [earlier])).toBe(false);
  });
});

describe("rebilledProducts", () => {
  const previous = bundle({ invoice_number: "000009", billing_date: "2025-03-10", lines: [{ product_id: "P1", qty: 3, price: 1000 }] });
  it("is Phase 1's rebilled_products verdict on the case's previous and current invoice", () => {
    const again = bundle({ invoice_number: "000001", billing_date: "2025-03-11", lines: [{ product_id: "P1", qty: 5, price: 1000 }] });
    const added = bundle({ invoice_number: "000001", billing_date: "2025-03-11", lines: [{ product_id: "P1", qty: 5, price: 1000 }, { product_id: "P2", qty: 1, price: 5000 }] });
    expect(rebilledProducts({ previous, current: again })).toBe(true);
    expect(rebilledProducts({ previous, current: added })).toBe(false);
  });
  it("catches every planted rebill of either kind", () => {
    for (const c of [...cases.filter((x) => x.kind === "rebill" || x.kind === "rebill_changed")]) expect(rebilledProducts(c), c.case_id).toBe(true);
  });
});

describe("plantCases", () => {
  it("builds perLabel cases per label and split: moved, then ⌈N/2⌉ split and ⌊N/2⌋ rebill", () => {
    for (const split of ["tune", "test"] as const) {
      const s = cases.filter((c) => c.split === split);
      expect(s.filter((c) => c.kind === "moved")).toHaveLength(6);
      expect(s.filter((c) => c.kind === "split")).toHaveLength(3);
      expect(s.filter((c) => c.kind === "rebill")).toHaveLength(3);
      expect(s.filter((c) => c.kind === "rebill_changed")).toHaveLength(4);
    }
    const { changedPerSplit: _, ...withoutChanged } = options;
    expect(plantCases(input, withoutChanged).filter((c) => c.kind === "rebill_changed")).toEqual([]);
    const odd = plantCases(input, { ...options, perLabel: 5 }).filter((c) => c.split === "tune");
    expect(odd.filter((c) => c.kind === "split")).toHaveLength(3);
    expect(odd.filter((c) => c.kind === "rebill")).toHaveLength(2);
  });

  it("labels split, rebill and rebill_changed same_order and moved new_order", () => {
    expect(LABEL).toEqual({ split: "same_order", rebill: "same_order", rebill_changed: "same_order", moved: "new_order" });
    for (const c of cases) expect(c.label).toBe(LABEL[c.kind]);
  });

  it("has unique case ids", () => {
    expect(new Set(cases.map((c) => c.case_id)).size).toBe(cases.length);
  });

  it("split: the two invoices partition the source's lines, gap_days apart", () => {
    for (const c of ofKind("split")) {
      const x = src(c.source_invoices[0]!);
      expect(c.source_invoices).toHaveLength(1);
      checkInvoice(c.previous);
      checkInvoice(c.current);
      expect([...multiset(c.previous.lines), ...multiset(c.current.lines)].sort()).toEqual(multiset(x.lines));
      expect(c.previous.invoice.billing_date).toBe(x.invoice.billing_date);
      expect(daysBetween(x.invoice.billing_date, c.current.invoice.billing_date)).toBe(c.gap_days);
      expect(c.current.invoice.payment_schedule).toBe(x.invoice.payment_schedule);
    }
  });

  it("rebill: previous is the source; current is a strict, non-empty subset of its lines", () => {
    for (const c of ofKind("rebill")) {
      const x = src(c.source_invoices[0]!);
      expect(c.previous).toBe(x);
      checkInvoice(c.current);
      const all = multiset(x.lines);
      const sub = multiset(c.current.lines);
      expect(sub.length).toBeLessThan(all.length);
      const left = [...all];
      for (const s of sub) {
        const i = left.indexOf(s);
        expect(i).toBeGreaterThanOrEqual(0);
        left.splice(i, 1);
      }
      expect(daysBetween(x.invoice.billing_date, c.current.invoice.billing_date)).toBe(c.gap_days);
    }
  });

  it("rebill_changed: previous is the source; current rebills some of its lines, every quantity changed", () => {
    for (const c of ofKind("rebill_changed")) {
      const x = src(c.source_invoices[0]!);
      expect(c.previous).toBe(x);
      checkInvoice(c.current);
      expect(c.current.lines.length).toBeGreaterThan(0);
      expect(c.current.lines.length).toBeLessThanOrEqual(x.lines.length);
      const left = [...x.lines];
      for (const l of c.current.lines) {
        const i = left.findIndex((o) => o.product_id === l.product_id && o.unit_price_cents === l.unit_price_cents && o.package_quantity !== l.package_quantity);
        expect(i).toBeGreaterThanOrEqual(0);
        left.splice(i, 1);
        expect(l.package_quantity).toBeGreaterThanOrEqual(1);
        expect(l.line_amount_cents).toBe(l.package_quantity * l.unit_price_cents);
        expect(l.commission_amount_cents).toBe(Math.floor((l.line_amount_cents * 5 + 50) / 100));
      }
      expect(daysBetween(x.invoice.billing_date, c.current.invoice.billing_date)).toBe(c.gap_days);
    }
  });

  it("adding rebill_changed cases leaves every other case unchanged (so their cached Jev answers stay valid)", () => {
    const { changedPerSplit: _, ...withoutChanged } = options;
    const others = cases.filter((c) => c.kind !== "rebill_changed");
    expect(others.map((c) => [c.case_id, c.state])).toEqual(plantCases(input, withoutChanged).map((c) => [c.case_id, c.state]));
  });

  it("moved: consecutive invoices of one customer, the later one moved to gap_days after the earlier", () => {
    for (const c of ofKind("moved")) {
      const [p, n] = c.source_invoices.map(src) as [InvoiceBundle, InvoiceBundle];
      expect(c.previous).toBe(p);
      checkInvoice(c.current);
      expect(multiset(c.current.lines)).toEqual(multiset(n.lines));
      expect(c.current.invoice.billing_date).not.toBe(n.invoice.billing_date);
      expect(daysBetween(p.invoice.billing_date, c.current.invoice.billing_date)).toBe(c.gap_days);
      expect(n.invoice.customer_id).toBe(p.invoice.customer_id);
      const between = W.bundles.filter(
        (b) => b.invoice.customer_id === p.invoice.customer_id && b.invoice.invoice_number > p.invoice.invoice_number && b.invoice.invoice_number < n.invoice.invoice_number,
      );
      expect(between).toEqual([]);
      expect(multiset(n.lines)).not.toEqual(multiset(p.lines));
    }
  });

  it("draws gaps only from gaps with weight > 0, and uses each of them", () => {
    expect(new Set(cases.map((c) => c.gap_days))).toEqual(new Set([1, 2]));
  });

  it("gives both labels the same gaps in each split, so the gap never hints at the label", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const got = plantCases(input, { ...options, seed });
      for (const split of ["tune", "test"] as const) {
        const inSplit = got.filter((c) => c.split === split);
        const gaps = (xs: PlantedCase[]) => xs.map((c) => c.gap_days).sort();
        const moved = inSplit.filter((c) => c.kind === "moved");
        expect(gaps(inSplit.filter((c) => c.kind === "split" || c.kind === "rebill"))).toEqual(gaps(moved));
        // rebill_changed reuses the first gaps of the same list.
        const changed = inSplit.filter((c) => c.kind === "rebill_changed");
        expect(gaps(changed)).toEqual(gaps(moved.slice(0, changed.length)));
      }
    }
  });

  it("never reuses a source invoice, and never uses demo or non-auto_approve invoices", () => {
    const sources = cases.flatMap((c) => c.source_invoices);
    expect(new Set(sources).size).toBe(sources.length);
    for (const n of sources) expect(src(n).invoice.split).not.toBe("demo");

    const routes = new Map(W.routes);
    const blocked = W.bundles.filter((_, i) => i % 3 === 0).map((b) => b.invoice.invoice_number);
    for (const n of blocked) routes.set(n, "jev");
    const other = plantCases({ ...input, routes }, options).flatMap((c) => c.source_invoices);
    for (const n of blocked) expect(other).not.toContain(n);
  });

  it("keeps each case inside its split and calendar year", () => {
    for (const c of cases) {
      const dates = [c.previous, c.current, ...c.source_invoices.map(src)].map((b) => b.invoice.billing_date);
      expect(new Set(dates.map(splitOf))).toEqual(new Set([c.split]));
      expect(new Set(dates.map((d) => d.slice(0, 4))).size).toBe(1);
    }
  });

  it("never shifts a split or rebill across a split boundary", () => {
    // In tune only C1's last three invoices of 2025 are clean: one moved pair plus one positive
    // candidate. When that candidate is 2025-12-31, a 1-day shift would land in 2026 (test).
    const c1 = W.bundles.filter((b) => b.invoice.customer_id === "C1" && b.invoice.split === "tune");
    const keep = new Set(c1.slice(-3).map((b) => b.invoice.invoice_number));
    expect(c1.at(-1)!.invoice.billing_date).toBe("2025-12-31");
    const routes = new Map(W.routes);
    for (const b of W.bundles) if (b.invoice.split === "tune" && !keep.has(b.invoice.invoice_number)) routes.set(b.invoice.invoice_number, "jev");
    let refused = 0;
    for (let seed = 1; seed <= 10; seed++) {
      try {
        const got = plantCases({ ...input, routes }, { perLabel: 1, seed, gapWeights: new Map([[1, 1]]) });
        for (const c of got) expect(splitOf(c.current.invoice.billing_date)).toBe(c.split);
      } catch (e) {
        expect(String(e)).toMatch(/split candidates in tune/);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("never pairs two invoices with the same products and quantities as a moved case", () => {
    const b = [...W.bundles];
    // Give C1's 3rd invoice the same lines as its 2nd.
    const c1 = b.filter((x) => x.invoice.customer_id === "C1");
    const [second, third] = [c1[1]!, c1[2]!];
    const copy = bundle({
      invoice_number: third.invoice.invoice_number,
      billing_date: third.invoice.billing_date,
      customer_id: "C1",
      lines: second.lines.map((l) => ({ product_id: l.product_id, qty: l.package_quantity, price: l.unit_price_cents })),
    });
    b[b.indexOf(third)] = copy;
    for (let seed = 1; seed <= 20; seed++) {
      const moved = plantCases({ ...input, bundles: b }, { ...options, perLabel: 12, seed }).filter((c) => c.kind === "moved");
      for (const c of moved) expect(c.source_invoices).not.toEqual([second.invoice.invoice_number, third.invoice.invoice_number]);
    }
  });

  it("computes the state from the pair and the customer's earlier invoices, copying from_pending_delivery", () => {
    for (const c of cases) {
      const customer = c.previous.invoice.customer_id;
      const firstSource = src(c.source_invoices[0]!);
      const history = W.bundles.filter((b) => b.invoice.customer_id === customer && b.invoice.invoice_number < firstSource.invoice.invoice_number);
      expect(c.features).toEqual(featuresFor(c.current, [...history, c.previous]));
      expect(c.state.comparison.gap_days).toBe(c.gap_days);
      expect(c.state.current.from_pending_delivery).toBe(customer === "C2");
      expect(c.state.previous.from_pending_delivery).toBe(customer === "C2");
    }
  });

  it("puts no id-like keys in the states", () => {
    const keys = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(keys) : v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];
    for (const c of cases) {
      for (const k of keys(c.state)) expect(k).not.toMatch(/_id$|^id$|invoice_number|seller|city|customer_(id|name)/);
    }
  });

  it("is deterministic per seed", () => {
    const again = plantCases(input, options);
    expect(again.map((c) => [c.case_id, c.source_invoices, c.state])).toEqual(cases.map((c) => [c.case_id, c.source_invoices, c.state]));
    const other = plantCases(input, { ...options, seed: 8 });
    expect(other.map((c) => c.source_invoices)).not.toEqual(cases.map((c) => c.source_invoices));
  });

  it("throws, naming the split and kind, when there are too few candidates", () => {
    expect(() => plantCases(input, { ...options, perLabel: 500 })).toThrow(/tune.*moved|moved.*tune/);
  });

  it("rejects bad options", () => {
    expect(() => plantCases(input, { ...options, perLabel: 0 })).toThrow(/perLabel/);
    expect(() => plantCases(input, { ...options, gapWeights: new Map([[1, 0]]) })).toThrow(/gap/);
    expect(() => plantCases(input, { ...options, gapWeights: new Map([[3, 1]]) })).toThrow(/gap/);
    expect(() => plantCases(input, { ...options, changedPerSplit: -1 })).toThrow(/changedPerSplit/);
    expect(() => plantCases(input, { ...options, changedPerSplit: 7 })).toThrow(/changedPerSplit/);
  });
});
