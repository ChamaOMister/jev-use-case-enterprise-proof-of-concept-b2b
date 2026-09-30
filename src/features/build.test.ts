import { describe, expect, it } from "vitest";
import { bundle, type LineSpec } from "../check/test-fixtures.js";
import { buildFeatures } from "./build.js";

const inv = (invoice_number: string, billing_date: string, customer_id: string, lines: LineSpec[]) =>
  bundle({ invoice_number, billing_date, customer_id, lines });

const P1 = { product_id: "P1", qty: 2, price: 1000 };
const P2 = { product_id: "P2", qty: 1, price: 3000 };

// Two interleaved customers with short and long gaps, split orders and repeated baskets.
const FIXTURE = [
  inv("000001", "2025-01-02", "C1", [P1, P2]),
  inv("000002", "2025-01-03", "C2", [P1]),
  inv("000003", "2025-01-10", "C1", [P1]),
  inv("000004", "2025-01-11", "C1", [P2]),
  inv("000005", "2025-01-11", "C2", [P2, P1]),
  inv("000006", "2025-02-01", "C2", [{ ...P1, qty: 5 }]),
  inv("000007", "2025-02-02", "C1", [P1, P2]),
  inv("000008", "2025-02-03", "C2", [P2]),
  inv("000009", "2025-02-20", "C1", [{ ...P2, qty: 4 }]),
];

describe("buildFeatures", () => {
  it("never lets an invoice see the future: features of the first k invoices don't change when later ones are added", () => {
    const all = buildFeatures(FIXTURE);
    for (let k = 0; k <= FIXTURE.length; k++) {
      expect(buildFeatures(FIXTURE.slice(0, k)), `k = ${k}`).toEqual(all.slice(0, k));
    }
  });

  it("returns results in invoice_number order whatever the input order", () => {
    const shuffled = [4, 0, 8, 2, 6, 1, 7, 3, 5].map((i) => FIXTURE[i]!);
    expect(buildFeatures(shuffled)).toEqual(buildFeatures(FIXTURE));
    expect(buildFeatures(shuffled).map((r) => r.invoice_number)).toEqual(FIXTURE.map((b) => b.invoice.invoice_number));
  });

  it("only uses the same customer's invoices", () => {
    const onlyC1 = FIXTURE.filter((b) => b.invoice.customer_id === "C1");
    const c1Numbers = new Set(onlyC1.map((b) => b.invoice.invoice_number));
    expect(buildFeatures(onlyC1)).toEqual(buildFeatures(FIXTURE).filter((r) => c1Numbers.has(r.invoice_number)));
  });

  it("uses the customer's latest earlier invoice as prev", () => {
    const byNumber = new Map(buildFeatures(FIXTURE).map((r) => [r.invoice_number, r.features]));
    expect(byNumber.get("000004")?.prev_invoice_number).toBe("000003");
    expect(byNumber.get("000005")?.prev_invoice_number).toBe("000002");
    expect(byNumber.get("000001")?.prev_invoice_number).toBeNull();
  });

  it("throws when two bundles share an invoice_number", () => {
    const dup = inv("000003", "2025-01-10", "C2", [P2]);
    expect(() => buildFeatures([...FIXTURE, dup])).toThrow(/000003/);
  });
});
