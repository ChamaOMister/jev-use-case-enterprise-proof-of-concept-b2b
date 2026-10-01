/**
 * Renders the results report: one self-contained HTML page built from the JSON that the audit, check,
 * features, jev and eval phases write to out/. It holds counts, rates, model scores, invoice numbers and
 * product codes only; never paths, keys or raw rows.
 */
import { SPLITS, type Route, type Split } from "../check/types.js";

type Counts = { pass: number; flag: number; ambiguous: number };
type SplitSummary = { invoices: number; routes: Record<Route, number>; rules: Record<string, Counts> };
type Finding = { rule: string; outcome: string; reasons: string[] };
type Pair = { tune: number; test: number };
type Kind = "split" | "rebill" | "rebill_changed" | "moved";
type EvalSplit = "tune" | "test";

export interface ReportSources {
  audit: { results: { id: string; claim: string; status: string; observed: string }[] };
  check: {
    generated_at: string;
    rules: { id: string; description: string }[];
    summary: Record<Split | "all", SplitSummary>;
    invoices: { invoice_number: string; split: Split; route: Route; findings: Finding[] }[];
  };
  features: {
    invoices: {
      invoice_number: string;
      features: { prev_invoice_number: string | null; gap_days: number | null; shared_products: number | null; product_jaccard: number | null; total_ratio: number | null };
    }[];
  };
  jev: {
    generated_at: string;
    model_requested: string;
    models_returned: string[];
    question: Record<string, { instructions: string }>;
    threshold: number;
    invoices: { invoice_number: string; split: Split; p_same_order: number; route_after_jev: Route }[];
  };
  eval: {
    generated_at: string;
    threshold: number;
    cases: { kind: Kind; split: EvalSplit }[];
    metrics: Record<EvalSplit, { median_p_by_kind: Record<Kind, number>; flagged_share_by_kind: Record<Kind, number> }>;
    kind_vs_moved_auc: Record<string, Record<Exclude<Kind, "moved">, Pair>>;
    phase1_rebilled_products_share_by_kind: Record<EvalSplit, Record<Kind, number>>;
    pipeline_share_by_kind: Record<EvalSplit, Record<Kind, number>>;
  };
}

export interface RenderedReport {
  title: string;
  /** <title>, font link and <style>: what goes in <head>. */
  head: string;
  body: string;
}

const TITLE = "Biomix Invoice Triage";
const EVAL_SPLITS: readonly EvalSplit[] = ["tune", "test"];

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
const p2 = (v: number) => v.toFixed(2);
const ruleName = (id: string) => id.replace(/_/g, " ");

/** Final outcome per split once Jev's answers are applied to the invoices Phase 1 sent to it. */
export function finalRoutes(src: ReportSources) {
  const rows = [...SPLITS, "all" as const].map((split) => {
    const s = src.check.summary[split];
    const jev = src.jev.invoices.filter((j) => split === "all" || j.split === split);
    const jevReview = jev.filter((j) => j.route_after_jev === "human_review").length;
    return {
      split,
      invoices: s.invoices,
      excluded: s.routes.excluded,
      ruleReview: s.routes.human_review,
      ruleApprove: s.routes.auto_approve,
      jevAsked: s.routes.jev,
      jevReview,
      autoApprove: s.routes.auto_approve + s.routes.jev - jevReview,
      review: s.routes.human_review + jevReview,
    };
  });
  return rows;
}

interface QueueRow {
  invoice: string;
  split: Split;
  source: "rule" | "jev";
  prev: string | null;
  gap: number | null;
  shared: number | null;
  jaccard: number | null;
  ratio: number | null;
  p: number | null;
  why: string;
}

