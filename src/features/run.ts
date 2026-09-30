/**
 * Phase 2: computes each invoice's features from the same customer's earlier invoices, prints a
 * per-split summary of the jev-routed invoices and writes out/features.json for all invoices.
 *
 *   npm run features [-- --raw-dir data/raw --out out/features.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBundles } from "../check/load.js";
import { triage } from "../check/triage.js";
import { SPLITS } from "../check/types.js";
import { DEFAULT_RAW_DIR, openRawDb } from "../data/db.js";
import { displayPath, formatTable } from "../report/format.js";
import { buildFeatures } from "./build.js";
import { FEATURES } from "./features.js";

const { values } = parseArgs({
  options: {
    "raw-dir": { type: "string", default: DEFAULT_RAW_DIR },
    out: { type: "string", default: "out/features.json" },
  },
});
const rawDir = values["raw-dir"] ?? DEFAULT_RAW_DIR;
const outFile = values.out ?? "out/features.json";

const { bundles, catalog } = await loadBundles(await openRawDb(rawDir));
const triaged = new Map(triage(bundles, catalog).map((t) => [t.invoice_number, t]));
const invoices = buildFeatures(bundles).map(({ invoice_number, features }) => {
  const t = triaged.get(invoice_number);
  if (!t) throw new Error(`No triage result for ${invoice_number}`);
  return { invoice_number, split: t.split, route: t.route, features };
});

function median(xs: readonly number[]): string {
  if (xs.length === 0) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return (s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2).toFixed(4);
}
const present = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);
const share = (n: number, of: number) => (of === 0 ? "—" : `${((100 * n) / of).toFixed(1)}%`);

console.log("jev-routed invoices");
console.log(
  formatTable(
    [...SPLITS, "all" as const].map((split) => {
      const f = invoices.filter((i) => i.route === "jev" && (split === "all" || i.split === split)).map((i) => i.features);
      return {
        split,
        invoices: f.length,
        median_product_jaccard: median(present(f.map((x) => x.product_jaccard))),
        union_matches_past_basket: share(f.filter((x) => x.union_matches_past_basket === true).length, f.length),
        median_prior_short_gap_share: median(present(f.map((x) => x.prior_short_gap_share))),
        median_total_ratio: median(present(f.map((x) => x.total_ratio))),
      };
    }),
  ),
);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ generated_at: new Date().toISOString(), raw_dir: displayPath(rawDir), features: FEATURES, invoices }, null, 2),
);
console.log(`\nWrote ${displayPath(outFile)}`);
