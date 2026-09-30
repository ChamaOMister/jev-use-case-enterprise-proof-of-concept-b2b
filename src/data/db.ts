import { existsSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/** The CSVs as delivered, keyed by the table name they load into. */
export const RAW_TABLES = {
  invoices: "invoices.csv",
  invoice_lines: "invoice_lines.csv",
  scheduled_installments: "scheduled_installments.csv",
  customers: "customers.csv",
  products: "products.csv",
  sellers: "sellers.csv",
  monthly_sales: "monthly_sales.csv",
} as const;

export type TableName = keyof typeof RAW_TABLES;

export const DEFAULT_RAW_DIR = "data/raw";

/** Evaluation splits by billing date. The demo batch is the pending September delivery. */
export const SPLIT_SQL = `CASE
  WHEN billing_date < DATE '2026-01-01' THEN 'tune'
  WHEN billing_date < DATE '2026-09-01' THEN 'test'
  ELSE 'demo' END`;

/** A plain JSON-safe value: BIGINT becomes number, DATE becomes "YYYY-MM-DD". */
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export class Db {
  constructor(private readonly conn: DuckDBConnection) {}

  async all<T extends Row = Row>(sql: string): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjectsJS().map((row) => {
      const out: Row = {};
      for (const [key, value] of Object.entries(row)) out[key] = toCell(value, key);
      return out as T;
    });
  }

  async one<T extends Row = Row>(sql: string): Promise<T> {
    const rows = await this.all<T>(sql);
    if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}: ${sql}`);
    return rows[0]!;
  }

  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }
}

function toCell(value: unknown, column: string): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    // Cents totals must stay exact; refuse to silently lose precision.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`Column ${column}: ${value} exceeds the safe integer range`);
    }
    return Number(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/** Opens an in-memory DuckDB with every raw CSV loaded as a table of the same name. */
export async function openRawDb(rawDir = DEFAULT_RAW_DIR): Promise<Db> {
  const missing = Object.values(RAW_TABLES).filter((file) => !existsSync(path.join(rawDir, file)));
  if (missing.length > 0) {
    throw new Error(`Missing CSVs in ${path.resolve(rawDir)}: ${missing.join(", ")}`);
  }

  const instance = await DuckDBInstance.create(":memory:");
  const db = new Db(await instance.connect());
  for (const [table, file] of Object.entries(RAW_TABLES)) {
    const csv = path.join(rawDir, file).replaceAll("'", "''");
    await db.run(`CREATE TABLE ${table} AS SELECT * FROM read_csv('${csv}', header = true, auto_detect = true)`);
  }
  return db;
}
