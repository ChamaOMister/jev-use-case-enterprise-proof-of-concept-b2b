/**
 * Phase 3: asks Jev, for each invoice Phase 1 routes to `jev`, whether it is the same order as the
 * customer's previous invoice, routes it on the answer and writes out/jev.json.
 *
 *   npm run jev [-- --split tune --limit 20 --model jev-latest --threshold 0.39 --out out/jev.json]
 *   npm run jev -- --dry-run     prints the first selected invoice's state; no API key, no network
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { compareInvoiceNumbers } from "../check/history.js";
import { loadBundles } from "../check/load.js";
import { triage } from "../check/triage.js";
import { SPLITS, type InvoiceBundle, type Split } from "../check/types.js";
import { DEFAULT_RAW_DIR, openRawDb } from "../data/db.js";
import { buildFeatures } from "../features/build.js";
import { displayPath, formatTable } from "../report/format.js";
import { createAsker, DEFAULT_MODEL, type JevAnswer } from "./ask.js";
import { loadFromPendingDelivery } from "./pending.js";
import { DEFAULT_THRESHOLD, QUESTIONS, routeAfterJev } from "./questions.js";
import { stateFor } from "./state.js";

const { values } = parseArgs({
  options: {
    "raw-dir": { type: "string", default: DEFAULT_RAW_DIR },
    out: { type: "string", default: "out/jev.json" },
    model: { type: "string", default: DEFAULT_MODEL },
    threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
    split: { type: "string" },
    limit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const rawDir = values["raw-dir"] ?? DEFAULT_RAW_DIR;
const outFile = values.out ?? "out/jev.json";
const model = values.model ?? DEFAULT_MODEL;
const threshold = Number(values.threshold);
if (!(threshold >= 0 && threshold <= 1)) throw new Error(`--threshold must be a number in 0..1, got ${values.threshold}`);
const split = values.split;
if (split !== undefined && !(SPLITS as readonly string[]).includes(split)) throw new Error(`--split must be one of ${SPLITS.join(", ")}`);
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) throw new Error(`--limit must be a positive integer, got ${values.limit}`);

const db = await openRawDb(rawDir);
const { bundles, catalog } = await loadBundles(db);
const fromPendingDelivery = await loadFromPendingDelivery(db);
const byNumber = new Map(bundles.map((b) => [b.invoice.invoice_number, b]));
const features = new Map(buildFeatures(bundles).map((f) => [f.invoice_number, f.features]));

const selected = triage(bundles, catalog)
  .filter((t) => t.route === "jev" && (split === undefined || t.split === split))
  .sort((a, b) => compareInvoiceNumbers(a.invoice_number, b.invoice_number))
  .slice(0, limit);

const get = (n: string | null): InvoiceBundle => {
  const b = n === null ? undefined : byNumber.get(n);
  if (!b) throw new Error(`Unknown invoice ${n}`);
  return b;
};
const states = selected.map((t) => {
  const f = features.get(t.invoice_number);
  if (!f) throw new Error(`No features for ${t.invoice_number}`);
  const state = stateFor({ current: get(t.invoice_number), previous: get(f.prev_invoice_number), features: f, fromPendingDelivery });
  return { invoice_number: t.invoice_number, split: t.split, state };
});

if (values["dry-run"]) {
  const first = states[0];
  if (!first) throw new Error("No jev-routed invoices selected");
  const json = JSON.stringify(first.state);
  console.log(`Dry run: ${states.length} invoices selected; state for invoice ${first.invoice_number} (${first.split}):\n`);
  console.log(JSON.stringify(first.state, null, 2));
  console.log(`\nState: ${json.length} characters compact (~${Math.ceil(json.length / 4)} tokens); questions: ${JSON.stringify(QUESTIONS).length} characters.`);
  process.exit(0);
}

if (existsSync(".env")) process.loadEnvFile(".env");
const ask = createAsker({ client: new TypeSafeClient({ defaultModel: model }), model });

const results: (JevAnswer & { invoice_number: string; split: Split })[] = [];
for (const [i, s] of states.entries()) {
  results.push({ invoice_number: s.invoice_number, split: s.split, ...(await ask(s.state)) });
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${states.length}`);
}

function median(xs: readonly number[]): string {
  if (xs.length === 0) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return (s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2).toFixed(4);
}

console.log(`Jev answers (model requested: ${model}; threshold ${threshold}; tokens are for new calls only)`);
console.log(
  formatTable(
    [...SPLITS, "all" as const].map((sp) => {
      const r = results.filter((x) => sp === "all" || x.split === sp);
      const fresh = r.filter((x) => !x.cached);
      return {
        split: sp,
        invoices: r.length,
        median_p: median(r.map((x) => x.p_same_order)),
        at_or_above_threshold: r.filter((x) => x.p_same_order >= threshold).length,
        cache_hits: r.length - fresh.length,
        input_tokens: fresh.reduce((n, x) => n + x.usage.input_tokens, 0),
        output_tokens: fresh.reduce((n, x) => n + x.usage.output_tokens, 0),
      };
    }),
  ),
);

const modelsReturned = [...new Set(results.map((r) => r.model_returned))].sort();
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
      threshold,
      invoices: results.map((r) => ({
        invoice_number: r.invoice_number,
        split: r.split,
        p_same_order: r.p_same_order,
        route_after_jev: routeAfterJev(r.p_same_order, threshold),
        cached: r.cached,
      })),
    },
    null,
    2,
  ),
);
console.log(`Wrote ${displayPath(outFile)}`);
