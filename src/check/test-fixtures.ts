/**
 * Hand-built fixtures for the rule tests. Deliberately computes amounts, commissions and
 * installments its own way (not with the rule helpers), so the tests don't check the code against itself.
 */
import type { Catalog, InvoiceBundle, Split } from "./types.js";

export const CATALOG: Catalog = {
  customers: new Map([
    ["C1", { customer_id: "C1", seller_id: "S1", business_unit: "Agro" }],
    ["C2", { customer_id: "C2", seller_id: "S2", business_unit: "Agro" }],
    ["C9", { customer_id: "C9", seller_id: "S9", business_unit: "Home & Garden" }],
  ]),
  products: new Map([
    ["P1", { product_id: "P1", product_name: "Foliar Nutrient 1 L", product_category: "Foliar fertilizer", business_unit: "Agro" }],
    ["P2", { product_id: "P2", product_name: "Foliar Nutrient 5 L", product_category: "Foliar fertilizer", business_unit: "Agro" }],
    ["P9", { product_id: "P9", product_name: "Garden Plant Food 2 kg", product_category: "Garden fertilizer", business_unit: "Home & Garden" }],
  ]),
};

const DUE_OFFSETS: Record<string, number[]> = {
  Upfront: [0],
  "30 Days": [30],
  "3 installments (30, 60 and 90 days)": [30, 60, 90],
  "4 installments (Upfront, 30, 60 and 90 days)": [0, 30, 60, 90],
};

export interface LineSpec {
  product_id: string;
  qty: number;
  price: number;
}

export interface InvoiceSpec {
  invoice_number: string;
  billing_date?: string;
  customer_id?: string;
  payment_schedule?: string;
  times_sent?: number;
  split?: Split;
  lines?: LineSpec[];
}

function plusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A fully consistent invoice: every rule passes on it unless the test breaks something. */
export function bundle(spec: InvoiceSpec): InvoiceBundle {
  const billing_date = spec.billing_date ?? "2025-03-10";
  const customer = CATALOG.customers.get(spec.customer_id ?? "C1");
  if (!customer) throw new Error(`Fixture customer ${spec.customer_id} is not in CATALOG`);
  const payment_schedule = spec.payment_schedule ?? "Upfront";
  const specs = spec.lines ?? [{ product_id: "P1", qty: 10, price: 1000 }];

  const lines = specs.map((l, i) => {
    const product = CATALOG.products.get(l.product_id);
    if (!product) throw new Error(`Fixture product ${l.product_id} is not in CATALOG`);
    const amount = l.qty * l.price;
    return {
      invoice_number: spec.invoice_number,
      line_number: i + 1,
      billing_date,
      customer_id: customer.customer_id,
      seller_id: customer.seller_id,
      business_unit: customer.business_unit,
      product_id: product.product_id,
      product_name: product.product_name,
      product_category: product.product_category,
      package_quantity: l.qty,
      unit_price_cents: l.price,
      line_amount_cents: amount,
      commission_amount_cents: Math.round(amount / 20),
    };
  });
  const total = lines.reduce((s, l) => s + l.line_amount_cents, 0);

  const offsets = DUE_OFFSETS[payment_schedule] ?? [0];
  const amounts = offsets.map(() => 0);
  for (let cent = 0; cent < total; cent++) amounts[cent % offsets.length]! += 1;

  return {
    invoice: {
      invoice_number: spec.invoice_number,
      billing_date,
      customer_id: customer.customer_id,
      seller_id: customer.seller_id,
      business_unit: customer.business_unit,
      payment_schedule,
      line_count: lines.length,
      invoice_total_cents: total,
      commission_total_cents: lines.reduce((s, l) => s + l.commission_amount_cents, 0),
      times_sent: spec.times_sent ?? 1,
      split: spec.split ?? "tune",
    },
    lines,
    installments: offsets.map((offset, i) => ({
      invoice_number: spec.invoice_number,
      customer_id: customer.customer_id,
      installment_number: i + 1,
      due_date: plusDays(billing_date, offset),
      amount_cents: amounts[i]!,
    })),
  };
}
