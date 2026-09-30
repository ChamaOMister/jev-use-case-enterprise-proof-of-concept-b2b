/**
 * Phase 4: builds planted cases with known answers, asks Jev about each one (through Phase 3's
 * cache), picks the threshold on `tune`, reports it on `test` and writes out/eval.json. `demo` is
 * never used. Jev is scored on every case; the report also shows which cases Phase 1's
 * rebilled_products rule catches first, and the whole pipeline (rule or Jev).
 *
 *   npm run eval -- --model jev-1.13.0 [--flag-kinds rebill --per-label 60 --changed-per-split 30 --seed 1 --target-recall 1 --out out/eval.json]
 *   npm run eval -- --dry-run     case counts, the feature leakage check and one state; no API key, no network
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadBundles } from "../check/load.js";
import { triage } from "../check/triage.js";
import { DEFAULT_RAW_DIR, openRawDb, type Row } from "../data/db.js";
import { buildFeatures } from "../features/build.js";
import { displayPath, formatTable } from "../report/format.js";
import { createAsker, DEFAULT_MODEL } from "../jev/ask.js";
import { loadFromPendingDelivery } from "../jev/pending.js";
import { QUESTIONS } from "../jev/questions.js";
import type { JevState } from "../jev/state.js";
import { auc, chooseThreshold, confusionAt, DEFAULT_FLAG_KINDS, scoreCases, type Interval, type Scored } from "./metrics.js";
import { EVAL_SPLITS, plantCases, rebilledProducts, type CaseKind, type EvalSplit, type PlantedCase } from "./plant.js";

const { values } = parseArgs({
  options: {
    "raw-dir": { type: "string", default: DEFAULT_RAW_DIR },
    out: { type: "string", default: "out/eval.json" },
    model: { type: "string", default: DEFAULT_MODEL },
    "per-label": { type: "string", default: "60" },
    "changed-per-split": { type: "string", default: "30" },
    seed: { type: "string", default: "1" },
    "target-recall": { type: "string", default: "1" },
    "flag-kinds": { type: "string", default: DEFAULT_FLAG_KINDS.join(",") },
    "jev-results": { type: "string", default: "out/jev.json" },
    "dry-run": { type: "boolean", default: false },
  },
});
const rawDir = values["raw-dir"] ?? DEFAULT_RAW_DIR;
const outFile = values.out ?? "out/eval.json";
const model = values.model ?? DEFAULT_MODEL;
const jevResults = values["jev-results"] ?? "out/jev.json";
const perLabel = Number(values["per-label"]);
if (!(Number.isSafeInteger(perLabel) && perLabel > 0)) throw new Error(`--per-label must be a positive integer, got ${values["per-label"]}`);
const changedPerSplit = Number(values["changed-per-split"]);
const seed = Number(values.seed);
if (!Number.isSafeInteger(seed)) throw new Error(`--seed must be an integer, got ${values.seed}`);
const targetRecall = Number(values["target-recall"]);
if (!(targetRecall > 0 && targetRecall <= 1)) throw new Error(`--target-recall must be in (0, 1], got ${values["target-recall"]}`);

const KINDS: readonly CaseKind[] = ["split", "rebill", "rebill_changed", "moved"];
const flagKinds = (values["flag-kinds"] ?? "").split(",").filter((k) => k !== "") as CaseKind[];
if (flagKinds.length === 0 || flagKinds.some((k) => !KINDS.includes(k)) || flagKinds.length === KINDS.length) {
  throw new Error(`--flag-kinds must be some (not all) of ${KINDS.join(", ")}, got ${values["flag-kinds"]}`);
}
const r3 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);
const ci = (i: Interval | null): string | null => (i === null ? null : `${r3(i.low)}–${r3(i.high)}`);
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const db = await openRawDb(rawDir);
const { bundles, catalog } = await loadBundles(db);
const fromPendingDelivery = await loadFromPendingDelivery(db);
const triaged = triage(bundles, catalog);
const routes = new Map(triaged.map((t) => [t.invoice_number, t.route]));

// Planted gaps follow the gaps of the real tune invoices in the near-duplicate window: those Phase 1
// hands to Jev plus those rebilled_products sends to human review first.
const inWindow = (t: (typeof triaged)[number]): boolean =>
  t.route !== "excluded" && t.results.some((r) => r.rule === "near_duplicate_window" && r.outcome === "ambiguous");
const features = new Map(buildFeatures(bundles).map((f) => [f.invoice_number, f.features]));
const gapWeights = new Map<number, number>();
for (const t of triaged) {
  if (!inWindow(t) || t.split !== "tune") continue;
  const gap = features.get(t.invoice_number)?.gap_days;
  if (gap === null || gap === undefined) throw new Error(`near-duplicate invoice ${t.invoice_number} has no gap_days`);
  gapWeights.set(gap, (gapWeights.get(gap) ?? 0) + 1);
}

const cases = plantCases({ bundles, routes, fromPendingDelivery }, { perLabel, seed, gapWeights, changedPerSplit });

console.log(`Planted cases (seed ${seed}; ${perLabel} per label and split, plus ${changedPerSplit} rebill_changed; gaps drawn from ${JSON.stringify(Object.fromEntries(gapWeights))})`);
console.log(
  formatTable(
    EVAL_SPLITS.map((split) => ({
      split,
      ...Object.fromEntries(KINDS.map((k) => [`${k}_cases`, cases.filter((c) => c.split === split && c.kind === k).length])),
      total: cases.filter((c) => c.split === split).length,
    })),
  ),
);

/**
 * Single-feature baseline and leakage check: how well each comparison feature alone separates the
 * kinds to flag from the rest (0.5 = not at all). Jev should do better than the best of these.
 */
