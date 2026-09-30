import { describe, expect, it } from "vitest";
import { bundle, type InvoiceSpec, type LineSpec } from "../check/test-fixtures.js";
import { FEATURES, featuresFor, type Features } from "./features.js";

const inv = (invoice_number: string, billing_date: string, lines: LineSpec[], extra: Partial<InvoiceSpec> = {}) =>
  bundle({ invoice_number, billing_date, lines, ...extra });

const p1 = (qty = 1, price = 1000) => ({ product_id: "P1", qty, price });
const p2 = (qty = 1, price = 1000) => ({ product_id: "P2", qty, price });
const p9 = (qty = 1, price = 1000) => ({ product_id: "P9", qty, price });

describe("FEATURES", () => {
  it("describes exactly the fields that featuresFor returns", () => {
    const f = featuresFor(inv("000001", "2025-03-10", [p1()]), []);
    expect(FEATURES.map((d) => d.id).sort()).toEqual(Object.keys(f).sort());
  });
});

describe("without a past", () => {
  const f = featuresFor(inv("000001", "2025-03-10", [p1(), p2()]), []);

  it.each([
    "prev_invoice_number",
    "gap_days",
    "shared_products",
    "product_jaccard",
    "shared_same_qty",
    "total_ratio",
    "same_payment_schedule",
    "union_matches_past_basket",
    "tenure_days",
    "median_gap_days",
    "prior_short_gap_share",
    "total_vs_median",
  ] as const satisfies readonly (keyof Features)[])("%s is null", (id) => {
    expect(f[id]).toBeNull();
  });

  it("counts zero prior invoices and zero in the last 7 days", () => {
    expect(f.prior_invoice_count).toBe(0);
    expect(f.invoices_last_7_days).toBe(0);
  });

  it("counts every product as new", () => {
    expect(f.new_products).toBe(2);
  });
});

describe("invoice fields", () => {
  it("copies line_count, invoice_total_cents and payment_schedule", () => {
    const f = featuresFor(inv("000001", "2025-03-10", [p1(2, 500), p2(1, 700)], { payment_schedule: "30 Days" }), []);
    expect(f).toMatchObject({ line_count: 2, invoice_total_cents: 1700, payment_schedule: "30 Days" });
  });
});

describe("comparison with the previous invoice", () => {
  const older = inv("000001", "2025-01-01", [p9()]);
  const prev = inv("000002", "2025-03-10", [p1(3), p2(2)]);

  it("takes prev as the last past invoice", () => {
    const f = featuresFor(inv("000003", "2025-03-11", [p1()]), [older, prev]);
    expect(f.prev_invoice_number).toBe("000002");
  });

  it("measures gap_days from prev's billing date", () => {
    expect(featuresFor(inv("000003", "2025-03-12", [p1()]), [older, prev]).gap_days).toBe(2);
  });

  it("counts shared products and their Jaccard index", () => {
    const f = featuresFor(inv("000003", "2025-03-11", [p1(), p9()]), [prev]);
    expect(f.shared_products).toBe(1);
    expect(f.product_jaccard).toBe(0.3333); // {P1} / {P1, P2, P9}, rounded to 4 decimals
  });

  it("gives a Jaccard of 0 when no product is shared", () => {
    const f = featuresFor(inv("000003", "2025-03-11", [p9()]), [prev]);
    expect(f.shared_products).toBe(0);
    expect(f.product_jaccard).toBe(0);
  });

  it("counts shared products whose summed quantity is equal", () => {
    // P1: 1 + 2 = 3 on both; P2: 1 vs 2.
    const f = featuresFor(inv("000003", "2025-03-11", [p1(1), p2(1), p1(2)]), [prev]);
    expect(f.shared_same_qty).toBe(1);
  });

  it("divides the total by prev's total, rounded to 4 decimals", () => {
    // prev total = 5000; current = 1000.
    expect(featuresFor(inv("000003", "2025-03-11", [p1(1)]), [prev]).total_ratio).toBe(0.2);
    // 2000 / 3000 = 0.66666…
    const three = inv("000002", "2025-03-10", [p1(3)]);
    expect(featuresFor(inv("000003", "2025-03-11", [p1(2)]), [three]).total_ratio).toBe(0.6667);
  });

  it("gives a null total_ratio when prev's total is zero", () => {
    const zero = inv("000002", "2025-03-10", [p1(1, 0)]);
    expect(featuresFor(inv("000003", "2025-03-11", [p1()]), [zero]).total_ratio).toBeNull();
  });

  it("compares the payment schedule with prev's", () => {
    expect(featuresFor(inv("000003", "2025-03-11", [p1()]), [prev]).same_payment_schedule).toBe(true);
    expect(featuresFor(inv("000003", "2025-03-11", [p1()], { payment_schedule: "30 Days" }), [prev]).same_payment_schedule).toBe(false);
  });
});