/** Every invoice that ends up with a person: flagged by a Phase 1 rule or scored at or above Jev's threshold. */
export function reviewQueue(src: ReportSources): QueueRow[] {
  const feats = new Map(src.features.invoices.map((f) => [f.invoice_number, f.features]));
  const checks = new Map(src.check.invoices.map((c) => [c.invoice_number, c]));
  const row = (invoice: string, split: Split, source: QueueRow["source"], p: number | null, why: string): QueueRow => {
    const f = feats.get(invoice);
    return {
      invoice, split, source, p, why,
      prev: f?.prev_invoice_number ?? null,
      gap: f?.gap_days ?? null,
      shared: f?.shared_products ?? null,
      jaccard: f?.product_jaccard ?? null,
      ratio: f?.total_ratio ?? null,
    };
  };
  const fromRules = src.check.invoices
    .filter((c) => c.route === "human_review")
    .map((c) => row(c.invoice_number, c.split, "rule", null, c.findings.filter((f) => f.outcome === "flag").map((f) => `${ruleName(f.rule)}: ${f.reasons.join("; ")}`).join(" · ")));
  const fromJev = src.jev.invoices
    .filter((j) => j.route_after_jev === "human_review")
    .map((j) => {
      const window = checks.get(j.invoice_number)?.findings.find((f) => f.rule === "near_duplicate_window");
      return row(j.invoice_number, j.split, "jev", j.p_same_order, `Jev rates it ${p2(j.p_same_order)} likely the same order${window ? `; ${window.reasons.join("; ")}` : ""}`);
    });
  return [...fromRules, ...fromJev].sort((a, b) => a.invoice.localeCompare(b.invoice));
}

/** Histogram of Jev's p_same_order with 0.01-wide bins, drawn to one scale, threshold marked. */
export function histogramSvg(ps: number[], threshold: number): string {
  const W = 680, H = 230, L = 44, R = 16, T = 16, B = 40;
  const xMax = 0.5, bins = 50;
  const counts = new Array<number>(bins).fill(0);
  for (const p of ps) counts[Math.min(bins - 1, Math.floor(p * 100 + 1e-9))]! += 1;
  const peak = Math.max(1, ...counts);
  const step = peak <= 10 ? 2 : peak <= 25 ? 5 : peak <= 60 ? 10 : 20;
  const yMax = Math.ceil(peak / step) * step;
  const x = (v: number) => L + (v / xMax) * (W - L - R);
  const y = (v: number) => H - B - (v / yMax) * (H - T - B);
  const bw = (W - L - R) / bins;
  const parts: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`, `<text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  counts.forEach((c, i) => {
    if (c === 0) return;
    const over = i / 100 >= threshold - 1e-9;
    parts.push(`<rect class="${over ? "bar-review" : "bar-approve"}" x="${(x(i / 100) + 1).toFixed(1)}" y="${y(c).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(y(0) - y(c)).toFixed(1)}"><title>p ${p2(i / 100)}: ${c} invoice${c === 1 ? "" : "s"}</title></rect>`);
  });
  for (let v = 0; v <= xMax + 1e-9; v += 0.1) {
    parts.push(`<text class="tick" x="${x(v)}" y="${H - B + 18}" text-anchor="middle">${v.toFixed(1)}</text>`);
  }
  const tx = x(threshold);
  parts.push(
    `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`,
    `<line class="threshold" x1="${tx}" x2="${tx}" y1="${T}" y2="${y(0)}"/>`,
    `<text class="tick strong" x="${tx - 6}" y="${T + 10}" text-anchor="end">threshold ${p2(threshold)}</text>`,
    `<text class="tick" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Jev's probability that the invoice repeats the previous order</text>`,
    `<text class="tick" x="12" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">invoices</text>`,
  );
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of ${ps.length} Jev scores; ${ps.filter((p) => p >= threshold).length} at or above the ${p2(threshold)} threshold">${parts.join("")}</svg>`;
}

const KINDS: { id: Kind; name: string; what: string; goal: "review" | "approve" }[] = [
  { id: "rebill", name: "Partial rebill", what: "Some products from the previous invoice billed again, same quantities.", goal: "review" },
  { id: "rebill_changed", name: "Rebill, quantities changed", what: "Products from the previous invoice billed again with different quantities.", goal: "review" },
  { id: "split", name: "Split order", what: "One real order divided over two invoices; every line is billed once.", goal: "approve" },
  { id: "moved", name: "New order, moved close", what: "A real later order of the same customer, moved to 1–2 days after the previous invoice.", goal: "approve" },
];

const pair = (f: (s: EvalSplit) => string) => EVAL_SPLITS.map(f).join('<span class="sep">/</span>');

