import type { InvoiceBundle, Line } from "./types.js";

/** Orders zero-padded invoice numbers numerically, even if the padding width ever grows. */
export function compareInvoiceNumbers(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** The products and quantities on an invoice, independent of line order. */
export function lineSignature(lines: readonly Line[]): string {
  return lines
    .map((l) => `${l.product_id}×${l.package_quantity}`)
    .sort()
    .join(",");
}

export interface PastInvoice {
  invoice_number: string;
  billing_date: string;
  signature: string;
  /** The distinct products billed on it. */
  products: ReadonlySet<string>;
}

/**
 * Everything an invoice is allowed to know about the past: the invoices already checked, which
 * are exactly those with a smaller invoice_number. `add` refuses to go backwards, so a rule can
 * never see an invoice's future.
 */
export class History {
  private last: string | null = null;
  private readonly byCustomer = new Map<string, PastInvoice[]>();
  /** product → year → price → number of lines billed at that price. */
  private readonly prices = new Map<string, Map<number, Map<number, number>>>();

  add({ invoice, lines }: InvoiceBundle): void {
    if (this.last !== null && compareInvoiceNumbers(invoice.invoice_number, this.last) <= 0) {
      throw new Error(`History must grow in invoice_number order: ${invoice.invoice_number} after ${this.last}`);
    }
    this.last = invoice.invoice_number;

    const past = this.byCustomer.get(invoice.customer_id) ?? [];
    past.push({
      invoice_number: invoice.invoice_number,
      billing_date: invoice.billing_date,
      signature: lineSignature(lines),
      products: new Set(lines.map((l) => l.product_id)),
    });
    this.byCustomer.set(invoice.customer_id, past);

    for (const l of lines) {
      const years = this.prices.get(l.product_id) ?? new Map<number, Map<number, number>>();
      const year = yearOf(l.billing_date);
      const counts = years.get(year) ?? new Map<number, number>();
      counts.set(l.unit_price_cents, (counts.get(l.unit_price_cents) ?? 0) + 1);
      years.set(year, counts);
      this.prices.set(l.product_id, years);
    }
  }

  /** The customer's earlier invoices, oldest first. */
  customerInvoices(customerId: string): readonly PastInvoice[] {
    return this.byCustomer.get(customerId) ?? [];
  }

  /** The most common earlier price of a product in a calendar year; ties go to the price seen first. */
  listPrice(productId: string, year: number): number | undefined {
    let best: [number, number] | undefined;
    for (const [price, count] of this.prices.get(productId)?.get(year) ?? []) {
      if (!best || count > best[1]) best = [price, count];
    }
    return best?.[0];
  }

  /** The latest calendar year before `year` in which the product was billed. */
  latestYearBefore(productId: string, year: number): number | undefined {
    const earlier = [...(this.prices.get(productId)?.keys() ?? [])].filter((y) => y < year);
    return earlier.length > 0 ? Math.max(...earlier) : undefined;
  }
}

export const yearOf = (isoDate: string): number => Number(isoDate.slice(0, 4));