const COMPARISON_KEYS = Object.keys(cases[0]!.state.comparison) as (keyof JevState["comparison"])[];
const featureAuc: Record<string, Record<EvalSplit, number | null>> = {};
for (const key of COMPARISON_KEYS) {
  featureAuc[key] = Object.fromEntries(
    EVAL_SPLITS.map((split) => {
      const withValue = cases
        .filter((x) => x.split === split && x.state.comparison[key] !== null)
        .map((x) => ({ kind: x.kind, p_same_order: Number(x.state.comparison[key]) }));
      return [split, r3(auc(scoreCases(withValue, flagKinds)))];
    }),
  ) as Record<EvalSplit, number | null>;
}
console.log(`\nSingle-feature baseline: AUC of each comparison feature alone for flagging ${flagKinds.join(", ")} (0.5 = no signal)`);
console.log(formatTable(Object.entries(featureAuc).map(([feature, bySplit]) => ({ feature, ...bySplit }))));

/** AUC of `score` for one same_order kind against the real new orders (moved), per split. */
function kindVsMoved<C extends PlantedCase>(xs: readonly C[], score: (c: C) => number | null): Record<string, Record<EvalSplit, number | null>> {
  return Object.fromEntries(
    KINDS.filter((k) => k !== "moved").map((kind) => [
      kind,
      Object.fromEntries(
        EVAL_SPLITS.map((split) => {
          const scored: Scored[] = [];
          for (const c of xs.filter((x) => x.split === split && (x.kind === kind || x.kind === "moved"))) {
            const v = score(c);
            if (v !== null) scored.push({ p: v, positive: c.kind === kind });
          }
          return [split, r3(auc(scored))];
        }),
      ) as Record<EvalSplit, number | null>,
    ]),
  );
}
const num = (v: number | boolean | null): number | null => (v === null ? null : Number(v));
const vsMovedTable = (bySignal: Record<string, Record<string, Record<EvalSplit, number | null>>>): Row[] =>
  KINDS.filter((k) => k !== "moved").flatMap((kind) =>
    EVAL_SPLITS.map((split) => ({ kind, split, ...Object.fromEntries(Object.entries(bySignal).map(([signal, t]) => [signal, t[kind]![split]])) })),
  );
const featureVsMoved = Object.fromEntries(COMPARISON_KEYS.map((key) => [key, kindVsMoved(cases, (c) => num(c.state.comparison[key]))]));
console.log("\nEach same-order kind against real new orders (moved): AUC per single feature");
console.log(formatTable(vsMovedTable(featureVsMoved)));

