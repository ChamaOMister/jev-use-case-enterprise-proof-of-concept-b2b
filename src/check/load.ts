import { SPLIT_SQL, type Db, type Row } from "../data/db.js";
import { SPLITS, type Catalog, type Customer, type Installment, type Invoice, type InvoiceBundle, type Line, type Product, type Split } from "./types.js";

function text(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`Column ${key}: expected text, got ${JSON.stringify(v)}`);
  return v;
}

function int(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`Column ${key}: expected an integer, got ${JSON.stringify(v)}`);
  return v;
}

function split(row: Row): Split {
  const v = text(row, "split");
  if (!(SPLITS as readonly string[]).includes(v)) throw new Error(`Unknown split ${v}`);
  return v as Split;
}

/**
 * Loads every invoice with its lines and installments, plus the master-data catalog.
 * Dates are cast to text in SQL so they stay calendar dates, untouched by time zones.
 */
export async function loadBundles(db: Db): Promise<{ bundles: InvoiceBundle[]; catalog: Catalog }> {
  const invoices = await db.all(`
    SELECT CAST(invoice_number AS VARCHAR) AS invoice_number, CAST(billing_date AS VARCHAR) AS billing_date,
           customer_id, seller_id, business_unit, payment_schedule, line_count,
           invoice_total_cents, commission_total_cents, times_sent, ${SPLIT_SQL} AS split
    FROM invoices ORDER BY length(CAST(invoice_number AS VARCHAR)), invoice_number`);
  const lines = await db.all(`
    SELECT CAST(invoice_number AS VARCHAR) AS invoice_number, line_number, CAST(billing_date AS VARCHAR) AS billing_date,
           customer_id, seller_id, business_unit, product_id, product_name, product_category,
           package_quantity, unit_price_cents, line_amount_cents, commission_amount_cents
    FROM invoice_lines ORDER BY invoice_number, line_number`);
  const installments = await db.all(`
    SELECT CAST(invoice_number AS VARCHAR) AS invoice_number, customer_id, installment_number,
           CAST(due_date AS VARCHAR) AS due_date, amount_cents
    FROM scheduled_installments ORDER BY invoice_number, installment_number`);
  const customers = await db.all(`SELECT customer_id, seller_id, business_unit FROM customers`);
  const products = await db.all(`SELECT product_id, product_name, product_category, business_unit FROM products`);

  const byNumber = new Map<string, InvoiceBundle>();
  for (const r of invoices) {
    const invoice: Invoice = {
      invoice_number: text(r, "invoice_number"),
      billing_date: text(r, "billing_date"),
      customer_id: text(r, "customer_id"),
      seller_id: text(r, "seller_id"),
      business_unit: text(r, "business_unit"),
      payment_schedule: text(r, "payment_schedule"),
      line_count: int(r, "line_count"),
      invoice_total_cents: int(r, "invoice_total_cents"),
      commission_total_cents: int(r, "commission_total_cents"),
      times_sent: int(r, "times_sent"),
      split: split(r),
    };
    byNumber.set(invoice.invoice_number, { invoice, lines: [], installments: [] });
  }

  const owner = (invoiceNumber: string, what: string): InvoiceBundle => {
    const b = byNumber.get(invoiceNumber);
    if (!b) throw new Error(`${what} refers to unknown invoice ${invoiceNumber}`);
    return b;
  };

  for (const r of lines) {
    const line: Line = {
      invoice_number: text(r, "invoice_number"),
      line_number: int(r, "line_number"),
      billing_date: text(r, "billing_date"),
      customer_id: text(r, "customer_id"),
      seller_id: text(r, "seller_id"),
      business_unit: text(r, "business_unit"),
      product_id: text(r, "product_id"),
      product_name: text(r, "product_name"),
      product_category: text(r, "product_category"),
      package_quantity: int(r, "package_quantity"),
      unit_price_cents: int(r, "unit_price_cents"),
      line_amount_cents: int(r, "line_amount_cents"),
      commission_amount_cents: int(r, "commission_amount_cents"),
    };
    owner(line.invoice_number, "invoice line").lines.push(line);
  }

  for (const r of installments) {
    const inst: Installment = {
      invoice_number: text(r, "invoice_number"),
      customer_id: text(r, "customer_id"),
      installment_number: int(r, "installment_number"),
      due_date: text(r, "due_date"),
      amount_cents: int(r, "amount_cents"),
    };
    owner(inst.invoice_number, "installment").installments.push(inst);
  }

  const catalog: Catalog = {
    customers: new Map(
      customers.map((r): [string, Customer] => [
        text(r, "customer_id"),
        { customer_id: text(r, "customer_id"), seller_id: text(r, "seller_id"), business_unit: text(r, "business_unit") },
      ]),
    ),
    products: new Map(
      products.map((r): [string, Product] => [
        text(r, "product_id"),
        {
          product_id: text(r, "product_id"),
          product_name: text(r, "product_name"),
          product_category: text(r, "product_category"),
          business_unit: text(r, "business_unit"),
        },
      ]),
    ),
  };

  return { bundles: [...byNumber.values()], catalog };
}
