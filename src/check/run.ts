/**
 * Phase 1 deterministic tier: runs the rules over every invoice in invoice_number order and
 * routes each one (auto_approve / jev / human_review / excluded). Prints a per-split summary
 * and writes out/check.json.
 *
 *   npm run check [-- --raw-dir data/raw --out out/check.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RAW_DIR, openRawDb } from "../data/db.js";
import { displayPath, formatTable } from "../report/format.js";
import { loadBundles } from "./load.js";
import { RULES } from "./rules.js";
import { summarize, triage } from "./triage.js";
import { OUTCOMES, ROUTES, SPLITS } from "./types.js";

const { values } = parseArgs({
  options: {
    "raw-dir": { type: "string", default: DEFAULT_RAW_DIR },
    out: { type: "string", default: "out/check.json" },
  },
});
const rawDir = values["raw-dir"] ?? DEFAULT_RAW_DIR;
const outFile = values.out ?? "out/check.json";

const { bundles, catalog } = await loadBundles(await openRawDb(rawDir));
const triaged = triage(bundles, catalog);
const summary = summarize(triaged);

const share = (n: number, of: number) => (of === 0 ? "—" : `${((100 * n) / of).toFixed(1)}%`);

for (const split of [...SPLITS, "all"] as const) {
  const s = summary[split];
  console.log(`\n${split} — ${s.invoices.toLocaleString("en-US")} invoices`);
  console.log(formatTable(ROUTES.map((route) => ({ route, invoices: s.routes[route], share: share(s.routes[route], s.invoices) }))));
  console.log();
  console.log(
    formatTable(
      RULES.map(({ id }) => ({
        rule: id,
        ...Object.fromEntries(OUTCOMES.map((o) => [o, s.rules[id]?.[o] ?? 0])),
        pass_with_notes: triaged.filter(
          (t) => (split === "all" || t.split === split) && t.results.some((r) => r.rule === id && r.outcome === "pass" && r.reasons.length > 0),
        ).length,
      })),
    ),
  );
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      raw_dir: displayPath(rawDir),
      routing: "excluded if times_sent > 1; else human_review if any rule flags; else jev if any is ambiguous; else auto_approve",
      rules: RULES.map(({ id, description }) => ({ id, description })),
      summary,
      // Only rule results that are not a plain pass, to keep the file readable.
      invoices: triaged.map(({ results, ...t }) => ({
        ...t,
        findings: results.filter((r) => r.outcome !== "pass" || r.reasons.length > 0),
      })),
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${displayPath(outFile)}`);
