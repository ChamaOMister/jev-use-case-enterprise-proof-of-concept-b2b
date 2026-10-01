import { describe, expect, it } from "vitest";
import { esc, finalRoutes, histogramSvg, renderReport, reviewQueue, toDocument, toFragment, type ReportSources } from "./html.js";

const counts = { pass: 1, flag: 0, ambiguous: 0 };
const summary = (invoices: number, auto: number, jev: number, review: number, excluded: number) => ({
  invoices,
  routes: { auto_approve: auto, jev, human_review: review, excluded },
  rules: { rebilled_products: { pass: invoices - review, flag: review, ambiguous: 0 }, near_duplicate_window: counts },
});
const kinds = (v: number) => ({ split: v, rebill: v, rebill_changed: v, moved: v });
const pair = { tune: 0.9, test: 0.8 };

function sources(): ReportSources {
  return {
    audit: { results: [{ id: "row_counts", claim: "Rows <match>", status: "match", observed: "all 7 tables match" }] },
    check: {
      generated_at: "2026-09-30T20:18:24.265Z",
      rules: [{ id: "rebilled_products", description: "Only products already billed" }],
      summary: { tune: summary(5, 2, 2, 1, 0), test: summary(2, 1, 1, 0, 0), demo: summary(1, 1, 0, 0, 0), all: summary(8, 4, 3, 1, 0) },
      invoices: [
        { invoice_number: "000010", split: "tune", route: "human_review", findings: [{ rule: "rebilled_products", outcome: "flag", reasons: ["every product (P1) was already on 000009"] }] },
        { invoice_number: "000020", split: "tune", route: "jev", findings: [{ rule: "near_duplicate_window", outcome: "ambiguous", reasons: ["billed 1 day after 000019"] }] },
      ],
    },
    features: {
      invoices: [{ invoice_number: "000020", features: { prev_invoice_number: "000019", gap_days: 1, shared_products: 2, product_jaccard: 0.5, total_ratio: 1.1 } }],
    },
    jev: {
      generated_at: "2026-09-30T20:19:18.903Z",
      model_requested: "jev-1.13.0",
      models_returned: ["jev-1.13.0"],
      question: { same_order: { instructions: "Same order?" } },
      threshold: 0.39,
      invoices: [
        { invoice_number: "000020", split: "tune", p_same_order: 0.43, route_after_jev: "human_review" },
        { invoice_number: "000030", split: "tune", p_same_order: 0.1, route_after_jev: "auto_approve" },
        { invoice_number: "000040", split: "test", p_same_order: 0.39, route_after_jev: "auto_approve" },
      ],
    },
    eval: {
      generated_at: "2026-09-30T20:19:27.833Z",
      threshold: 0.39,
      cases: [{ kind: "rebill", split: "tune" }],
      metrics: { tune: { median_p_by_kind: kinds(0.2), flagged_share_by_kind: kinds(0.5) }, test: { median_p_by_kind: kinds(0.2), flagged_share_by_kind: kinds(0.5) } },
      kind_vs_moved_auc: { jev: { split: pair, rebill: pair, rebill_changed: pair } },
      phase1_rebilled_products_share_by_kind: { tune: kinds(1), test: kinds(1) },
      pipeline_share_by_kind: { tune: kinds(1), test: kinds(1) },
    },
  };
}

describe("finalRoutes", () => {
  it("applies Jev's answers to the invoices Phase 1 sent to it", () => {
    const all = finalRoutes(sources()).find((r) => r.split === "all")!;
    expect(all).toMatchObject({ invoices: 8, jevAsked: 3, jevReview: 1, autoApprove: 6, review: 2 });
    const test = finalRoutes(sources()).find((r) => r.split === "test")!;
    expect(test).toMatchObject({ jevReview: 0, autoApprove: 2, review: 0 });
  });
});

describe("reviewQueue", () => {
  it("lists rule flags and Jev flags with their evidence", () => {
    const q = reviewQueue(sources());
    expect(q.map((r) => [r.invoice, r.source])).toEqual([["000010", "rule"], ["000020", "jev"]]);
    expect(q[0]!.why).toBe("rebilled products: every product (P1) was already on 000009");
    expect(q[1]).toMatchObject({ prev: "000019", gap: 1, p: 0.43 });
    expect(q[1]!.why).toContain("0.43");
    expect(q[1]!.why).toContain("billed 1 day after 000019");
  });
});

describe("histogramSvg", () => {
  it("draws one bar per non-empty bin and colours bins at or above the threshold", () => {
    const svg = histogramSvg([0.1, 0.1, 0.39, 0.45], 0.39);
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg.match(/bar-review/g)).toHaveLength(2);
    expect(svg).toContain("2 at or above the 0.39 threshold");
  });
});

describe("renderReport", () => {
  it("escapes data and keeps paths out of the page", () => {
    const r = renderReport(sources());
    expect(esc('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
    expect(r.body).toContain("Rows &lt;match&gt;");
    expect(r.body).not.toContain("<match>");
    expect(r.body).not.toMatch(/data\/raw|\/home\/|\/workspaces\//);
  });

  it("wraps the same content as a document or a fragment", () => {
    const r = renderReport(sources());
    const doc = toDocument(r);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Biomix Invoice Triage</title>");
    const frag = toFragment(r);
    expect(frag).not.toMatch(/<html|<body|<!doctype/i);
    expect(frag).toContain(r.body);
  });
});
