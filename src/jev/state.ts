/**
 * Phase 3: the state Jev sees for one jev-routed invoice. Only the invoice, the customer's previous
 * invoice and Phase 2 features: never ids, names of customers or sellers, cities, the customers.*
 * summary columns, or anything from later invoices.
 */
import type { InvoiceBundle } from "../check/types.js";
import type { Features } from "../features/features.js";

export interface StateLine {
  product_name: string;
  product_category: string;
  package_quantity: number;
  unit_price_cents: number;
  line_amount_cents: number;
}

export interface StateInvoice {
  billing_date: string;
  payment_schedule: string;
  total_cents: number;
  from_pending_delivery: boolean;
  lines: StateLine[];
}

export interface JevState {
  current: StateInvoice;
  previous: StateInvoice;
  comparison: Pick<
    Features,
    "gap_days" | "shared_products" | "product_jaccard" | "shared_same_qty" | "total_ratio" | "same_payment_schedule" | "union_matches_past_basket"
  >;
  customer_history: Pick<
    Features,
    | "prior_invoice_count"
    | "tenure_days"
    | "median_gap_days"
    | "prior_short_gap_share"
    | "invoices_last_7_days"
    | "total_vs_median"
    | "new_products"
  >;
}

export interface StateInput {
  current: InvoiceBundle;
  /** The customer's previous invoice: must be `features.prev_invoice_number`. */
  previous: InvoiceBundle;
  /** The current invoice's Phase 2 features. */
  features: Features;
  /** invoices.from_pending_delivery by invoice_number (an invoice-header field, known on arrival). */
  fromPendingDelivery: ReadonlyMap<string, boolean>;
}

function describeInvoice({ invoice, lines }: InvoiceBundle, fromPendingDelivery: ReadonlyMap<string, boolean>): StateInvoice {
  const pending = fromPendingDelivery.get(invoice.invoice_number);
  if (pending === undefined) throw new Error(`No from_pending_delivery for invoice ${invoice.invoice_number}`);
  return {
    billing_date: invoice.billing_date,
    payment_schedule: invoice.payment_schedule,
    total_cents: invoice.invoice_total_cents,
    from_pending_delivery: pending,
    lines: lines.map((l) => ({
      product_name: l.product_name,
      product_category: l.product_category,
      package_quantity: l.package_quantity,
      unit_price_cents: l.unit_price_cents,
      line_amount_cents: l.line_amount_cents,
    })),
  };
}

export function stateFor({ current, previous, features: f, fromPendingDelivery }: StateInput): JevState {
  if (f.prev_invoice_number !== previous.invoice.invoice_number) {
    throw new Error(
      `Invoice ${current.invoice.invoice_number}: previous invoice ${previous.invoice.invoice_number} is not the features' ${f.prev_invoice_number}`,
    );
  }
  return {
    current: describeInvoice(current, fromPendingDelivery),
    previous: describeInvoice(previous, fromPendingDelivery),
    comparison: {
      gap_days: f.gap_days,
      shared_products: f.shared_products,
      product_jaccard: f.product_jaccard,
      shared_same_qty: f.shared_same_qty,
      total_ratio: f.total_ratio,
      same_payment_schedule: f.same_payment_schedule,
      union_matches_past_basket: f.union_matches_past_basket,
    },
    customer_history: {
      prior_invoice_count: f.prior_invoice_count,
      tenure_days: f.tenure_days,
      median_gap_days: f.median_gap_days,
      prior_short_gap_share: f.prior_short_gap_share,
      invoices_last_7_days: f.invoices_last_7_days,
      total_vs_median: f.total_vs_median,
      new_products: f.new_products,
    },
  };
}
