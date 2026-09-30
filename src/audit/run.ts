/**
 * Phase 0 data audit: loads the raw CSVs into DuckDB and re-verifies every
 * "Facts already checked" claim from CLAUDE.md. Prints a report and writes out/audit.json.
 *
 *   npm run audit [-- --raw-dir data/raw --out out/audit.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RAW_DIR, openRawDb } from "../data/db.js";
import { displayPath, formatTable } from "../report/format.js";
import { CHECKS, type AuditResult } from "./checks.js";

const { values } = parseArgs({
  options: {
    "raw-dir": { type: "string", default: DEFAULT_RAW_DIR },
    out: { type: "string", default: "out/audit.json" },
  },
});
const rawDir = values["raw-dir"] ?? DEFAULT_RAW_DIR;
const outFile = values.out ?? "out/audit.json";

const ICON = { match: "✔ MATCH  ", differs: "✖ DIFFERS", info: "· INFO   ", error: "! ERROR  " } as const;

const db = await openRawDb(rawDir);
const results: (AuditResult | { id: string; status: "error"; error: string })[] = [];

for (const check of CHECKS) {
  try {
    const result: AuditResult = { id: check.id, ...(await check.run(db)) };
    results.push(result);
    console.log(`\n${ICON[result.status]}  ${result.id} — ${result.claim}`);
    if (result.expected !== null) console.log(`    expected: ${result.expected}`);
    console.log(`    observed: ${result.observed}`);
    console.log(formatTable(result.table));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({ id: check.id, status: "error", error });
    console.log(`\n${ICON.error}  ${check.id}\n    ${error}`);
  }
}

const tally = (s: string) => results.filter((r) => r.status === s).length;
console.log(
  `\nSummary: ${tally("match")} match · ${tally("differs")} differ · ${tally("info")} info · ${tally("error")} error`,
);

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ generated_at: new Date().toISOString(), raw_dir: displayPath(rawDir), results }, null, 2),
);
console.log(`Wrote ${outFile}`);
