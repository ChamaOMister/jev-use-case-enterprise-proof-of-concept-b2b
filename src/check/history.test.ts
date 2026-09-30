import { describe, it, expect } from "vitest";
import { History, lineSignature } from "./history.js";
import { bundle } from "./test-fixtures.js";

describe("history", () => {
  describe("lineSignature", () => {
    it("gives the same string for the same products and quantities in a different line order", () => {
      const b1 = bundle({
        invoice_number: "1",
        lines: [
          { product_id: "P1", qty: 10, price: 1000 },
          { product_id: "P2", qty: 5, price: 2000 },
        ],
      });
      const b2 = bundle({
        invoice_number: "2",
        lines: [
          { product_id: "P2", qty: 5, price: 2000 },
          { product_id: "P1", qty: 10, price: 1000 },
        ],
      });
      expect(lineSignature(b1.lines)).toBe(lineSignature(b2.lines));
    });

    it("gives different strings when only a quantity differs", () => {
      const b1 = bundle({
        invoice_number: "1",
        lines: [{ product_id: "P1", qty: 10, price: 1000 }],
      });
      const b2 = bundle({
        invoice_number: "2",
        lines: [{ product_id: "P1", qty: 11, price: 1000 }],
      });
      expect(lineSignature(b1.lines)).not.toBe(lineSignature(b2.lines));
    });
  });

  describe("History", () => {
    it("History.customerInvoices returns an empty array for a customer with no invoices", () => {
      const history = new History();
      expect(history.customerInvoices("C1")).toEqual([]);
    });

    it("customerInvoices returns the customer's invoices oldest first and leaves out other customers'", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000001", customer_id: "C1", billing_date: "2025-01-01" }));
      history.add(bundle({ invoice_number: "000002", customer_id: "C2", billing_date: "2025-01-02" }));
      history.add(bundle({ invoice_number: "000003", customer_id: "C1", billing_date: "2025-01-03" }));

      const invoices = history.customerInvoices("C1");
      expect(invoices).toHaveLength(2);
      expect(invoices[0]?.invoice_number).toBe("000001");
      expect(invoices[1]?.invoice_number).toBe("000003");
    });

    it("listPrice returns undefined when the product has no sales in that year", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000001", lines: [{ product_id: "P1", qty: 1, price: 1000 }], billing_date: "2024-01-01" }));
      expect(history.listPrice("P1", 2025)).toBeUndefined();
    });

    it("listPrice returns the most common price. With two prices seen equally often, it returns the one seen first", () => {
      const history1 = new History();
      history1.add(bundle({ invoice_number: "000001", billing_date: "2025-01-01", lines: [{ product_id: "P1", qty: 1, price: 1200 }] }));
      history1.add(bundle({ invoice_number: "000002", billing_date: "2025-01-02", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      history1.add(bundle({ invoice_number: "000003", billing_date: "2025-01-03", lines: [{ product_id: "P1", qty: 1, price: 1200 }] }));
      expect(history1.listPrice("P1", 2025)).toBe(1200);

      const history2 = new History();
      history2.add(bundle({ invoice_number: "000001", billing_date: "2025-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      history2.add(bundle({ invoice_number: "000002", billing_date: "2025-01-02", lines: [{ product_id: "P1", qty: 1, price: 1200 }] }));
      expect(history2.listPrice("P1", 2025)).toBe(1000);
    });

    it("listPrice counts lines per calendar year separately", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000001", billing_date: "2024-12-31", lines: [{ product_id: "P1", qty: 1, price: 5000 }] }));
      history.add(bundle({ invoice_number: "000002", billing_date: "2025-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      expect(history.listPrice("P1", 2025)).toBe(1000);
    });

    it("latestYearBefore returns the latest calendar year before `year` in which the product was billed, or undefined", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000001", billing_date: "2023-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      history.add(bundle({ invoice_number: "000002", billing_date: "2024-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      history.add(bundle({ invoice_number: "000003", billing_date: "2026-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));

      expect(history.latestYearBefore("P1", 2026)).toBe(2024);
      expect(history.latestYearBefore("P1", 2023)).toBeUndefined();
    });

    it("latestYearBefore returns undefined when the product was billed only in that year or later", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000001", billing_date: "2026-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      history.add(bundle({ invoice_number: "000002", billing_date: "2027-01-01", lines: [{ product_id: "P1", qty: 1, price: 1000 }] }));
      expect(history.latestYearBefore("P1", 2026)).toBeUndefined();
    });

    it("History throws if invoice numbers do not increase in the order they are added", () => {
      const history = new History();
      history.add(bundle({ invoice_number: "000002" }));
      expect(() => history.add(bundle({ invoice_number: "000001" }))).toThrow(/History must grow/);
    });
  });
});