function evalTable(src: ReportSources): string {
  const e = src.eval;
  const rows = KINDS.map((k) => {
    const count = (s: EvalSplit) => String(e.cases.filter((c) => c.kind === k.id && c.split === s).length);
    const good = (share: number) => (k.goal === "review" ? share >= 0.9 : share <= 0.05);
    const share = (v: number) => `<span class="${good(v) ? "ok" : "bad"}">${pct(v)}</span>`;
    return `<tr>
      <th scope="row"><span class="kind">${esc(k.name)}</span><span class="what">${esc(k.what)}</span></th>
      <td><span class="chip ${k.goal}">${k.goal === "review" ? "Review" : "Approve"}</span></td>
      <td class="num">${pair(count)}</td>
      <td class="num">${pair((s) => p2(e.metrics[s].median_p_by_kind[k.id]))}</td>
      <td class="num">${pair((s) => share(e.metrics[s].flagged_share_by_kind[k.id]))}</td>
      <td class="num">${pair((s) => share(e.phase1_rebilled_products_share_by_kind[s][k.id]))}</td>
      <td class="num">${pair((s) => share(e.pipeline_share_by_kind[s][k.id]))}</td>
    </tr>`;
  }).join("");
  return `<div class="scroll"><table class="eval">
    <thead><tr><th scope="col">Planted case</th><th scope="col">Should</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Jev median score</th><th scope="col" class="num">Jev ≥ ${p2(e.threshold)}</th><th scope="col" class="num">Rebill rule flags</th><th scope="col" class="num">Sent to review</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="note">Each cell shows <b>tune / test</b>. Green means the share is where it should be (≥ 90% for cases to review, ≤ 5% for cases to approve). “Sent to review” is the whole pipeline: rules first, then Jev.</p>`;
}

function aucTable(src: ReportSources): string {
  const auc = src.eval.kind_vs_moved_auc;
  const names: Record<string, string> = {
    jev: "Jev (model)", gap_days: "Days since previous invoice", shared_products: "Products shared", product_jaccard: "Product overlap (Jaccard)",
    shared_same_qty: "Shared products, same quantity", total_ratio: "Total ÷ previous total", same_payment_schedule: "Same payment schedule", union_matches_past_basket: "Both together match an earlier basket",
  };
  const cell = (v: Pair) => pair((s) => `<span class="${v[s] >= 0.9 ? "ok" : v[s] < 0.4 ? "bad" : ""}">${v[s].toFixed(2)}</span>`);
  const rows = Object.entries(auc).map(([id, v]) => `<tr${id === "jev" ? ' class="lead"' : ""}><th scope="row">${esc(names[id] ?? ruleName(id))}</th><td class="num">${cell(v.rebill)}</td><td class="num">${cell(v.rebill_changed)}</td><td class="num">${cell(v.split)}</td></tr>`).join("");
  return `<div class="scroll"><table class="auc"><thead><tr><th scope="col">Signal</th><th scope="col" class="num">Rebill</th><th scope="col" class="num">Rebill, qty changed</th><th scope="col" class="num">Split</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">AUC of each signal at telling that kind apart from a real new order moved close (tune / test). 1.00 separates perfectly, 0.50 is a coin flip, below 0.50 points the wrong way.</p>`;
}

