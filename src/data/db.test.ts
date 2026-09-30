import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { Db, type Row } from "./db.js";

describe("Db", () => {
  let db: Db;
  let instance: DuckDBInstance;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    db = new Db(await instance.connect());
  });

  it("all() returns correctly converted types", async () => {
    const rows = await db.all("SELECT 'hello' as str, 123 as num, true as bool, NULL as nil, DATE '2025-03-10' as dt, 42::BIGINT as bg");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      str: "hello",
      num: 123,
      bool: true,
      nil: null,
      dt: "2025-03-10",
      bg: 42,
    });
  });

  it("all() throws on unsafe BIGINT", async () => {
    const unsafeQuery = "SELECT 9007199254740992::BIGINT as bg";
    await expect(db.all(unsafeQuery)).rejects.toThrow(/exceeds the safe integer range/);
  });

  it("one() returns a single row", async () => {
    const row = await db.one("SELECT 1 as x");
    expect(row).toEqual({ x: 1 });
  });

  it("one() throws if there is not exactly 1 row", async () => {
    await expect(db.one("SELECT 1 WHERE 1=0")).rejects.toThrow(/Expected 1 row, got 0/);
    await expect(db.one("SELECT 1 UNION ALL SELECT 2")).rejects.toThrow(/Expected 1 row, got 2/);
  });
});
