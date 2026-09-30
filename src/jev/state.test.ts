import { describe, expect, it } from "vitest";
import { bundle, type LineSpec } from "../check/test-fixtures.js";
import { featuresFor } from "../features/features.js";
import { stateFor, type JevState } from "./state.js";

const earlierLines: LineSpec[] = [{ product_id: "P2", qty: 1, price: 5000 }];
const previousLines: LineSpec[] = [
  { product_id: "P1", qty: 10, price: 1000 },
  { product_id: "P2", qty: 2, price: 5000 },
];
const currentLines: LineSpec[] = [{ product_id: "P1", qty: 10, price: 1000 }];

const earlier = bundle({ invoice_number: "000001", billing_date: "2025-02-01", lines: earlierLines });
const previous = bundle({ invoice_number: "000002", billing_date: "2025-03-09", lines: previousLines, payment_schedule: "30 Days" });
const current = bundle({ invoice_number: "000003", billing_date: "2025-03-10", lines: currentLines });
const features = featuresFor(current, [earlier, previous]);
const fromPendingDelivery = new Map([
  ["000002", true],
  ["000003", false],
]);
const state = stateFor({ current, previous, features, fromPendingDelivery });

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  }
  return [];
}

describe("stateFor", () => {
  it("has exactly the sections current, previous, comparison and customer_history", () => {
    expect(Object.keys(state).sort()).toEqual(["comparison", "current", "customer_history", "previous"]);
  });

  it("describes the current invoice by its header fields and lines", () => {
    expect(state.current).toEqual({
      billing_date: "2025-03-10",
      payment_schedule: "Upfront",
      total_cents: 10_000,
      from_pending_delivery: false,
      lines: [
        { product_name: "Foliar Nutrient 1 L", product_category: "Foliar fertilizer", package_quantity: 10, unit_price_cents: 1000, line_amount_cents: 10_000 },
      ],
    });
  });

  it("includes the previous invoice's header fields and all its lines", () => {
    expect(state.previous).toEqual({
      billing_date: "2025-03-09",
      payment_schedule: "30 Days",
      total_cents: 20_000,
      from_pending_delivery: true,
      lines: [
        { product_name: "Foliar Nutrient 1 L", product_category: "Foliar fertilizer", package_quantity: 10, unit_price_cents: 1000, line_amount_cents: 10_000 },
        { product_name: "Foliar Nutrient 5 L", product_category: "Foliar fertilizer", package_quantity: 2, unit_price_cents: 5000, line_amount_cents: 10_000 },
      ],
    });
  });

  it("takes the comparison section from the Phase 2 features", () => {
    expect(state.comparison).toEqual({
      gap_days: features.gap_days,
      shared_products: features.shared_products,
      product_jaccard: features.product_jaccard,
      shared_same_qty: features.shared_same_qty,
      total_ratio: features.total_ratio,
      same_payment_schedule: features.same_payment_schedule,
      union_matches_past_basket: features.union_matches_past_basket,
    });
  });

  it("takes the customer_history section from the Phase 2 features", () => {
    expect(state.customer_history).toEqual({
      prior_invoice_count: 2,
      tenure_days: features.tenure_days,
      median_gap_days: features.median_gap_days,
      prior_short_gap_share: features.prior_short_gap_share,
      invoices_last_7_days: features.invoices_last_7_days,
      total_vs_median: features.total_vs_median,
      new_products: 0,
    });
  });

  it("has no id-like keys anywhere", () => {
    const idLike = allKeys(state).filter((k) => /(^|_)(ids?|numbers?)$|^customer_(name|city)$|seller|city/i.test(k));
    expect(idLike).toEqual([]);
  });

  it("contains no invoice numbers or customer, seller or product ids as values", () => {
    const json = JSON.stringify(state);
    for (const id of ["000001", "000002", "000003", '"C1"', '"S1"', '"P1"', '"P2"']) expect(json).not.toContain(id);
  });

  it("refuses a previous invoice that is not the features' previous invoice", () => {
    expect(() => stateFor({ current, previous: earlier, features, fromPendingDelivery })).toThrow(/previous invoice/);
  });

  it("refuses an invoice whose from_pending_delivery is unknown", () => {
    expect(() => stateFor({ current, previous, features, fromPendingDelivery: new Map() })).toThrow(/from_pending_delivery/);
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(state)) as JevState).toEqual(state);
  });
});
