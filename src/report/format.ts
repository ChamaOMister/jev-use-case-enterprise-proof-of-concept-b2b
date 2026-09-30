import path from "node:path";
import type { Cell, Row } from "../data/db.js";

export function formatCell(v: Cell | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : String(v);
  return String(v);
}

/** Renders rows as an indented plain-text table; numeric columns are right-aligned. */
export function formatTable(rows: Row[]): string {
  if (rows.length === 0) return "    (no rows)";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cells = rows.map((r) => cols.map((c) => formatCell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const numeric = cols.map((c) => rows.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === "number"));
  const line = (vals: string[]) =>
    "    " + vals.map((v, i) => (numeric[i] ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join("  ");
  return [line(cols), line(widths.map((w) => "─".repeat(w))), ...cells.map(line)].join("\n");
}

/**
 * A path safe to write into generated output: relative to the project, with forward slashes.
 * A path outside the project is reduced to its last segment so no machine layout leaks.
 */
export function displayPath(p: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, path.resolve(cwd, p));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return `<outside project>/${path.basename(p)}`;
  return rel.split(path.sep).join("/");
}
