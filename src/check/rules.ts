/**
 * Phase 1 deterministic rules. Each rule reads one invoice (with its lines and installments),
 * the master-data catalog, and the History of earlier invoices — never anything later.
 */
import { addDays, daysBetween } from "./dates.js";
import { lineSignature, yearOf, type History } from "./history.js";
import type { Catalog, InvoiceBundle, Outcome, RuleResult } from "./types.js";

export interface RuleContext {
  catalog: Catalog;
  history: History;
}

export interface Rule {
  id: string;
  description: string;
  evaluate: (bundle: InvoiceBundle, ctx: RuleContext) => Omit<RuleResult, "rule">;
}

/** Billed this many days or fewer after the customer's previous invoice → ambiguous. */
export const NEAR_DUPLICATE_DAYS = 2;
/** Identical products and quantities within this many days → flag. */
export const DUPLICATE_LINES_DAYS = 7;
/** Allowed change of a product's list price per year (observed: +3.6% … +4.8%). */
export const YEARLY_PRICE_CHANGE = { min: 0, max: 0.1 } as const;
/** Absorbs float error in price ratios so that exactly +10% is accepted. */
const RATIO_EPSILON = 1e-9;

const INSTALLMENT_SPACING_DAYS = 30;

/** Installment count and the offset of the first due date from the billing date. */
export const SCHEDULES: Readonly<Record<string, { installments: number; firstDueDays: number }>> = {
  Upfront: { installments: 1, firstDueDays: 0 },
  "30 Days": { installments: 1, firstDueDays: 30 },
  "3 installments (30, 60 and 90 days)": { installments: 3, firstDueDays: 30 },
  "4 installments (Upfront, 30, 60 and 90 days)": { installments: 4, firstDueDays: 0 },
};

/** 5% of a line amount, rounded half up. */
export function lineCommission(amountCents: number): number {
  return Math.floor((amountCents * 5 + 50) / 100);
}

/** Splits a total into `count` installments that differ by at most 1 cent, leftover cents first. */
export function splitInstallments(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const leftover = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < leftover ? 1 : 0));
}

const verdict = (reasons: string[], whenFound: Outcome = "flag") => ({
  outcome: reasons.length > 0 ? whenFound : ("pass" as Outcome),
  reasons,
});

