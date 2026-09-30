/** Evaluation split by billing date (see SPLIT_SQL). */
export type Split = "tune" | "test" | "demo";
export const SPLITS: readonly Split[] = ["tune", "test", "demo"];

export interface Invoice {
  /** Zero-padded; its order never goes backwards in billing date. */
  invoice_number: string;
  /** YYYY-MM-DD */
  billing_date: string;
  customer_id: string;
  seller_id: string;
  business_unit: string;
  payment_schedule: string;
  line_count: number;
  invoice_total_cents: number;
  commission_total_cents: number;
  times_sent: number;
  split: Split;
}

export interface Line {
  invoice_number: string;
  line_number: number;
  billing_date: string;
  customer_id: string;
  seller_id: string;
  business_unit: string;
  product_id: string;
  product_name: string;
  product_category: string;
  package_quantity: number;
  unit_price_cents: number;
  line_amount_cents: number;
  commission_amount_cents: number;
}

export interface Installment {
  invoice_number: string;
  customer_id: string;
  installment_number: number;
  /** YYYY-MM-DD */
  due_date: string;
  amount_cents: number;
}

/** One invoice with its own lines and installments: everything a rule may read about the invoice itself. */
export interface InvoiceBundle {
  invoice: Invoice;
  lines: Line[];
  installments: Installment[];
}

/** Master data only. The customers.* summary columns are whole-period aggregates and are never loaded. */
export interface Customer {
  customer_id: string;
  seller_id: string;
  business_unit: string;
}

export interface Product {
  product_id: string;
  product_name: string;
  product_category: string;
  business_unit: string;
}

export interface Catalog {
  customers: ReadonlyMap<string, Customer>;
  products: ReadonlyMap<string, Product>;
}

export type Outcome = "pass" | "flag" | "ambiguous";
export const OUTCOMES: readonly Outcome[] = ["pass", "flag", "ambiguous"];

export interface RuleResult {
  rule: string;
  outcome: Outcome;
  /** Why the rule flagged or was ambiguous; on a pass, informational notes (usually empty). */
  reasons: string[];
}

/** excluded = out of scope (times_sent > 1); human_review = a rule flagged; jev = ambiguous, for Phase 3. */
export type Route = "auto_approve" | "human_review" | "jev" | "excluded";
export const ROUTES: readonly Route[] = ["auto_approve", "jev", "human_review", "excluded"];