/** Share of each kind that Phase 1's rebilled_products sends to human review before Jev sees it. */
const shareBy = <C extends PlantedCase>(xs: readonly C[], hit: (c: C) => boolean): Record<EvalSplit, Record<CaseKind, number | null>> =>
  Object.fromEntries(
    EVAL_SPLITS.map((split) => [
      split,
      Object.fromEntries(
        KINDS.map((k) => {
          const inKind = xs.filter((c) => c.split === split && c.kind === k);
          return [k, inKind.length === 0 ? null : r3(inKind.filter(hit).length / inKind.length)];
        }),
      ),
    ]),
  ) as Record<EvalSplit, Record<CaseKind, number | null>>;
const phase1Share = shareBy(cases, rebilledProducts);
const shareTable = (by: Record<EvalSplit, Record<CaseKind, number | null>>): Row[] =>
  EVAL_SPLITS.map((split) => ({ split, ...Object.fromEntries(KINDS.map((k) => [`${k}_share`, by[split][k]])) }));
console.log("\nShare of each kind that Phase 1's rebilled_products sends to human review (before Jev)");
console.log(formatTable(shareTable(phase1Share)));

if (values["dry-run"]) {
  const first = cases[0]!;
  console.log(`\nDry run: state for case ${first.case_id} (${first.label}):\n`);
  console.log(JSON.stringify(first.state, null, 2));
  console.log(`\n${cases.length} Jev calls would be needed (cached ones are free).`);
  process.exit(0);
}

if (existsSync(".env")) process.loadEnvFile(".env");
const ask = createAsker({ client: new TypeSafeClient({ defaultModel: model }), model });

