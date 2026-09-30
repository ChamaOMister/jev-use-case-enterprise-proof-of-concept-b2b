import { compareInvoiceNumbers } from "../check/history.js";
import type { InvoiceBundle } from "../check/types.js";
import { featuresFor, type Features } from "./features.js";

/**
 * Computes every invoice's features in invoice_number order. Each invoice sees only its
 * customer's earlier invoices and is appended to them afterwards, so no feature sees the future.
 */
export function buildFeatures(bundles: readonly InvoiceBundle[]): { invoice_number: string; features: Features }[] {
  const ordered = [...bundles].sort((a, b) => compareInvoiceNumbers(a.invoice.invoice_number, b.invoice.invoice_number));
  const byCustomer = new Map<string, InvoiceBundle[]>();
  return ordered.map((b, i) => {
    const { invoice_number, customer_id } = b.invoice;
    if (i > 0 && ordered[i - 1]!.invoice.invoice_number === invoice_number) {
      throw new Error(`Duplicate invoice_number ${invoice_number}`);
    }
    const past = byCustomer.get(customer_id) ?? [];
    const features = featuresFor(b, past);
    past.push(b);
    byCustomer.set(customer_id, past);
    return { invoice_number, features };
  });
}
