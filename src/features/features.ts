/**
 * Phase 2: what Jev gets to see about an invoice. Every feature is computed from the invoice
 * itself and the same customer's earlier invoices only, never from the customers.* summary columns.
 */
import { daysBetween } from "../check/dates.js";
import { NEAR_DUPLICATE_DAYS } from "../check/rules.js";
import type { InvoiceBundle } from "../check/types.js";

export interface Features {
  prev_invoice_number: string | null;
  gap_days: number | null;
  shared_products: number | null;
  product_jaccard: number | null;
  shared_same_qty: number | null;
  total_ratio: number | null;
  same_payment_schedule: boolean | null;
  union_matches_past_basket: boolean | null;
  prior_invoice_count: number;
  tenure_days: number | null;
  median_gap_days: number | null;
  prior_short_gap_share: number | null;
  invoices_last_7_days: number;
  total_vs_median: number | null;
  new_products: number;
  line_count: number;
  invoice_total_cents: number;
  payment_schedule: string;
}

export const FEATURES: readonly { id: keyof Features; description: string }[] = [
  { id: "prev_invoice_number", description: "The customer's previous invoice (prev)" },
  { id: "gap_days", description: "Days from prev's billing date to this one" },
  { id: "shared_products", description: "Distinct products on both this invoice and prev" },
  { id: "product_jaccard", description: "Shared products / products on either (0..1)" },
  { id: "shared_same_qty", description: "Shared products whose summed quantity equals prev's" },
  { id: "total_ratio", description: "This total / prev's total" },
  { id: "same_payment_schedule", description: "Same payment schedule as prev" },
  {
    id: "union_matches_past_basket",
    description: "Products of this invoice ∪ prev equal the product set of an earlier invoice (other than prev)",
  },
  { id: "prior_invoice_count", description: "The customer's earlier invoices" },
  { id: "tenure_days", description: "Days from the customer's first invoice to this one" },
  { id: "median_gap_days", description: "Median days between the customer's consecutive earlier invoices" },
  { id: "prior_short_gap_share", description: `Share of those gaps that are ≤ ${NEAR_DUPLICATE_DAYS} days` },
  { id: "invoices_last_7_days", description: "Earlier invoices billed ≤ 7 days before this one" },
  { id: "total_vs_median", description: "This total / median of the customer's earlier totals" },
  { id: "new_products", description: "Products never billed to the customer before" },
  { id: "line_count", description: "Lines on this invoice" },
  { id: "invoice_total_cents", description: "This invoice's total" },
  { id: "payment_schedule", description: "This invoice's payment schedule" },
];

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const ratio = (num: number, den: number): number | null => (den === 0 ? null : round4(num / den));

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const products = (b: InvoiceBundle): Set<string> => new Set(b.lines.map((l) => l.product_id));

function quantities(b: InvoiceBundle): Map<string, number> {
  const q = new Map<string, number>();
  for (const l of b.lines) q.set(l.product_id, (q.get(l.product_id) ?? 0) + l.package_quantity);
  return q;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Features of `current`, given the same customer's earlier invoices, oldest first. */
export function featuresFor(current: InvoiceBundle, past: readonly InvoiceBundle[]): Features {
  const { invoice } = current;
  const prev = past.at(-1);
  const mine = products(current);

  let vsPrev: Pick<
    Features,
    | "prev_invoice_number"
    | "gap_days"
    | "shared_products"
    | "product_jaccard"
    | "shared_same_qty"
    | "total_ratio"
    | "same_payment_schedule"
    | "union_matches_past_basket"
  > = {
    prev_invoice_number: null,
    gap_days: null,
    shared_products: null,
    product_jaccard: null,
    shared_same_qty: null,
    total_ratio: null,
    same_payment_schedule: null,
    union_matches_past_basket: null,
  };
  if (prev) {
    const theirs = products(prev);
    const shared = [...mine].filter((p) => theirs.has(p));
    const union = new Set([...mine, ...theirs]);
    const myQty = quantities(current);
    const theirQty = quantities(prev);
    vsPrev = {
      prev_invoice_number: prev.invoice.invoice_number,
      gap_days: daysBetween(prev.invoice.billing_date, invoice.billing_date),
      shared_products: shared.length,
      product_jaccard: ratio(shared.length, union.size),
      shared_same_qty: shared.filter((p) => myQty.get(p) === theirQty.get(p)).length,
      total_ratio: ratio(invoice.invoice_total_cents, prev.invoice.invoice_total_cents),
      same_payment_schedule: invoice.payment_schedule === prev.invoice.payment_schedule,
      union_matches_past_basket: past.slice(0, -1).some((p) => sameSet(products(p), union)),
    };
  }

  const gaps = past.slice(1).map((p, i) => daysBetween(past[i]!.invoice.billing_date, p.invoice.billing_date));
  const pastMedianTotal = median(past.map((p) => p.invoice.invoice_total_cents));
  const seen = new Set(past.flatMap((p) => p.lines.map((l) => l.product_id)));

  return {
    ...vsPrev,
    prior_invoice_count: past.length,
    tenure_days: past[0] ? daysBetween(past[0].invoice.billing_date, invoice.billing_date) : null,
    median_gap_days: gaps.length > 0 ? median(gaps) : null,
    prior_short_gap_share: gaps.length > 0 ? round4(gaps.filter((g) => g <= NEAR_DUPLICATE_DAYS).length / gaps.length) : null,
    invoices_last_7_days: past.filter((p) => daysBetween(p.invoice.billing_date, invoice.billing_date) <= 7).length,
    total_vs_median: pastMedianTotal === null ? null : ratio(invoice.invoice_total_cents, pastMedianTotal),
    new_products: [...mine].filter((p) => !seen.has(p)).length,
    line_count: invoice.line_count,
    invoice_total_cents: invoice.invoice_total_cents,
    payment_schedule: invoice.payment_schedule,
  };
}