export function renderReport(src: ReportSources): RenderedReport {
  const routes = finalRoutes(src);
  const all = routes.find((r) => r.split === "all")!;
  const queue = reviewQueue(src);
  const t = src.jev.threshold;
  const ps = src.jev.invoices.map((j) => j.p_same_order);
  const sortedPs = [...ps].sort((a, b) => a - b);
  const median = sortedPs.length ? sortedPs[Math.floor((sortedPs.length - 1) / 2)]! : 0;
  const ruleCount = src.check.rules.length;
  const question = Object.values(src.jev.question)[0]?.instructions ?? "";
  const models = [...new Set(src.jev.models_returned)].join(", ");
  const e = src.eval;
  const auc = e.kind_vs_moved_auc["jev"];
  const moved = e.pipeline_share_by_kind;
  const ruleMoved = e.phase1_rebilled_products_share_by_kind;
  const generated = [src.check.generated_at, src.jev.generated_at, e.generated_at].sort().at(-1)!.slice(0, 10);

  const splitRows = routes.map((r) => `<tr${r.split === "all" ? ' class="total"' : ""}>
    <th scope="row">${r.split === "all" ? "All" : r.split}</th>
    <td class="num">${n(r.invoices)}</td><td class="num">${n(r.excluded)}</td><td class="num">${n(r.ruleReview)}</td>
    <td class="num">${n(r.jevAsked)}</td><td class="num">${n(r.jevReview)}</td>
    <td class="num strong">${n(r.autoApprove)}</td><td class="num strong">${n(r.review)}</td></tr>`).join("");

  const ruleRows = src.check.rules.map((r) => {
    const c = src.check.summary.all.rules[r.id] ?? { pass: 0, flag: 0, ambiguous: 0 };
    const out = c.flag > 0 ? `<span class="chip review">${n(c.flag)} flagged</span>` : c.ambiguous > 0 ? `<span class="chip jev">${n(c.ambiguous)} to Jev</span>` : `<span class="chip quiet">all pass</span>`;
    return `<tr><th scope="row"><code>${esc(r.id)}</code></th><td>${esc(r.description)}</td><td class="num">${out}</td></tr>`;
  }).join("");

  const queueRows = queue.map((q) => `<tr>
    <th scope="row" class="mono">${esc(q.invoice)}</th><td>${q.split}</td>
    <td><span class="chip ${q.source === "rule" ? "review" : "jev"}">${q.source === "rule" ? "Rule" : "Jev"}</span></td>
    <td class="mono">${q.prev ? esc(q.prev) : "—"}</td><td class="num">${q.gap ?? "—"}</td>
    <td class="num">${q.shared ?? "—"}</td><td class="num">${q.jaccard === null ? "—" : q.jaccard.toFixed(2)}</td>
    <td class="num">${q.ratio === null ? "—" : q.ratio.toFixed(2)}</td><td class="why">${esc(q.why)}</td></tr>`).join("");

  const jevRows = [...src.jev.invoices].sort((a, b) => b.p_same_order - a.p_same_order || a.invoice_number.localeCompare(b.invoice_number)).map((j) =>
    `<tr><th scope="row" class="mono">${esc(j.invoice_number)}</th><td>${j.split}</td><td class="num">${p2(j.p_same_order)}</td><td>${j.route_after_jev === "human_review" ? '<span class="chip review">Review</span>' : '<span class="chip approve">Approve</span>'}</td></tr>`).join("");

  const auditRows = src.audit.results.map((a) => `<li><span class="chip ${a.status === "match" ? "approve" : a.status === "differs" ? "review" : "quiet"}">${esc(a.status)}</span><div><b>${esc(a.claim)}</b><span>${esc(a.observed)}</span></div></li>`).join("");

  const body = `<div class="page">
<header class="top">
  <p class="eyebrow">Proof of concept · synthetic B2B invoices · ${n(all.invoices)} invoices, 2023–2026</p>
  <h1>Biomix invoice triage</h1>
  <p class="lede">Every incoming invoice is checked before it is paid. Plain rules handle the clear cases, a model called Jev looks at the doubtful ones, and only what is still doubtful reaches a person. On this data, <b>${pct(all.autoApprove / all.invoices)}</b> of invoices are approved automatically and <b>${n(all.review)}</b> go to a reviewer.</p>
</header>

<section aria-labelledby="flow">
  <h2 id="flow">Where the invoices went</h2>
  <ol class="flow">
    <li class="stage">
      <span class="tier">Tier 1 · Rules</span>
      <span class="big">${n(all.invoices)}</span><span class="label">invoices checked against ${ruleCount} rules</span>
      <ul class="outs">
        <li><i class="dot approve"></i><b>${n(all.ruleApprove)}</b> pass every rule → approved</li>
        <li><i class="dot jev"></i><b>${n(all.jevAsked)}</b> billed ≤ 2 days after the customer's previous invoice → Jev</li>
        <li><i class="dot review"></i><b>${n(all.ruleReview)}</b> flagged as a likely rebill → review</li>
        <li><i class="dot excluded"></i><b>${n(all.excluded)}</b> sent twice (corrections) → out of scope</li>
      </ul>
    </li>
    <li class="stage">
      <span class="tier">Tier 2 · Jev</span>
      <span class="big">${n(all.jevAsked)}</span><span class="label">near-duplicates scored by the model</span>
      <ul class="outs">
        <li><i class="dot approve"></i><b>${n(all.jevAsked - all.jevReview)}</b> score below ${p2(t)} → approved</li>
        <li><i class="dot review"></i><b>${n(all.jevReview)}</b> score ${p2(t)} or more → review</li>
      </ul>
    </li>
    <li class="stage">
      <span class="tier">Tier 3 · People</span>
      <span class="big">${n(all.review)}</span><span class="label">invoices for a reviewer, ${pct(all.review / all.invoices)} of all</span>
      <ul class="outs">
        <li><i class="dot review"></i><b>${n(all.ruleReview)}</b> from the rules</li>
        <li><i class="dot jev"></i><b>${n(all.jevReview)}</b> from Jev</li>
      </ul>
    </li>
  </ol>
  <div class="scroll"><table class="splits">
    <thead><tr><th scope="col">Split</th><th scope="col" class="num">Invoices</th><th scope="col" class="num">Excluded</th><th scope="col" class="num">Rule flags</th><th scope="col" class="num">Sent to Jev</th><th scope="col" class="num">Jev flags</th><th scope="col" class="num">Approved</th><th scope="col" class="num">To review</th></tr></thead>
    <tbody>${splitRows}</tbody>
  </table></div>
  <p class="note">Invoices are split by billing date so nothing is tuned on the data it is judged on: <b>tune</b> before 2026-01-01 (choices are made here), <b>test</b> 2026-01-01 to 2026-08-31 (choices are checked here), <b>demo</b> from 2026-09-01 (the latest batch).</p>
</section>

<section aria-labelledby="rules">
  <h2 id="rules">Tier 1: the rules</h2>
  <p>Arithmetic, prices, commissions, payment schedules and party data are checked line by line. The synthetic data is clean, so those rules all pass. The two rules about repeated billing do the real work.</p>
  <div class="scroll"><table class="rules"><thead><tr><th scope="col">Rule</th><th scope="col">What it checks</th><th scope="col" class="num">Result</th></tr></thead><tbody>${ruleRows}</tbody></table></div>
</section>

<section aria-labelledby="jev">
  <h2 id="jev">Tier 2: what Jev was asked</h2>
  <blockquote>${esc(question)}</blockquote>
  <p>Jev (model <code>${esc(models || src.jev.model_requested)}</code>) sees both invoices and the customer's history and answers yes or no with a probability. Scores ran from ${p2(sortedPs[0] ?? 0)} to ${p2(sortedPs.at(-1) ?? 0)}, median ${p2(median)}. Anything at or above <b>${p2(t)}</b> goes to a reviewer.</p>
  <figure>${histogramSvg(ps, t)}<figcaption><i class="dot approve"></i> approved <i class="dot review"></i> sent to review · ${n(ps.length)} invoices</figcaption></figure>
  <details><summary>All ${n(ps.length)} Jev scores</summary><div class="scroll tall"><table class="compact"><thead><tr><th scope="col">Invoice</th><th scope="col">Split</th><th scope="col" class="num">Score</th><th scope="col">Outcome</th></tr></thead><tbody>${jevRows}</tbody></table></div></details>
</section>

<section aria-labelledby="eval">
  <h2 id="eval">Does it catch the right invoices?</h2>
  <p>The data has no answer key, so the evaluation plants cases with a known answer. Each one is built from real invoices: a rebill, a rebill with changed quantities, a split order, or a real new order moved next to the previous invoice. Then every case goes through the same rules and the same Jev question.</p>
  ${evalTable(src)}
  <div class="findings">
    <div><h3>Jev spots exact rebills</h3><p>Against real new orders its AUC is ${auc ? `${auc.rebill.tune.toFixed(2)} on tune and ${auc.rebill.test.toFixed(2)} on test` : "near 1"}. Rebills with changed quantities are harder: only ${pct(e.metrics.tune.flagged_share_by_kind.rebill_changed, 0)} / ${pct(e.metrics.test.flagged_share_by_kind.rebill_changed, 0)} score above the threshold.</p></div>
    <div><h3>A plain rule does better</h3><p>“Billed ≤ 2 days later with only products already on the previous invoice” catches every planted rebill, both kinds, and flags ${pct(ruleMoved.tune.moved)} / ${pct(ruleMoved.test.moved)} of real new orders. It now runs in tier 1, and Jev stays behind it as a second opinion.</p></div>
    <div><h3>Splits are left alone</h3><p>Jev rates split orders as less alike than real new orders (AUC ${auc ? `${auc.split.tune.toFixed(2)} / ${auc.split.test.toFixed(2)}` : "below 0.5"}). That is acceptable: a split bills each line once, so it is approved. False alarms on new orders end at ${pct(moved.tune.moved)} / ${pct(moved.test.moved)}.</p></div>
  </div>
  <details><summary>Jev compared with single invoice features</summary>${aucTable(src)}</details>
</section>

<section aria-labelledby="queue">
  <h2 id="queue">The review queue</h2>
  <p>The ${n(queue.length)} invoices a person would look at, with the evidence each one arrives with.</p>
  <div class="scroll"><table class="queue">
    <thead><tr><th scope="col">Invoice</th><th scope="col">Split</th><th scope="col">From</th><th scope="col">Previous</th><th scope="col" class="num">Days</th><th scope="col" class="num">Shared products</th><th scope="col" class="num">Overlap</th><th scope="col" class="num">Total ÷ prev</th><th scope="col">Why</th></tr></thead>
    <tbody>${queueRows}</tbody>
  </table></div>
</section>

<section aria-labelledby="audit">
  <h2 id="audit">Data checks before any of this</h2>
  <p>The delivered files were audited against their documentation first, so the rules rest on facts about the data rather than assumptions.</p>
  <ul class="audit">${auditRows}</ul>
</section>

<section aria-labelledby="limits">
  <h2 id="limits">Limits</h2>
  <ul class="plain">
    <li>All data is synthetic. Customer, product and invoice numbers are made up.</li>
    <li>There is no real answer key. The rates above come from planted cases, and the planted rebills reuse the previous invoice's products, which is exactly what the rebill rule tests, so its 100% is a best case.</li>
    <li>Thresholds and rules were chosen on <b>tune</b> only and then reported on <b>test</b>.</li>
  </ul>
</section>

<footer>
  <p>Built from the pipeline's own output on ${generated}. To rebuild: <code>npm run check</code>, <code>npm run features</code>, <code>npm run jev</code>, <code>npm run eval</code>, then <code>npm run report</code>.</p>
</footer>
</div>`;

  return { title: TITLE, head: `<title>${TITLE}</title>\n${HEAD_ASSETS}`, body };
}