const answered: (PlantedCase & { p_same_order: number; cached: boolean; model_returned: string; input_tokens: number; output_tokens: number })[] = [];
for (const [i, c] of cases.entries()) {
  const a = await ask(c.state);
  const { input_tokens, output_tokens } = a.usage;
  answered.push({ ...c, p_same_order: a.p_same_order, cached: a.cached, model_returned: a.model_returned, input_tokens, output_tokens });
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${cases.length}`);
}

const scoredIn = (split: EvalSplit): Scored[] =>
  scoreCases(
    answered.filter((c) => c.split === split),
    flagKinds,
  );
const threshold = chooseThreshold(scoredIn("tune"), targetRecall);

const metrics = Object.fromEntries(
  EVAL_SPLITS.map((split) => {
    const inSplit = answered.filter((c) => c.split === split);
    const ps = (k: CaseKind): number[] => inSplit.filter((c) => c.kind === k).map((c) => c.p_same_order);
    const kindRate = (k: CaseKind): number | null => (ps(k).length === 0 ? null : ps(k).filter((p) => p >= threshold).length / ps(k).length);
    return [
      split,
      {
        ...confusionAt(scoredIn(split), threshold),
        auc: auc(scoredIn(split)),
        median_p_by_kind: Object.fromEntries(KINDS.map((k) => [k, median(ps(k))])) as Record<CaseKind, number | null>,
        flagged_share_by_kind: Object.fromEntries(KINDS.map((k) => [k, kindRate(k)])) as Record<CaseKind, number | null>,
      },
    ];
  }),
) as Record<EvalSplit, ReturnType<typeof confusionAt> & { auc: number | null; median_p_by_kind: Record<CaseKind, number | null>; flagged_share_by_kind: Record<CaseKind, number | null> }>;

const fresh = answered.filter((c) => !c.cached);
console.log(`\nJev answers (model requested: ${model}; ${answered.length - fresh.length} cache hits; new calls used ${fresh.reduce((n, c) => n + c.input_tokens, 0)} input / ${fresh.reduce((n, c) => n + c.output_tokens, 0)} output tokens)`);
console.log(
  `Threshold chosen on tune: ${threshold} (the largest that flags ≥ ${targetRecall} of ${flagKinds.join(", ")} cases); p ≥ threshold → human_review`,
);
console.log(
  formatTable(
    EVAL_SPLITS.map((split): Row => {
      const m = metrics[split];
      return {
        split,
        auc: r3(m.auc),
        ...Object.fromEntries(KINDS.map((k) => [`median_p_${k}`, r3(m.median_p_by_kind[k])])),
        recall: r3(m.recall),
        recall_95ci: ci(m.recall_ci),
        false_alarms: r3(m.false_alarm_rate),
        false_alarms_95ci: ci(m.false_alarm_ci),
        ...Object.fromEntries(KINDS.map((k) => [`flagged_${k}`, r3(m.flagged_share_by_kind[k])])),
      };
    }),
  ),
);

const jevVsMoved = kindVsMoved(answered, (c) => c.p_same_order);
console.log("\nEach same-order kind against real new orders (moved): Jev vs the best single feature");
console.log(
  formatTable(
    vsMovedTable({
      jev: jevVsMoved,
      shared_same_qty: featureVsMoved.shared_same_qty!,
      product_jaccard: featureVsMoved.product_jaccard!,
      total_ratio: featureVsMoved.total_ratio!,
    }),
  ),
);

const pipelineShare = shareBy(answered, (c) => rebilledProducts(c) || c.p_same_order >= threshold);
console.log(`\nShare of each kind sent to human review by Phase 1's rule or by Jev at ${threshold} (the whole pipeline)`);
console.log(formatTable(shareTable(pipelineShare)));

/** Real jev-routed tune/test invoices that the chosen threshold sends to human review (demo left alone). */
let realLoad: Record<EvalSplit, { invoices: number; human_review: number }> | null = null;
if (!existsSync(jevResults)) {
  console.log(`\nReal load: skipped (${displayPath(jevResults)} not found; run npm run jev first).`);
} else {
  const jev = JSON.parse(readFileSync(jevResults, "utf8")) as { model_requested: string; invoices: { split: string; p_same_order: number }[] };
  if (jev.model_requested !== model) console.log(`\nWarning: ${displayPath(jevResults)} is from model ${jev.model_requested}, this eval used ${model}.`);
  realLoad = Object.fromEntries(
    EVAL_SPLITS.map((split) => {
      const xs = jev.invoices.filter((x) => x.split === split);
      return [split, { invoices: xs.length, human_review: xs.filter((x) => x.p_same_order >= threshold).length }];
    }),
  ) as Record<EvalSplit, { invoices: number; human_review: number }>;
  const ruleFlagged = (split: EvalSplit): number =>
    triaged.filter((t) => t.split === split && t.route !== "excluded" && t.results.some((r) => r.rule === "rebilled_products" && r.outcome === "flag")).length;
  console.log(`\nReal invoices: ${EVAL_SPLITS.map((s) => `${ruleFlagged(s)} ${s}`).join(", ")} sent to human review by rebilled_products; jev-routed at threshold ${threshold} (from ${displayPath(jevResults)}):`);
  console.log(formatTable(EVAL_SPLITS.map((split) => ({ split, ...realLoad![split], auto_approve: realLoad![split].invoices - realLoad![split].human_review }))));
}

const modelsReturned = [...new Set(answered.map((c) => c.model_returned))].sort();
console.log(`\nModels returned: ${modelsReturned.join(", ") || "—"}`);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      raw_dir: displayPath(rawDir),
      model_requested: model,
      models_returned: modelsReturned,
      question: QUESTIONS,
      seed,
      per_label: perLabel,
      changed_per_split: changedPerSplit,
      gap_weights: Object.fromEntries(gapWeights),
      flag_kinds: flagKinds,
      target_recall: targetRecall,
      threshold,
      metrics,
      feature_auc: featureAuc,
      kind_vs_moved_auc: { jev: jevVsMoved, ...featureVsMoved },
      real_load: realLoad,
      phase1_rebilled_products_share_by_kind: phase1Share,
      pipeline_share_by_kind: pipelineShare,
      cases: answered.map((c) => ({
        case_id: c.case_id,
        kind: c.kind,
        label: c.label,
        split: c.split,
        source_invoices: c.source_invoices,
        gap_days: c.gap_days,
        p_same_order: c.p_same_order,
        cached: c.cached,
      })),
    },
    null,
    2,
  ),
);
console.log(`Wrote ${displayPath(outFile)}`);
