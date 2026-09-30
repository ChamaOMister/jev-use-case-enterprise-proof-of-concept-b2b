import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { Db } from "../data/db.js";
import { loadBundles } from "./load.js";

async function fixtureDb(): Promise<Db> {
  const db = new Db(await (await DuckDBInstance.create(":memory:")).connect());
  await db.run(`CREATE TABLE invoices AS SELECT * FROM (VALUES
    ('000010', DATE '2025-12-31', 'C1', 'S1', 'Agro', 'Upfront', 1, 3000, 150, 1),
    ('000009', DATE '2026-09-01', 'C1', 'S1', 'Agro', '30 Days', 2, 5000, 250, 2)
  ) t(invoice_number, billing_date, customer_id, seller_id, business_unit, payment_schedule,
      line_count, invoice_total_cents, commission_total_cents, times_sent)`);
  await db.run(`CREATE TABLE invoice_lines AS SELECT * FROM (VALUES
    ('000009', 2, DATE '2026-09-01', 'C1', 'S1', 'Agro', 'P1', 'Foliar 1 L', 'Foliar', 1, 2000, 2000, 100),
    ('000009', 1, DATE '2026-09-01', 'C1', 'S1', 'Agro', 'P1', 'Foliar 1 L', 'Foliar', 3, 1000, 3000, 150),
    ('000010', 1, DATE '2025-12-31', 'C1', 'S1', 'Agro', 'P1', 'Foliar 1 L', 'Foliar', 3, 1000, 3000, 150)
  ) t(invoice_number, line_number, billing_date, customer_id, seller_id, business_unit, product_id,
      product_name, product_category, package_quantity, unit_price_cents, line_amount_cents, commission_amount_cents)`);
  await db.run(`CREATE TABLE scheduled_installments AS SELECT * FROM (VALUES
    ('000009', 'C1', 1, DATE '2026-10-01', 5000),
    ('000010', 'C1', 1, DATE '2025-12-31', 3000)
  ) t(invoice_number, customer_id, installment_number, due_date, amount_cents)`);
  await db.run(`CREATE TABLE customers AS SELECT * FROM (VALUES
    ('C1', 'Secret Name Ltda', 'farm', 'S1', 'Agro', 99, 123456)
  ) t(customer_id, customer_name, segment, seller_id, business_unit, invoice_count, total_sales_cents)`);
  await db.run(`CREATE TABLE products AS SELECT * FROM (VALUES
    ('P1', 'Foliar 1 L', 'Foliar', 'Agro')
  ) t(product_id, product_name, product_category, business_unit)`);
  return db;
}

describe("loadBundles", () => {
  it("groups lines and installments under their invoice, sorted by invoice_number and line number", async () => {
    const { bundles } = await loadBundles(await fixtureDb());
    expect(bundles.map((b) => b.invoice.invoice_number)).toEqual(["000009", "000010"]);
    const [first] = bundles;
    expect(first?.lines.map((l) => l.line_number)).toEqual([1, 2]);
    expect(first?.installments).toEqual([
      { invoice_number: "000009", customer_id: "C1", installment_number: 1, due_date: "2026-10-01", amount_cents: 5000 },
    ]);
  });

  it("keeps dates as YYYY-MM-DD text and assigns the split by billing date", async () => {
    const { bundles } = await loadBundles(await fixtureDb());
    expect(bundles.map((b) => [b.invoice.billing_date, b.invoice.split])).toEqual([
      ["2026-09-01", "demo"],
      ["2025-12-31", "tune"],
    ]);
  });

  it("loads only master data for customers, never the whole-period summary columns", async () => {
    const { catalog } = await loadBundles(await fixtureDb());
    expect(catalog.customers.get("C1")).toEqual({ customer_id: "C1", seller_id: "S1", business_unit: "Agro" });
    expect(catalog.products.get("P1")).toEqual({
      product_id: "P1",
      product_name: "Foliar 1 L",
      product_category: "Foliar",
      business_unit: "Agro",
    });
  });

  it("refuses lines that point to an unknown invoice", async () => {
    const db = await fixtureDb();
    await db.run(`INSERT INTO invoice_lines VALUES
      ('000404', 1, DATE '2026-09-01', 'C1', 'S1', 'Agro', 'P1', 'Foliar 1 L', 'Foliar', 1, 10, 10, 1)`);
    await expect(loadBundles(db)).rejects.toThrow(/000404/);
  });
});
