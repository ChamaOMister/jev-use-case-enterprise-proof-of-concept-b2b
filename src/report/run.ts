/**
 * Builds the results report from the JSON in out/ and writes one self-contained HTML page.
 * Needs out/audit.json, check.json, features.json, jev.json and eval.json; makes no API calls.
 *
 *   npm run report [-- --out docs/report.html --fragment out/report-fragment.html]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { displayPath } from "./format.js";
import { renderReport, toDocument, toFragment, type ReportSources } from "./html.js";

const { values } = parseArgs({
  options: {
    "out-dir": { type: "string", default: "out" },
    out: { type: "string", default: "docs/report.html" },
    fragment: { type: "string" },
  },
});
const outDir = values["out-dir"] ?? "out";
const read = (name: string) => JSON.parse(readFileSync(path.join(outDir, `${name}.json`), "utf8"));

const sources: ReportSources = {
  audit: read("audit"),
  check: read("check"),
  features: read("features"),
  jev: read("jev"),
  eval: read("eval"),
};
const report = renderReport(sources);

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`Wrote ${displayPath(file)} (${Math.round(text.length / 1024)} KB)`);
};
write(values.out ?? "docs/report.html", toDocument(report));
if (values.fragment) write(values.fragment, toFragment(report));
