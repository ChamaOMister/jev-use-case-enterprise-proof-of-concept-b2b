import { describe, expect, it } from "vitest";
import { History } from "./history.js";
import { lineCommission, RULES, splitInstallments } from "./rules.js";
import { bundle, CATALOG, type InvoiceSpec } from "./test-fixtures.js";
import type { InvoiceBundle } from "./types.js";

function run(ruleId: string, b: InvoiceBundle, past: InvoiceBundle[] = []) {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No rule ${ruleId}`);
  const history = new History();
  for (const p of past) history.add(p);
  return rule.evaluate(b, { catalog: CATALOG, history });
}

const priced = (invoice_number: string, billing_date: string, price: number, extra: Partial<InvoiceSpec> = {}) =>
  bundle({ invoice_number, billing_date, lines: [{ product_id: "P1", qty: 3, price }], ...extra });

describe("fixtures", () => {
  it("every rule passes on a default fixture invoice with no history", () => {
    for (const rule of RULES) expect(run(rule.id, bundle({ invoice_number: "000001" })).outcome, rule.id).toBe("pass");
  });
});

describe("line_arithmetic", () => {
  it("flags a line whose amount is not quantity × unit price", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines[0]!.line_amount_cents += 1;
    const r = run("line_arithmetic", b);
    expect(r.outcome).toBe("flag");
    expect(r.reasons[0]).toMatch(/line 1/);
  });

  it("flags a non-positive quantity", () => {
    const b = bundle({ invoice_number: "000001", lines: [{ product_id: "P1", qty: 0, price: 1000 }] });
    expect(run("line_arithmetic", b).outcome).toBe("flag");
  });

  it("flags a non-positive unit price", () => {
    const b = bundle({ invoice_number: "000001", lines: [{ product_id: "P1", qty: 2, price: 0 }] });
    expect(run("line_arithmetic", b).outcome).toBe("flag");
  });
});

describe("invoice_total", () => {
  const twoLines = () =>
    bundle({ invoice_number: "000001", lines: [{ product_id: "P1", qty: 1, price: 500 }, { product_id: "P2", qty: 2, price: 700 }] });

  it("flags a total that differs from the sum of lines", () => {
    const b = twoLines();
    b.invoice.invoice_total_cents -= 1;
    expect(run("invoice_total", b).outcome).toBe("flag");
  });

  it("flags a line_count that differs from the number of lines", () => {
    const b = twoLines();
    b.invoice.line_count = 3;
    expect(run("invoice_total", b).outcome).toBe("flag");
  });

  it("flags a gap in line numbering", () => {
    const b = twoLines();
    b.lines[1]!.line_number = 3;
    expect(run("invoice_total", b).outcome).toBe("flag");
  });

  it("flags an invoice without lines", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines = [];
    b.invoice.line_count = 0;
    b.invoice.invoice_total_cents = 0;
    expect(run("invoice_total", b).outcome).toBe("flag");
  });
});

describe("commission", () => {
  it("is 5% per line rounded half up", () => {
    expect(lineCommission(10)).toBe(1); // 0.50 → 1
    expect(lineCommission(9)).toBe(0); // 0.45 → 0
    expect(lineCommission(29)).toBe(1); // 1.45 → 1
    expect(lineCommission(30)).toBe(2); // 1.50 → 2
    expect(lineCommission(343570)).toBe(17179);
  });

  it("flags a line commission that is off by a cent", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines[0]!.commission_amount_cents += 1;
    b.invoice.commission_total_cents += 1;
    const r = run("commission", b);
    expect(r.outcome).toBe("flag");
    expect(r.reasons).toHaveLength(1);
  });

  it("flags an invoice commission taken as 5% of the total instead of the sum of lines", () => {
    // Two lines of 10 cents: each line rounds 0.5 up to 1 (sum 2), but 5% of the 20-cent total is 1.
    const b = bundle({ invoice_number: "000001", lines: [{ product_id: "P1", qty: 1, price: 10 }, { product_id: "P2", qty: 1, price: 10 }] });
    expect(b.invoice.commission_total_cents).toBe(2);
    expect(run("commission", b).outcome).toBe("pass");
    b.invoice.commission_total_cents = 1;
    expect(run("commission", b).outcome).toBe("flag");
  });
});

describe("price_list", () => {
  it("passes with a note when the product has never been billed", () => {
    const r = run("price_list", priced("000001", "2025-03-10", 1000));
    expect(r.outcome).toBe("pass");
    expect(r.reasons[0]).toMatch(/no reference price/);
  });

  it("passes silently at this year's list price", () => {
    const r = run("price_list", priced("000002", "2025-06-01", 1000), [priced("000001", "2025-03-10", 1000)]);
    expect(r).toEqual({ outcome: "pass", reasons: [] });
  });

  it("flags a price that differs from this year's list price", () => {
    const r = run("price_list", priced("000002", "2025-06-01", 1010), [priced("000001", "2025-03-10", 1000)]);
    expect(r.outcome).toBe("flag");
    expect(r.reasons[0]).toMatch(/1010.*1000/);
  });

  it("takes the most common earlier price as this year's list price", () => {
    const past = [priced("000001", "2025-01-10", 1200), priced("000002", "2025-02-10", 1000), priced("000003", "2025-03-10", 1000)];
    expect(run("price_list", priced("000004", "2025-04-01", 1000), past).outcome).toBe("pass");
    expect(run("price_list", priced("000004", "2025-04-01", 1200), past).outcome).toBe("flag");
  });

  it("passes a new year's first price within +0% … +10% of last year's, with a note", () => {
    const r = run("price_list", priced("000002", "2026-01-05", 1040), [priced("000001", "2025-12-20", 1000)]);
    expect(r.outcome).toBe("pass");
    expect(r.reasons[0]).toMatch(/\+4\.0%/);
  });

  it("accepts exactly +10% and flags anything above", () => {
    const past = [priced("000001", "2025-12-20", 1000)];
    expect(run("price_list", priced("000002", "2026-01-05", 1100), past).outcome).toBe("pass");
    expect(run("price_list", priced("000002", "2026-01-05", 1101), past).outcome).toBe("flag");
  });

  it("accepts an unchanged price and flags a decrease at the new year", () => {
    const past = [priced("000001", "2025-12-20", 1000)];
    expect(run("price_list", priced("000002", "2026-01-05", 1000), past).outcome).toBe("pass");
    expect(run("price_list", priced("000002", "2026-01-05", 999), past).outcome).toBe("flag");
  });

  it("compounds the allowed change over a year without sales", () => {
    const past = [priced("000001", "2023-12-20", 1000)];
    expect(run("price_list", priced("000002", "2025-01-05", 1210), past).outcome).toBe("pass");
    expect(run("price_list", priced("000002", "2025-01-05", 1211), past).outcome).toBe("flag");
  });

  it("only compares a product with its own history", () => {
    const other = bundle({ invoice_number: "000001", lines: [{ product_id: "P2", qty: 1, price: 5000 }] });
    const r = run("price_list", priced("000002", "2025-06-01", 1000), [other]);
    expect(r.outcome).toBe("pass");
    expect(r.reasons[0]).toMatch(/no reference price/);
  });
});

describe("payment_schedule", () => {
  it.each([
    "Upfront",
    "30 Days",
    "3 installments (30, 60 and 90 days)",
    "4 installments (Upfront, 30, 60 and 90 days)",
  ])("passes a consistent %s invoice", (payment_schedule) => {
    const b = bundle({ invoice_number: "000001", payment_schedule, lines: [{ product_id: "P1", qty: 1, price: 1001 }] });
    expect(run("payment_schedule", b)).toEqual({ outcome: "pass", reasons: [] });
  });

  it("splits a total into installments that differ by at most a cent, leftover first", () => {
    expect(splitInstallments(100, 3)).toEqual([34, 33, 33]);
    expect(splitInstallments(101, 4)).toEqual([26, 25, 25, 25]);
    expect(splitInstallments(771270, 3)).toEqual([257090, 257090, 257090]);
    expect(splitInstallments(500, 1)).toEqual([500]);
  });

  const threeInstallments = () =>
    bundle({ invoice_number: "000001", payment_schedule: "3 installments (30, 60 and 90 days)", lines: [{ product_id: "P1", qty: 1, price: 100 }] });

  it("flags an unknown schedule label", () => {
    const b = threeInstallments();
    b.invoice.payment_schedule = "45 Days";
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });

  it("flags a missing installment", () => {
    const b = threeInstallments();
    b.installments.pop();
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });

  it("flags a first installment due on the billing date for a 30/60/90 schedule", () => {
    const b = threeInstallments();
    b.installments[0]!.due_date = b.invoice.billing_date;
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });

  it("flags installments that are not 30 days apart", () => {
    const b = threeInstallments();
    b.installments[2]!.due_date = "2025-06-09"; // 91 days after 2025-03-10
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });

  it("flags installments that do not sum to the total", () => {
    const b = threeInstallments();
    b.installments[2]!.amount_cents += 1;
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });

  it("flags leftover cents placed on a later installment", () => {
    const b = threeInstallments();
    expect(b.installments.map((i) => i.amount_cents)).toEqual([34, 33, 33]);
    b.installments[0]!.amount_cents = 33;
    b.installments[2]!.amount_cents = 34;
    expect(run("payment_schedule", b).outcome).toBe("flag");
  });
});

describe("party_consistency", () => {
  it("flags an invoice seller that differs from the customer's", () => {
    const b = bundle({ invoice_number: "000001" });
    b.invoice.seller_id = "S2";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags an invoice business unit that differs from the customer's", () => {
    const b = bundle({ invoice_number: "000001" });
    b.invoice.business_unit = "Home & Garden";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags an unknown customer", () => {
    const b = bundle({ invoice_number: "000001" });
    b.invoice.customer_id = "C404";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags a line whose header fields differ from the invoice", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines[0]!.customer_id = "C2";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags a product from another business unit", () => {
    const b = bundle({ invoice_number: "000001", lines: [{ product_id: "P9", qty: 1, price: 100 }] });
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags a product repackaged under the same id (name differs from the catalogue)", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines[0]!.product_name = "Foliar Nutrient 0.8 L";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags an unknown product", () => {
    const b = bundle({ invoice_number: "000001" });
    b.lines[0]!.product_id = "P404";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });

  it("flags an installment billed to another customer", () => {
    const b = bundle({ invoice_number: "000001" });
    b.installments[0]!.customer_id = "C2";
    expect(run("party_consistency", b).outcome).toBe("flag");
  });
});

describe("duplicate_lines", () => {
  const lines = [{ product_id: "P1", qty: 3, price: 1000 }, { product_id: "P2", qty: 1, price: 4000 }];
  const prior = bundle({ invoice_number: "000001", billing_date: "2025-03-10", lines });

  it("flags the same products and quantities as the customer's invoice ≤ 7 days earlier", () => {
    const r = run("duplicate_lines", bundle({ invoice_number: "000002", billing_date: "2025-03-17", lines }), [prior]);
    expect(r.outcome).toBe("flag");
    expect(r.reasons[0]).toMatch(/000001/);
  });

  it("ignores line order", () => {
    const b = bundle({ invoice_number: "000002", billing_date: "2025-03-12", lines: [...lines].reverse() });
    expect(run("duplicate_lines", b, [prior]).outcome).toBe("flag");
  });

  it("passes when a quantity differs", () => {
    const b = bundle({ invoice_number: "000002", billing_date: "2025-03-12", lines: [{ ...lines[0]!, qty: 4 }, lines[1]!] });
    expect(run("duplicate_lines", b, [prior]).outcome).toBe("pass");
  });

  it("passes when the match is more than 7 days old", () => {
    const b = bundle({ invoice_number: "000002", billing_date: "2025-03-18", lines });
    expect(run("duplicate_lines", b, [prior]).outcome).toBe("pass");
  });

  it("passes when another customer has the same lines", () => {
    const b = bundle({ invoice_number: "000002", billing_date: "2025-03-12", customer_id: "C2", lines });
    expect(run("duplicate_lines", b, [prior]).outcome).toBe("pass");
  });
});

describe("rebilled_products", () => {
  const prior = bundle({
    invoice_number: "000001",
    billing_date: "2025-03-10",
    lines: [{ product_id: "P1", qty: 3, price: 1000 }, { product_id: "P2", qty: 1, price: 4000 }],
  });
  const next = (billing_date: string, lines = [{ product_id: "P2", qty: 5, price: 4000 }], customer_id = "C1") =>
    bundle({ invoice_number: "000002", billing_date, customer_id, lines });

  it("flags an invoice ≤ 2 days after the previous one whose products were all on it, whatever the quantities", () => {
    const r = run("rebilled_products", next("2025-03-12"), [prior]);
    expect(r.outcome).toBe("flag");
    expect(r.reasons[0]).toMatch(/P2.*000001/);
  });

  it("flags an exact rebill on the same day", () => {
    expect(run("rebilled_products", next("2025-03-10", [{ product_id: "P1", qty: 3, price: 1000 }, { product_id: "P2", qty: 1, price: 4000 }]), [prior]).outcome).toBe("flag");
  });

  it("passes when a product was not on the previous invoice", () => {
    const b = next("2025-03-11", [{ product_id: "P2", qty: 1, price: 4000 }, { product_id: "P9", qty: 1, price: 900 }]);
    expect(run("rebilled_products", b, [prior]).outcome).toBe("pass");
  });

  it("passes 3 days later", () => {
    expect(run("rebilled_products", next("2025-03-13"), [prior]).outcome).toBe("pass");
  });

  it("only looks at the same customer", () => {
    expect(run("rebilled_products", next("2025-03-11", undefined, "C2"), [prior]).outcome).toBe("pass");
  });

  it("compares with the most recent previous invoice only", () => {
    const later = bundle({ invoice_number: "000001", billing_date: "2025-03-10", lines: [{ product_id: "P1", qty: 1, price: 1000 }] });
    const older = bundle({ invoice_number: "000000", billing_date: "2025-03-09", lines: [{ product_id: "P2", qty: 1, price: 4000 }] });
    expect(run("rebilled_products", next("2025-03-11"), [older, later]).outcome).toBe("pass");
  });
});

describe("near_duplicate_window", () => {
  const prior = bundle({ invoice_number: "000001", billing_date: "2025-03-10" });
  const next = (billing_date: string, customer_id = "C1") =>
    bundle({ invoice_number: "000002", billing_date, customer_id, lines: [{ product_id: "P2", qty: 1, price: 4000 }] });

  it("is ambiguous when billed ≤ 2 days after the customer's previous invoice", () => {
    const r = run("near_duplicate_window", next("2025-03-12"), [prior]);
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons[0]).toMatch(/2 days after 000001/);
  });

  it("is ambiguous on the same day", () => {
    expect(run("near_duplicate_window", next("2025-03-10"), [prior]).outcome).toBe("ambiguous");
  });

  it("passes 3 days later", () => {
    expect(run("near_duplicate_window", next("2025-03-13"), [prior]).outcome).toBe("pass");
  });

  it("only looks at the same customer", () => {
    expect(run("near_duplicate_window", next("2025-03-11", "C2"), [prior]).outcome).toBe("pass");
  });

  it("compares with the most recent previous invoice", () => {
    const older = bundle({ invoice_number: "000000", billing_date: "2025-03-01" });
    expect(run("near_duplicate_window", next("2025-03-11"), [older, prior]).outcome).toBe("ambiguous");
  });
});
