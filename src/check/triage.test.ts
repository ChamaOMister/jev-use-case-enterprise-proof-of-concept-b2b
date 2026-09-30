import { describe, expect, it } from "vitest";
import { compareInvoiceNumbers, History } from "./history.js";
import { bundle, CATALOG } from "./test-fixtures.js";
import { RULES } from "./rules.js";
import { routeFor, summarize, triage } from "./triage.js";
import type { RuleResult } from "./types.js";

const result = (outcome: RuleResult["outcome"], rule = "r"): RuleResult => ({ rule, outcome, reasons: [] });

describe("routeFor", () => {
  const invoice = bundle({ invoice_number: "000001" }).invoice;

  it("auto-approves when every rule passes, even with notes", () => {
    expect(routeFor(invoice, [result("pass"), { rule: "price_list", outcome: "pass", reasons: ["note"] }])).toBe("auto_approve");
  });

  it("hands an ambiguous invoice to Jev", () => {
    expect(routeFor(invoice, [result("pass"), result("ambiguous")])).toBe("jev");
  });

  it("sends an invoice to human review when any rule flags, even if another is ambiguous", () => {
    expect(routeFor(invoice, [result("ambiguous"), result("flag")])).toBe("human_review");
  });

  it("excludes corrections (times_sent > 1) whatever the rules say", () => {
    expect(routeFor({ ...invoice, times_sent: 2 }, [result("flag")])).toBe("excluded");
  });
});

describe("compareInvoiceNumbers", () => {
  it("orders zero-padded numbers numerically", () => {
    expect(compareInvoiceNumbers("000009", "000010")).toBeLessThan(0);
    expect(compareInvoiceNumbers("999999", "1000000")).toBeLessThan(0);
    expect(compareInvoiceNumbers("000010", "000010")).toBe(0);
  });
});

describe("History", () => {
  it("refuses to record an invoice out of invoice_number order", () => {
    const history = new History();
    history.add(bundle({ invoice_number: "000002" }));
    expect(() => history.add(bundle({ invoice_number: "000001" }))).toThrow(/order/);
    expect(() => history.add(bundle({ invoice_number: "000002" }))).toThrow(/order/);
  });
});

describe("triage", () => {
  const a = bundle({ invoice_number: "000001", billing_date: "2025-03-10" });
  const b = bundle({ invoice_number: "000002", billing_date: "2025-03-11", lines: [{ product_id: "P2", qty: 1, price: 4000 }] });
  const c = bundle({ invoice_number: "000003", billing_date: "2025-03-12", customer_id: "C2", lines: [{ product_id: "P1", qty: 1, price: 900 }] });

  it("auto-approves a clean invoice", () => {
    const [t] = triage([a], CATALOG);
    expect(t).toMatchObject({ invoice_number: "000001", split: "tune", route: "auto_approve" });
  });

  it("hands the later of two close invoices to Jev, not the earlier one", () => {
    expect(triage([a, b], CATALOG).map((t) => t.route)).toEqual(["auto_approve", "jev"]);
  });

  it("sends a partial rebill to human review instead of Jev", () => {
    const rebill = bundle({ invoice_number: "000002", billing_date: "2025-03-11", lines: [{ product_id: "P1", qty: 4, price: 1000 }] });
    const [, t] = triage([a, rebill], CATALOG);
    expect(t?.route).toBe("human_review");
    expect(t?.results.find((r) => r.rule === "rebilled_products")?.outcome).toBe("flag");
    expect(t?.results.find((r) => r.rule === "near_duplicate_window")?.outcome).toBe("ambiguous");
  });

  it("gives an invoice the same result whether or not later invoices exist", () => {
    const alone = triage([a], CATALOG)[0];
    const withFuture = triage([a, b, c], CATALOG)[0];
    expect(withFuture).toEqual(alone);
  });

  it("lets later invoices see earlier ones (c's off-list price is checked against a)", () => {
    const t = triage([a, b, c], CATALOG)[2];
    expect(t?.route).toBe("human_review");
    expect(t?.results.find((r) => r.rule === "price_list")?.outcome).toBe("flag");
  });

  it("processes invoices in invoice_number order regardless of input order", () => {
    const out = triage([c, b, a], CATALOG);
    expect(out.map((t) => t.invoice_number)).toEqual(["000001", "000002", "000003"]);
    expect(out.map((t) => t.route)).toEqual(["auto_approve", "jev", "human_review"]);
  });

  it("still runs the rules on excluded invoices and records them in the history", () => {
    const resent = bundle({ invoice_number: "000001", billing_date: "2025-03-10", times_sent: 2 });
    const [first, second] = triage([resent, b], CATALOG);
    expect(first?.route).toBe("excluded");
    expect(first?.results).toHaveLength(RULES.length);
    expect(second?.route).toBe("jev");
  });
});

describe("summarize", () => {
  it("counts routes and rule outcomes per split and overall", () => {
    const a = bundle({ invoice_number: "000001", billing_date: "2025-03-10", split: "tune" });
    const b = bundle({ invoice_number: "000002", billing_date: "2026-03-11", split: "test", lines: [{ product_id: "P1", qty: 1, price: 2000 }] });
    const c = bundle({ invoice_number: "000003", billing_date: "2026-03-12", split: "test", lines: [{ product_id: "P2", qty: 1, price: 900 }] });
    const s = summarize(triage([a, b, c], CATALOG));

    expect(s.tune.invoices).toBe(1);
    expect(s.tune.routes).toEqual({ auto_approve: 1, jev: 0, human_review: 0, excluded: 0 });
    expect(s.test.routes).toEqual({ auto_approve: 0, jev: 1, human_review: 1, excluded: 0 });
    expect(s.demo.invoices).toBe(0);
    expect(s.all.invoices).toBe(3);
    expect(s.all.rules.price_list).toEqual({ pass: 2, flag: 1, ambiguous: 0 });
    expect(s.all.rules.near_duplicate_window).toEqual({ pass: 2, flag: 0, ambiguous: 1 });
  });
});