describe("union_matches_past_basket", () => {
  const basket = inv("000001", "2025-01-10", [p1(), p2()]);
  const prev = inv("000002", "2025-03-10", [p1()]);

  it("is true when current ∪ prev equals an earlier invoice's product set", () => {
    expect(featuresFor(inv("000003", "2025-03-11", [p2()]), [basket, prev]).union_matches_past_basket).toBe(true);
  });

  it("is false when the union is a different set", () => {
    expect(featuresFor(inv("000003", "2025-03-11", [p9()]), [basket, prev]).union_matches_past_basket).toBe(false);
  });

  it("does not count prev itself as the earlier basket", () => {
    const prevBoth = inv("000002", "2025-03-10", [p1(), p2()]);
    expect(featuresFor(inv("000003", "2025-03-11", [p2()]), [prevBoth]).union_matches_past_basket).toBe(false);
  });
});

describe("customer history", () => {
  const past = [
    inv("000001", "2025-01-01", [p1(1)]), // total 1000
    inv("000002", "2025-01-02", [p1(4)]), // 1 day later, total 4000
    inv("000003", "2025-01-12", [p2(2)]), // 10 days later, total 2000
    inv("000004", "2025-01-15", [p2(3)]), // 3 days later, total 3000
  ];
  const current = inv("000005", "2025-01-19", [p1(5), p9(1)]); // total 6000

  it("counts the prior invoices", () => {
    expect(featuresFor(current, past).prior_invoice_count).toBe(4);
  });

  it("measures tenure from the first past invoice", () => {
    expect(featuresFor(current, past).tenure_days).toBe(18);
  });

  it("takes the median gap as the mean of the two middle gaps for an even count", () => {
    // Gaps 1, 10, 3 → 3; with a fifth invoice, gaps 1, 10, 3, 4 → (3 + 4) / 2.
    expect(featuresFor(current, past).median_gap_days).toBe(3);
    const five = [...past, inv("000005", "2025-01-19", [p1()])];
    expect(featuresFor(inv("000006", "2025-01-20", [p1()]), five).median_gap_days).toBe(3.5);
  });

  it("gives the share of past gaps that are short, rounded to 4 decimals", () => {
    // Gaps 1, 10, 3: only 1 is ≤ 2 days.
    expect(featuresFor(current, past).prior_short_gap_share).toBe(0.3333);
  });

  it("needs two past invoices for the gap features", () => {
    const f = featuresFor(current, past.slice(0, 1));
    expect(f.median_gap_days).toBeNull();
    expect(f.prior_short_gap_share).toBeNull();
    expect(f.tenure_days).toBe(18);
  });

  it("counts past invoices at most 7 days before the current one", () => {
    // 2025-01-12 is exactly 7 days before; 2025-01-02 is 17.
    expect(featuresFor(current, past).invoices_last_7_days).toBe(2);
  });

  it("divides the total by the median of past totals", () => {
    // Past totals 1000, 4000, 2000, 3000 → median 2500.
    expect(featuresFor(current, past).total_vs_median).toBe(2.4);
  });

  it("gives a null total_vs_median when the past median is zero", () => {
    const zero = [inv("000001", "2025-01-01", [p1(1, 0)])];
    expect(featuresFor(current, zero).total_vs_median).toBeNull();
  });

  it("counts products never billed to the customer before", () => {
    expect(featuresFor(current, past).new_products).toBe(1); // P9
  });
});