const signedPct = (x: number): string => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}%`;

export const RULES: Rule[] = [
  {
    id: "line_arithmetic",
    description: "Every line: package_quantity ≥ 1, unit price > 0, line amount = quantity × unit price",
    evaluate({ lines }) {
      const reasons: string[] = [];
      for (const l of lines) {
        const at = `line ${l.line_number}`;
        if (!Number.isInteger(l.package_quantity) || l.package_quantity < 1) {
          reasons.push(`${at}: package_quantity ${l.package_quantity} is not a positive integer`);
        }
        if (l.unit_price_cents <= 0) reasons.push(`${at}: unit_price_cents ${l.unit_price_cents} is not positive`);
        const expected = l.package_quantity * l.unit_price_cents;
        if (l.line_amount_cents !== expected) {
          reasons.push(`${at}: line_amount_cents ${l.line_amount_cents} ≠ ${l.package_quantity} × ${l.unit_price_cents} = ${expected}`);
        }
      }
      return verdict(reasons);
    },
  },

  {
    id: "invoice_total",
    description: "Invoice total = Σ line amounts; line_count = number of lines; lines numbered 1..n",
    evaluate({ invoice, lines }) {
      const reasons: string[] = [];
      if (lines.length === 0) reasons.push("invoice has no lines");
      const sum = lines.reduce((s, l) => s + l.line_amount_cents, 0);
      if (invoice.invoice_total_cents !== sum) {
        reasons.push(`invoice_total_cents ${invoice.invoice_total_cents} ≠ Σ line amounts ${sum}`);
      }
      if (invoice.line_count !== lines.length) reasons.push(`line_count ${invoice.line_count} ≠ ${lines.length} lines`);
      const numbers = lines.map((l) => l.line_number).sort((a, b) => a - b);
      if (numbers.some((n, i) => n !== i + 1)) reasons.push(`line numbers [${numbers.join(", ")}] are not 1..${lines.length}`);
      return verdict(reasons);
    },
  },

  {
    id: "commission",
    description: "Each line's commission = 5% rounded half up; invoice commission = Σ line commissions",
    evaluate({ invoice, lines }) {
      const reasons: string[] = [];
      for (const l of lines) {
        const expected = lineCommission(l.line_amount_cents);
        if (l.commission_amount_cents !== expected) {
          reasons.push(`line ${l.line_number}: commission ${l.commission_amount_cents} ≠ 5% of ${l.line_amount_cents} = ${expected}`);
        }
      }
      const sum = lines.reduce((s, l) => s + l.commission_amount_cents, 0);
      if (invoice.commission_total_cents !== sum) {
        reasons.push(`commission_total_cents ${invoice.commission_total_cents} ≠ Σ line commissions ${sum}`);
      }
      return verdict(reasons);
    },
  },

  {
    id: "price_list",
    description:
      "Unit price = the product's list price for the year, as seen on earlier invoices; " +
      "a new year's first price must be +0% … +10% per year above the last list price",
    evaluate({ lines }, { history }) {
      const flags: string[] = [];
      const notes: string[] = [];
      for (const l of lines) {
        const at = `line ${l.line_number} (${l.product_id})`;
        const price = l.unit_price_cents;
        const year = yearOf(l.billing_date);

        const current = history.listPrice(l.product_id, year);
        if (current !== undefined) {
          if (price !== current) flags.push(`${at}: unit_price_cents ${price} ≠ ${year} list price ${current}`);
          continue;
        }

        const refYear = history.latestYearBefore(l.product_id, year);
        const ref = refYear === undefined ? undefined : history.listPrice(l.product_id, refYear);
        if (refYear === undefined || ref === undefined) {
          notes.push(`${at}: first time this product is billed; no reference price to check ${price} against`);
          continue;
        }

        const years = year - refYear;
        const ratio = price / ref;
        const maxRatio = (1 + YEARLY_PRICE_CHANGE.max) ** years;
        const text = `${at}: first ${year} price ${price} is ${signedPct(ratio - 1)} vs ${refYear} list price ${ref}`;
        if (ratio < 1 + YEARLY_PRICE_CHANGE.min - RATIO_EPSILON || ratio > maxRatio + RATIO_EPSILON) {
          flags.push(`${text}; allowed ${signedPct(YEARLY_PRICE_CHANGE.min)} … ${signedPct(maxRatio - 1)}`);
        } else {
          notes.push(text);
        }
      }
      return flags.length > 0 ? { outcome: "flag", reasons: flags } : { outcome: "pass", reasons: notes };
    },
  },

  {
    id: "payment_schedule",
    description:
      "Known schedule; installment count and first due date match it; 30 days apart; " +
      "amounts sum to the total, differ by ≤ 1 cent, leftover cents first",
    evaluate({ invoice, installments }) {
      const spec = SCHEDULES[invoice.payment_schedule];
      if (!spec) return verdict([`unknown payment_schedule ${JSON.stringify(invoice.payment_schedule)}`]);

      const reasons: string[] = [];
      const sorted = [...installments].sort((a, b) => a.installment_number - b.installment_number);
      if (sorted.length !== spec.installments) {
        reasons.push(`${sorted.length} installment(s); "${invoice.payment_schedule}" has ${spec.installments}`);
      }
      const numbers = sorted.map((i) => i.installment_number);
      if (numbers.some((n, i) => n !== i + 1)) reasons.push(`installment numbers [${numbers.join(", ")}] are not 1..${sorted.length}`);

      sorted.forEach((inst, i) => {
        const due = addDays(invoice.billing_date, spec.firstDueDays + i * INSTALLMENT_SPACING_DAYS);
        if (inst.due_date !== due) reasons.push(`installment ${inst.installment_number}: due ${inst.due_date}, expected ${due}`);
      });

      const sum = sorted.reduce((s, i) => s + i.amount_cents, 0);
      if (sum !== invoice.invoice_total_cents) {
        reasons.push(`installments sum to ${sum}; invoice total is ${invoice.invoice_total_cents}`);
      } else if (sorted.length > 0) {
        const expected = splitInstallments(sum, sorted.length);
        const actual = sorted.map((i) => i.amount_cents);
        if (actual.some((a, i) => a !== expected[i])) {
          reasons.push(`installment amounts [${actual.join(", ")}] should be [${expected.join(", ")}] (≤ 1 cent apart, leftover first)`);
        }
      }
      return verdict(reasons);
    },
  },

  {
    id: "party_consistency",
    description:
      "Invoice seller and business unit = the customer's; every line and installment matches the invoice header; " +
      "each product exists, belongs to the invoice's business unit and keeps its catalogue name and category",
    evaluate({ invoice, lines, installments }, { catalog }) {
      const reasons: string[] = [];
      const customer = catalog.customers.get(invoice.customer_id);
      if (!customer) {
        reasons.push(`unknown customer ${invoice.customer_id}`);
      } else {
        if (invoice.seller_id !== customer.seller_id) {
          reasons.push(`seller_id ${invoice.seller_id} ≠ customer's seller ${customer.seller_id}`);
        }
        if (invoice.business_unit !== customer.business_unit) {
          reasons.push(`business_unit ${invoice.business_unit} ≠ customer's ${customer.business_unit}`);
        }
      }

      const header = ["billing_date", "customer_id", "seller_id", "business_unit"] as const;
      for (const l of lines) {
        const at = `line ${l.line_number}`;
        for (const field of header) {
          if (l[field] !== invoice[field]) reasons.push(`${at}: ${field} ${l[field]} ≠ invoice ${invoice[field]}`);
        }
        const product = catalog.products.get(l.product_id);
        if (!product) {
          reasons.push(`${at}: unknown product ${l.product_id}`);
          continue;
        }
        if (product.business_unit !== invoice.business_unit) {
          reasons.push(`${at}: ${l.product_id} belongs to ${product.business_unit}, invoice is ${invoice.business_unit}`);
        }
        if (l.product_name !== product.product_name || l.product_category !== product.product_category) {
          reasons.push(
            `${at}: ${l.product_id} billed as "${l.product_name}" / "${l.product_category}", ` +
              `catalogue says "${product.product_name}" / "${product.product_category}"`,
          );
        }
      }

      for (const inst of installments) {
        if (inst.customer_id !== invoice.customer_id) {
          reasons.push(`installment ${inst.installment_number}: customer_id ${inst.customer_id} ≠ invoice ${invoice.customer_id}`);
        }
      }
      return verdict(reasons);
    },
  },

  {
    id: "duplicate_lines",
    description: `Same products and quantities as an invoice of the same customer ≤ ${DUPLICATE_LINES_DAYS} days earlier`,
    evaluate({ invoice, lines }, { history }) {
      const signature = lineSignature(lines);
      const reasons = history
        .customerInvoices(invoice.customer_id)
        .filter((p) => p.signature === signature && daysBetween(p.billing_date, invoice.billing_date) <= DUPLICATE_LINES_DAYS)
        .map((p) => `same products and quantities as ${p.invoice_number} (billed ${p.billing_date})`);
      return verdict(reasons);
    },
  },

  {
    id: "rebilled_products",
    description:
      `Billed ≤ ${NEAR_DUPLICATE_DAYS} days after the same customer's previous invoice with only products already on it ` +
      "(a partial rebill; Phase 4 found this rule catches them better than Jev)",
    evaluate({ invoice, lines }, { history }) {
      const previous = history.customerInvoices(invoice.customer_id).at(-1);
      if (!previous || daysBetween(previous.billing_date, invoice.billing_date) > NEAR_DUPLICATE_DAYS) return verdict([]);
      const products = [...new Set(lines.map((l) => l.product_id))].sort();
      if (products.length === 0 || products.some((p) => !previous.products.has(p))) return verdict([]);
      return verdict([`every product (${products.join(", ")}) was already on ${previous.invoice_number} (billed ${previous.billing_date})`]);
    },
  },

  {
    id: "near_duplicate_window",
    description: `Billed ≤ ${NEAR_DUPLICATE_DAYS} days after the same customer's previous invoice (Jev decides)`,
    evaluate({ invoice }, { history }) {
      const previous = history.customerInvoices(invoice.customer_id).at(-1);
      if (!previous) return verdict([]);
      const gap = daysBetween(previous.billing_date, invoice.billing_date);
      return verdict(
        gap <= NEAR_DUPLICATE_DAYS ? [`billed ${gap} day${gap === 1 ? "" : "s"} after ${previous.invoice_number} for the same customer`] : [],
        "ambiguous",
      );
    },
  },
];