/** A standalone document for opening from disk. */
export function toDocument(r: RenderedReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${r.head}
</head>
<body>
${r.body}
</body>
</html>
`;
}

/** Head and body without the document skeleton, for hosts that add their own. */
export function toFragment(r: RenderedReport): string {
  return `${r.head}\n${r.body}\n`;
}

const HEAD_ASSETS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Public+Sans:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column; the three tiers sit side by side as a sequence, tables scroll inside their own frame. */
:root {
  --paper: #f4f7f6; --panel: #ffffff; --ink: #15201c; --muted: #56655f; --line: #d3dcd8;
  --accent: #1d6b57; --approve: #2e7a4d; --jev: #3a56a6; --review: #a85f00; --excluded: #7f8a85;
  --approve-bg: #e3f1e8; --jev-bg: #e6ebf8; --review-bg: #fbeedb; --quiet-bg: #eceff0;
  --display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --body: "Public Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #101614; --panel: #161e1b; --ink: #e2ebe7; --muted: #98a9a2; --line: #2a3632;
    --accent: #5fc3a4; --approve: #63c086; --jev: #92a8f0; --review: #f0a640; --excluded: #75817c;
    --approve-bg: #19301f; --jev-bg: #1d2540; --review-bg: #3a2a12; --quiet-bg: #222a27;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #101614; --panel: #161e1b; --ink: #e2ebe7; --muted: #98a9a2; --line: #2a3632;
  --accent: #5fc3a4; --approve: #63c086; --jev: #92a8f0; --review: #f0a640; --excluded: #75817c;
  --approve-bg: #19301f; --jev-bg: #1d2540; --review-bg: #3a2a12; --quiet-bg: #222a27;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 var(--body); }
.page { max-width: 1040px; margin: 0 auto; padding-inline: 20px; padding-block: 48px 64px; display: grid; gap: 56px; }
section { display: grid; gap: 16px; min-width: 0; }
h1, h2, h3 { font-family: var(--display); line-height: 1.15; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(2.2rem, 5vw, 3.4rem); letter-spacing: -0.02em; }
h2 { font-size: 1.6rem; letter-spacing: -0.01em; }
h3 { font-size: 1.05rem; }
p { margin: 0; max-width: 68ch; }
b { font-weight: 600; }
code, .mono { font-family: var(--mono); font-size: 0.88em; }
.top { display: grid; gap: 14px; }
.eyebrow { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.lede { font-size: 1.15rem; color: var(--ink); }
.note { font-size: 0.86rem; color: var(--muted); }
.flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.stage { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 20px; display: grid; align-content: start; gap: 4px; position: relative; }
.stage + .stage::before { content: "→"; position: absolute; left: -12px; top: 22px; width: 12px; text-align: center; color: var(--muted); }
.tier { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.big { font-family: var(--display); font-size: 2.4rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.label { color: var(--muted); font-size: 0.9rem; }
.outs { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 6px; font-size: 0.9rem; border-top: 1px solid var(--line); padding-top: 12px; }
.outs b { font-variant-numeric: tabular-nums; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: 1px; }
.dot.approve { background: var(--approve); } .dot.jev { background: var(--jev); } .dot.review { background: var(--review); } .dot.excluded { background: var(--excluded); }
.scroll { overflow-x: auto; min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.scroll.tall { max-height: 420px; overflow-y: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { font-size: 0.74rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; background: var(--panel); position: sticky; top: 0; white-space: nowrap; }
tbody tr:last-child > * { border-bottom: 0; }
tbody th { font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.strong { font-weight: 600; }
tr.total > * { border-top: 2px solid var(--line); font-weight: 600; }
tr.lead > * { background: var(--quiet-bg); }
.sep { color: var(--muted); margin: 0 4px; }
.ok { color: var(--approve); font-weight: 600; } .bad { color: var(--review); font-weight: 600; }
.chip { display: inline-block; font-size: 0.74rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.chip.approve { background: var(--approve-bg); color: var(--approve); }
.chip.review { background: var(--review-bg); color: var(--review); }
.chip.jev { background: var(--jev-bg); color: var(--jev); }
.chip.quiet { background: var(--quiet-bg); color: var(--muted); }
table.rules td:nth-child(2) { min-width: 280px; }
table.eval th[scope="row"] { min-width: 220px; }
.kind { display: block; } .what { display: block; font-weight: 400; color: var(--muted); font-size: 0.82rem; }
table.queue .why { min-width: 300px; color: var(--muted); }
blockquote { margin: 0; padding: 14px 18px; border-left: 3px solid var(--accent); background: var(--panel); font-size: 1.05rem; max-width: 68ch; }
figure { margin: 0; display: grid; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 16px; }
figcaption { font-size: 0.85rem; color: var(--muted); }
.hist { width: 100%; height: auto; max-width: 100%; display: block; }
.hist .grid { stroke: var(--line); stroke-width: 1; }
.hist .axis { stroke: var(--muted); stroke-width: 1; }
.hist .tick { fill: var(--muted); font: 11px var(--body); }
.hist .tick.strong { fill: var(--review); font-weight: 600; }
.hist .threshold { stroke: var(--review); stroke-width: 1.5; stroke-dasharray: 4 3; }
.hist .bar-approve { fill: var(--approve); }
.hist .bar-review { fill: var(--review); }
details { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
details > summary { cursor: pointer; padding: 12px 16px; font-weight: 600; }
details[open] > summary { border-bottom: 1px solid var(--line); }
details > .scroll { border: 0; border-radius: 0; }
details > .note { padding: 12px 16px; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.findings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.findings > div { display: grid; gap: 6px; align-content: start; padding-top: 12px; border-top: 2px solid var(--accent); }
.findings p { font-size: 0.92rem; }
.audit { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.audit li { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 0.9rem; }
.audit li .chip { justify-self: start; }
.audit li div { display: grid; } .audit li span { color: var(--muted); overflow-wrap: anywhere; }
.plain { margin: 0; padding-left: 20px; display: grid; gap: 6px; max-width: 72ch; }
footer { border-top: 1px solid var(--line); padding-top: 20px; font-size: 0.86rem; color: var(--muted); }
@media (max-width: 760px) {
  .page { padding-inline: 16px; padding-block: 32px 48px; gap: 44px; }
  .flow, .findings { grid-template-columns: minmax(0, 1fr); }
  .stage + .stage::before { content: "↓"; left: 0; right: 0; top: -12px; width: auto; height: 12px; line-height: 12px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style>`;
