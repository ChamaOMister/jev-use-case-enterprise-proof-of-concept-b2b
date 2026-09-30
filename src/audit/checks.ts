import { RAW_TABLES, SPLIT_SQL, type Cell, type Db, type Row, type TableName } from "../data/db.js";

export type Status = "match" | "differs" | "info";

export interface AuditResult {
  id: string;
  /** The claim being verified, as stated in CLAUDE.md. */
  claim: string;
  expected: string | null;
  observed: string;
  status: Status;
  table: Row[];
  /** Extra detail written to out/audit.json but not printed. */
  detail?: unknown;
}

export interface Check {
  id: string;
  run: (db: Db) => Promise<Omit<AuditResult, "id">>;
}

const EXPECTED_ROWS: Record<TableName, number> = {
  invoices: 6468,
  invoice_lines: 19361,
  scheduled_installments: 12757,
  customers: 305,
  products: 24,
  sellers: 5,
  monthly_sales: 225,
};

const EXPECTED_COLUMNS: Record<TableName, string[]> = {
  invoices: [
    "invoice_number", "billing_date", "billing_month", "customer_id", "seller_id", "business_unit",
    "payment_schedule", "line_count", "invoice_total_cents", "commission_total_cents",
    "first_delivery_month", "last_delivery_month", "times_sent", "from_pending_delivery",
  ],
  invoice_lines: [
    "invoice_number", "line_number", "billing_date", "customer_id", "seller_id", "business_unit",
    "product_id", "product_name", "product_category", "package_quantity", "unit_price_cents",
    "line_amount_cents", "commission_amount_cents",
  ],
  scheduled_installments: ["invoice_number", "customer_id", "installment_number", "due_date", "amount_cents"],
  customers: [
    "customer_id", "customer_name", "segment", "city", "state", "seller_id", "business_unit",
    "first_billing_date", "last_billing_date", "invoice_count", "total_sales_cents",
  ],
  products: ["product_id", "product_name", "product_category", "business_unit"],
  sellers: ["seller_id", "business_unit", "territory", "territory_city_count", "customer_count"],
  monthly_sales: ["month", "business_unit", "seller_id", "invoice_count", "sales_cents", "commission_cents"],
};

const INTEGER_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmt = (n: Cell | undefined): string => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const num = (v: Cell | undefined): number => {
  if (typeof v !== "number") throw new Error(`Expected a number, got ${String(v)}`);
  return v;
};

/** Turns long rows (rowKey, colKey, value) into one row per rowKey with a column per colKey. */
function pivot(rows: Row[], rowKey: string, colKey: string, valueKey: string, colOrder?: string[]): Row[] {
  const cols = colOrder ?? [...new Set(rows.map((r) => String(r[colKey])))];
  const byRow = new Map<string, Row>();
  for (const r of rows) {
    const key = String(r[rowKey]);
    const out = byRow.get(key) ?? { [rowKey]: r[rowKey] ?? null, ...Object.fromEntries(cols.map((c) => [c, null])) };
    out[String(r[colKey])] = r[valueKey] ?? null;
    byRow.set(key, out);
  }
  return [...byRow.values()];
}

/** Cramér's V for a contingency table given as long rows of counts. 0 = independent, 1 = fully determined. */
export function cramersV(rows: Row[], aKey: string, bKey: string, countKey: string): number {
  const a = [...new Set(rows.map((r) => String(r[aKey])))];
  const b = [...new Set(rows.map((r) => String(r[bKey])))];
  const count = new Map(rows.map((r) => [`${r[aKey]}|${r[bKey]}`, num(r[countKey])]));
  const n = [...count.values()].reduce((s, x) => s + x, 0);
  const aTot = a.map((x) => b.reduce((s, y) => s + (count.get(`${x}|${y}`) ?? 0), 0));
  const bTot = b.map((y) => a.reduce((s, x) => s + (count.get(`${x}|${y}`) ?? 0), 0));
  let chi2 = 0;
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const expected = (aTot[i]! * bTot[j]!) / n;
      if (expected > 0) chi2 += ((count.get(`${x}|${y}`) ?? 0) - expected) ** 2 / expected;
    }),
  );
  const k = Math.min(a.length, b.length) - 1;
  return k > 0 ? Math.sqrt(chi2 / (n * k)) : 0;
}

export const CHECKS: Check[] = [
  {
    id: "row_counts",
    async run(db) {
      const rows = await db.all(
        Object.keys(RAW_TABLES)
          .map((t) => `SELECT '${t}' AS table_name, count(*) AS rows FROM ${t}`)
          .join(" UNION ALL "),
      );
      const table = rows.map((r) => {
        const expected = EXPECTED_ROWS[r.table_name as TableName];
        return { ...r, expected, ok: r.rows === expected };
      });
      const bad = table.filter((r) => !r.ok);
      return {
        claim: "Row counts match the delivered file table",
        expected: Object.entries(EXPECTED_ROWS).map(([t, n]) => `${t} ${fmt(n)}`).join(" · "),
        observed: bad.length === 0 ? "all 7 tables match" : `${bad.length} table(s) differ`,
        status: bad.length === 0 ? "match" : "differs",
        table,
      };
    },
  },

  {
    id: "schema",
    async run(db) {
      const cols = await db.all<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`,
      );
      const table = (Object.keys(EXPECTED_COLUMNS) as TableName[]).map((t) => {
        const actual = cols.filter((c) => c.table_name === t);
        const names = new Set(actual.map((c) => c.column_name));
        const missing = EXPECTED_COLUMNS[t].filter((c) => !names.has(c));
        const extra = [...names].filter((c) => !EXPECTED_COLUMNS[t].includes(c));
        const nonIntegerCents = actual.filter((c) => c.column_name.endsWith("_cents") && !INTEGER_TYPES.has(c.data_type));
        const dates = actual.filter((c) => c.data_type === "DATE").map((c) => c.column_name);
        return {
          table_name: t,
          missing: missing.join(", ") || "—",
          extra: extra.join(", ") || "—",
          non_integer_cents: nonIntegerCents.map((c) => `${c.column_name}:${c.data_type}`).join(", ") || "—",
          date_columns: dates.join(", ") || "—",
        };
      });
      const problems = table.filter((r) => r.missing !== "—" || r.non_integer_cents !== "—");
      return {
        claim: "Columns match the documented grain; every *_cents column is an integer type",
        expected: "no missing columns; all money columns integer",
        observed:
          problems.length === 0
            ? "all documented columns present; all *_cents columns are integers"
            : `${problems.length} table(s) with missing columns or non-integer cents`,
        status: problems.length === 0 ? "match" : "differs",
        table,
        detail: cols,
      };
    },
  },

  {
    id: "keys_and_references",
    async run(db) {
      const table = await db.all(`
        SELECT 'dup invoices.invoice_number' AS check_name,
               (SELECT count(*) - count(DISTINCT invoice_number) FROM invoices) AS violations
        UNION ALL SELECT 'dup invoice_lines (invoice_number, line_number)',
               (SELECT count(*) FROM invoice_lines) - (SELECT count(*) FROM (SELECT DISTINCT invoice_number, line_number FROM invoice_lines))
        UNION ALL SELECT 'dup installments (invoice_number, installment_number)',
               (SELECT count(*) FROM scheduled_installments) - (SELECT count(*) FROM (SELECT DISTINCT invoice_number, installment_number FROM scheduled_installments))
        UNION ALL SELECT 'dup customers.customer_id', (SELECT count(*) - count(DISTINCT customer_id) FROM customers)
        UNION ALL SELECT 'dup products.product_id', (SELECT count(*) - count(DISTINCT product_id) FROM products)
        UNION ALL SELECT 'dup sellers.seller_id', (SELECT count(*) - count(DISTINCT seller_id) FROM sellers)
        UNION ALL SELECT 'lines without invoice', (SELECT count(*) FROM invoice_lines ANTI JOIN invoices USING (invoice_number))
        UNION ALL SELECT 'invoices without lines', (SELECT count(*) FROM invoices ANTI JOIN invoice_lines USING (invoice_number))
        UNION ALL SELECT 'installments without invoice', (SELECT count(*) FROM scheduled_installments ANTI JOIN invoices USING (invoice_number))
        UNION ALL SELECT 'invoices without installments', (SELECT count(*) FROM invoices ANTI JOIN scheduled_installments USING (invoice_number))
        UNION ALL SELECT 'invoices with unknown customer', (SELECT count(*) FROM invoices ANTI JOIN customers USING (customer_id))
        UNION ALL SELECT 'lines with unknown product', (SELECT count(*) FROM invoice_lines ANTI JOIN products USING (product_id))
        UNION ALL SELECT 'invoices with unknown seller', (SELECT count(*) FROM invoices ANTI JOIN sellers USING (seller_id))`);
      const bad = table.filter((r) => r.violations !== 0);
      return {
        claim: "Keys are unique and every reference resolves",
        expected: "0 violations",
        observed: bad.length === 0 ? "0 violations" : `${bad.length} check(s) with violations`,
        status: bad.length === 0 ? "match" : "differs",
        table,
      };
    },
  },

  {
    id: "period",
    async run(db) {
      const r = await db.one(`
        SELECT min(billing_date) AS first_invoice, max(billing_date) AS last_invoice,
               (SELECT min(due_date) FROM scheduled_installments) AS first_due,
               (SELECT max(due_date) FROM scheduled_installments) AS last_due,
               (SELECT min(CAST(month AS VARCHAR)) FROM monthly_sales) AS first_month,
               (SELECT max(CAST(month AS VARCHAR)) FROM monthly_sales) AS last_month
        FROM invoices`);
      const inside = String(r.first_invoice) >= "2023-01-01" && String(r.last_invoice) <= "2026-09-25";
      return {
        claim: "Period: 2023-01-01 to 2026-09-25",
        expected: "billing dates within 2023-01-01 … 2026-09-25",
        observed: `invoices ${r.first_invoice} … ${r.last_invoice}; monthly_sales ${r.first_month} … ${r.last_month}`,
        status: inside && r.last_invoice === "2026-09-25" ? "match" : "differs",
        table: [r],
      };
    },
  },

  {
    id: "payment_schedules",
    async run(db) {
      const table = await db.all(`
        WITH k AS (SELECT invoice_number, count(*) AS n FROM scheduled_installments GROUP BY 1)
        SELECT i.payment_schedule, count(*) AS invoices,
               round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct,
               CAST(list_sort(list_distinct(list(coalesce(k.n, 0)))) AS VARCHAR) AS installment_rows_per_invoice
        FROM invoices i LEFT JOIN k USING (invoice_number)
        GROUP BY 1 ORDER BY 2 DESC`);
      return {
        claim: "Schedules: Upfront, 30 Days, 3 installments (30/60/90), and a 4-installment 0-30-60-90 variant",
        expected: "4 distinct values",
        observed: `${table.length} distinct values: ${table.map((r) => JSON.stringify(r.payment_schedule)).join(", ")}`,
        status: table.length === 4 ? "match" : "differs",
        table,
      };
    },
  },

  {
    id: "commission_rounding",
    async run(db) {
      const r = await db.one(`
        WITH l AS (
          SELECT line_amount_cents AS a, commission_amount_cents AS c,
                 (line_amount_cents * 5) // 100 AS q, (line_amount_cents * 5) % 100 AS rem
          FROM invoice_lines)
        SELECT count(*) AS lines,
               count(*) FILTER (WHERE a < 0) AS negative_amounts,
               count(*) FILTER (WHERE rem = 0) AS exact_5pct_lines,
               count(*) FILTER (WHERE rem = 50) AS tie_lines,
               count(*) FILTER (WHERE c = q) AS floor,
               count(*) FILTER (WHERE c = q + CAST(rem > 0 AS INTEGER)) AS ceil,
               count(*) FILTER (WHERE c = q + CAST(rem >= 50 AS INTEGER)) AS half_up,
               count(*) FILTER (WHERE c = q + CAST(rem > 50 AS INTEGER)) AS half_down,
               count(*) FILTER (WHERE c = q + CAST(rem > 50 OR (rem = 50 AND q % 2 = 1) AS INTEGER)) AS half_even
        FROM l`);
      const inv = await db.one(`
        WITH s AS (SELECT invoice_number, sum(commission_amount_cents) AS line_commission
                   FROM invoice_lines GROUP BY 1)
        SELECT count(*) AS invoices,
               count(*) FILTER (WHERE i.commission_total_cents <> s.line_commission) AS total_ne_sum_of_lines,
               count(*) FILTER (WHERE i.commission_total_cents <> (i.invoice_total_cents * 5 + 50) // 100) AS total_ne_5pct_of_invoice_total
        FROM invoices i JOIN s USING (invoice_number)`);
      const rules = ["floor", "ceil", "half_up", "half_down", "half_even"] as const;
      const matching = rules.filter((rule) => r[rule] === r.lines);
      const ties = num(r.tie_lines);
      return {
        claim: "Commission is exactly 5% on every line; invoice commission = Σ line commissions",
        expected: "one rounding rule matches every line; 0 invoice mismatches",
        observed:
          (matching.length > 0
            ? `rules matching all ${fmt(r.lines)} lines: ${matching.join(", ")}`
            : "no candidate rounding rule matches every line") +
          ` (${fmt(r.exact_5pct_lines)} lines are exact, ${fmt(ties)} are .5-cent ties)` +
          `; invoice total ≠ Σ lines: ${fmt(inv.total_ne_sum_of_lines)}`,
        status: matching.length > 0 && inv.total_ne_sum_of_lines === 0 ? "match" : "differs",
        table: Object.entries({ ...r, ...inv }).map(([metric, value]) => ({ metric, value })),
      };
    },
  },

  {
    id: "unit_prices",
    async run(db) {
      const table = await db.all(`
        WITH t AS (SELECT product_id, count(DISTINCT unit_price_cents) AS prices FROM invoice_lines GROUP BY 1)
        SELECT prices AS distinct_prices_per_product, count(*) AS products FROM t GROUP BY 1 ORDER BY 1`);
      const multi = await db.all(`
        SELECT product_id, year(billing_date) AS year, count(DISTINCT unit_price_cents) AS prices,
               CAST(list_sort(list_distinct(list(unit_price_cents))) AS VARCHAR) AS price_list
        FROM invoice_lines GROUP BY 1, 2 HAVING count(DISTINCT unit_price_cents) > 1 ORDER BY 1, 2`);
      const maxPrices = Math.max(...table.map((r) => num(r.distinct_prices_per_product)));
      return {
        claim: "Each product has ~4 unit prices, one per yearly price list",
        expected: "≤ 4 prices per product; 1 price per product-year",
        observed: `max ${maxPrices} prices per product; ${multi.length} product-year(s) with more than one price`,
        status: maxPrices <= 4 && multi.length === 0 ? "match" : "differs",
        table,
        detail: { product_years_with_multiple_prices: multi },
      };
    },
  },

  {
    id: "customer_seller",
    async run(db) {
      const r = await db.one(`
        SELECT
          (SELECT count(*) FROM (SELECT customer_id FROM invoices GROUP BY 1 HAVING count(DISTINCT seller_id) > 1)) AS customers_with_many_sellers,
          (SELECT count(*) FROM (SELECT customer_id FROM invoices GROUP BY 1 HAVING count(DISTINCT business_unit) > 1)) AS customers_with_many_units,
          (SELECT count(*) FROM invoices i JOIN customers c USING (customer_id) WHERE i.seller_id <> c.seller_id) AS invoices_seller_ne_customer_seller`);
      const sellers = await db.all(`SELECT * FROM sellers ORDER BY seller_id`);
      const ok = Object.values(r).every((v) => v === 0);
      return {
        claim: "Each customer belongs to exactly one seller (so 'same seller' carries no signal)",
        expected: "0 / 0 / 0",
        observed: Object.entries(r).map(([k, v]) => `${k}=${fmt(v)}`).join(", "),
        status: ok ? "match" : "differs",
        table: sellers,
      };
    },
  },

  {
    id: "schedule_by_segment",
    async run(db) {
      const long = await db.all(`
        SELECT c.segment, i.payment_schedule, count(*) AS n,
               round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY c.segment), 1) AS pct
        FROM invoices i JOIN customers c USING (customer_id)
        GROUP BY 1, 2 ORDER BY 1, 2`);
      const v = cramersV(long, "segment", "payment_schedule", "n");
      const totals = new Map<string, number>();
      for (const r of long) totals.set(String(r.segment), (totals.get(String(r.segment)) ?? 0) + num(r.n));
      const table = pivot(long, "segment", "payment_schedule", "pct").map((r) => ({
        ...r,
        invoices: totals.get(String(r.segment)) ?? 0,
      }));
      return {
        claim: "Payment schedule varies strongly by segment (usable 'unusual schedule' signal)",
        expected: null,
        observed: `Cramér's V (segment × schedule) = ${v.toFixed(3)}; table shows % of each segment's invoices`,
        status: "info",
        table,
        detail: { cramers_v: v, counts: long },
      };
    },
  },

  {
    id: "near_duplicates",
    async run(db) {
      const long = await db.all(`
        WITH o AS (
          SELECT billing_date, ${SPLIT_SQL} AS split,
                 date_diff('day',
                   lag(billing_date) OVER (PARTITION BY customer_id ORDER BY billing_date, invoice_number),
                   billing_date) AS gap_days
          FROM invoices)
        SELECT gap_days, split, count(*) AS invoices FROM o
        WHERE gap_days <= 7 GROUP BY 1, 2 ORDER BY 1, 2`);
      const splits = ["tune", "test", "demo"];
      const table: Row[] = pivot(long, "gap_days", "split", "invoices", splits).map((r) => ({
        ...r,
        all: splits.reduce((s, k) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0),
      }));
      const upTo = (d: number): Row => {
        const rows = table.filter((r) => num(r.gap_days) <= d);
        const sum = (k: string) => rows.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
        return { gap_days: `≤ ${d}`, ...Object.fromEntries([...splits, "all"].map((k) => [k, sum(k)])) };
      };
      const le2 = upTo(2);
      const le7 = upTo(7);
      return {
        claim: "418 invoices are billed ≤ 2 days after a prior invoice of the same customer",
        expected: "418",
        observed: `${fmt(le2.all)} invoices with gap ≤ 2 days; ${fmt(le7.all)} with gap ≤ 7 days (Phase 2 candidates)`,
        status: le2.all === 418 ? "match" : "differs",
        table: [...table, le2, le7],
      };
    },
  },

  {
    id: "invoice_number_order",
    async run(db) {
      const r = await db.one(`
        WITH o AS (SELECT invoice_number, billing_date,
                          lag(billing_date) OVER (ORDER BY invoice_number) AS prev_date FROM invoices)
        SELECT any_value(typeof(invoice_number)) AS type,
               CAST(min(invoice_number) AS VARCHAR) AS first_number,
               CAST(max(invoice_number) AS VARCHAR) AS last_number,
               count(*) FILTER (WHERE billing_date < prev_date) AS dates_out_of_order
        FROM o`);
      return {
        claim: "invoice_number order can break same-day ties (point-in-time ordering)",
        expected: "0 invoices dated before their predecessor in invoice_number order",
        observed: `${r.type}, ${r.first_number} … ${r.last_number}; ${fmt(r.dates_out_of_order)} out of order`,
        status: r.dates_out_of_order === 0 ? "match" : "differs",
        table: [r],
      };
    },
  },

  {
    id: "times_sent",
    async run(db) {
      const table = await db.all(`SELECT times_sent, count(*) AS invoices FROM invoices GROUP BY 1 ORDER BY 1`);
      const twice = table.find((r) => r.times_sent === 2)?.invoices ?? 0;
      return {
        claim: "Only 7 invoices have times_sent = 2 (corrections out of scope)",
        expected: "7",
        observed: `${fmt(twice)} invoices with times_sent = 2`,
        status: twice === 7 ? "match" : "differs",
        table,
      };
    },
  },

  {
    id: "pending_batch",
    async run(db) {
      const table = await db.all(`
        SELECT CAST(from_pending_delivery AS BOOLEAN) AS pending, count(*) AS invoices,
               min(billing_date) AS first_date, max(billing_date) AS last_date
        FROM invoices GROUP BY 1 ORDER BY 1`);
      const r = await db.one(`
        SELECT count(*) AS flag_disagrees_with_date FROM invoices
        WHERE CAST(from_pending_delivery AS BOOLEAN) <> (billing_date >= DATE '2026-09-01')`);
      const pending = table.find((t) => t.pending === true);
      const ok =
        r.flag_disagrees_with_date === 0 && pending?.first_date === "2026-09-01" && pending?.last_date === "2026-09-25";
      return {
        claim: "Invoices 2026-09-01 … 2026-09-25 (from_pending_delivery = true, ~145) are the demo batch",
        expected: "~145 pending; flag ⇔ billing_date ≥ 2026-09-01",
        observed: `${fmt(pending?.invoices ?? 0)} pending (${pending?.first_date} … ${pending?.last_date}); flag disagrees with date on ${fmt(r.flag_disagrees_with_date)}`,
        status: ok ? "match" : "differs",
        table,
      };
    },
  },

  {
    id: "splits",
    async run(db) {
      const table = await db.all(`
        SELECT ${SPLIT_SQL} AS split, count(*) AS invoices, count(DISTINCT customer_id) AS customers,
               min(billing_date) AS first_date, max(billing_date) AS last_date
        FROM invoices GROUP BY 1 ORDER BY min(billing_date)`);
      return {
        claim: "Splits: tune 2023–2025, test 2026-01 … 2026-08, demo = Sep 2026",
        expected: null,
        observed: table.map((r) => `${r.split} ${fmt(r.invoices)}`).join(" · "),
        status: "info",
        table,
      };
    },
  },

  {
    id: "seasonality",
    async run(db) {
      // Complete years only, so a partial 2026 doesn't skew the calendar-month shares.
      const long = await db.all(`
        WITH m AS (
          SELECT business_unit,
                 CAST(substr(CAST(month AS VARCHAR), 1, 4) AS INTEGER) AS yr,
                 CAST(substr(CAST(month AS VARCHAR), 6, 2) AS INTEGER) AS mo, sales_cents
          FROM monthly_sales)
        SELECT business_unit, mo,
               round(12.0 * sum(sales_cents) / sum(sum(sales_cents)) OVER (PARTITION BY business_unit), 2) AS idx
        FROM m WHERE yr BETWEEN 2023 AND 2025 GROUP BY 1, 2 ORDER BY 1, 2`);
      const table = pivot(
        long.map((r) => ({ ...r, mo: MONTHS[num(r.mo) - 1] ?? String(r.mo) })),
        "business_unit",
        "mo",
        "idx",
        MONTHS,
      );
      const peaks = table.map((r) => {
        const top = MONTHS.filter((m) => typeof r[m] === "number")
          .sort((a, b) => num(r[b]) - num(r[a]))
          .slice(0, 4);
        return `${r.business_unit}: ${top.join("/")}`;
      });
      return {
        claim: "Agro peaks May–Oct; Home & Garden peaks before Mother's Day, Black Friday, Christmas",
        expected: null,
        observed: `top-4 months (2023–2025, index 1.00 = average month) → ${peaks.join("; ")}`,
        status: "info",
        table,
      };
    },
  },

  {
    id: "revenue_concentration",
    async run(db) {
      const r = await db.one(`
        WITH c AS (SELECT customer_id, sum(invoice_total_cents) AS s FROM invoices GROUP BY 1),
             k AS (SELECT s, row_number() OVER (ORDER BY s DESC) AS rk, count(*) OVER () AS n,
                          sum(s) OVER () AS total FROM c)
        SELECT max(n) AS customers,
               CAST(ceil(max(n) * 0.1) AS INTEGER) AS top_10pct_customers,
               round(sum(s) FILTER (WHERE rk <= 5) / max(total), 4) AS top5_share,
               round(sum(s) FILTER (WHERE rk <= 10) / max(total), 4) AS top10_share,
               round(sum(s) FILTER (WHERE rk <= ceil(n * 0.1)) / max(total), 4) AS top_10pct_share
        FROM k`);
      return {
        claim: "A handful of large accounts dominate revenue",
        expected: null,
        observed: `top 5 = ${pct(num(r.top5_share))}, top 10 = ${pct(num(r.top10_share))}, top 10% (${r.top_10pct_customers} customers) = ${pct(num(r.top_10pct_share))} of invoiced sales`,
        status: "info",
        table: [r],
      };
    },
  },

  {
    id: "monthly_sales_vs_invoices",
    async run(db) {
      const r = await db.one(`
        WITH inv AS (
          SELECT substr(CAST(billing_month AS VARCHAR), 1, 7) AS ym, business_unit, seller_id,
                 count(*) AS invoice_count, sum(invoice_total_cents) AS sales_cents,
                 sum(commission_total_cents) AS commission_cents
          FROM invoices GROUP BY ALL),
        ms AS (
          SELECT substr(CAST(month AS VARCHAR), 1, 7) AS ym, business_unit, seller_id,
                 invoice_count, sales_cents, commission_cents
          FROM monthly_sales)
        SELECT count(*) AS rows_compared,
               count(*) FILTER (WHERE inv.ym IS NULL) AS only_in_monthly_sales,
               count(*) FILTER (WHERE ms.ym IS NULL) AS only_in_invoices,
               count(*) FILTER (WHERE ms.invoice_count <> inv.invoice_count) AS invoice_count_diff,
               count(*) FILTER (WHERE ms.sales_cents <> inv.sales_cents) AS sales_diff,
               count(*) FILTER (WHERE ms.commission_cents <> inv.commission_cents) AS commission_diff
        FROM ms FULL OUTER JOIN inv
          ON ms.ym = inv.ym AND ms.business_unit = inv.business_unit AND ms.seller_id = inv.seller_id`);
      const diffs = ["only_in_monthly_sales", "only_in_invoices", "invoice_count_diff", "sales_diff", "commission_diff"];
      const ok = diffs.every((k) => r[k] === 0);
      return {
        claim: "monthly_sales is an aggregate of invoices (so seasonality must use prior years only)",
        expected: "0 differences",
        observed: ok ? "monthly_sales equals the invoice aggregate on every row" : diffs.map((k) => `${k}=${fmt(r[k])}`).join(", "),
        status: ok ? "match" : "differs",
        table: [r],
      };
    },
  },

  {
    id: "customer_summary_leakage",
    async run(db) {
      const r = await db.one(`
        WITH inv AS (SELECT customer_id, count(*) AS n, sum(invoice_total_cents) AS s,
                            min(billing_date) AS f, max(billing_date) AS l FROM invoices GROUP BY 1)
        SELECT count(*) AS customers,
               count(*) FILTER (WHERE inv.customer_id IS NULL) AS customers_without_invoices,
               count(*) FILTER (WHERE c.invoice_count IS DISTINCT FROM inv.n) AS invoice_count_diff,
               count(*) FILTER (WHERE c.total_sales_cents IS DISTINCT FROM inv.s) AS total_sales_diff,
               count(*) FILTER (WHERE CAST(c.first_billing_date AS DATE) IS DISTINCT FROM inv.f) AS first_date_diff,
               count(*) FILTER (WHERE CAST(c.last_billing_date AS DATE) IS DISTINCT FROM inv.l) AS last_date_diff
        FROM customers c LEFT JOIN inv USING (customer_id)`);
      return {
        claim: "customers.* summary columns are whole-period aggregates → not point-in-time safe",
        expected: null,
        observed:
          "customers.invoice_count / total_sales_cents / first|last_billing_date cover the full period; " +
          "features must recompute them from prior invoices. Differences vs. invoices: " +
          ["invoice_count_diff", "total_sales_diff", "first_date_diff", "last_date_diff"].map((k) => `${k}=${fmt(r[k])}`).join(", "),
        status: "info",
        table: [r],
      };
    },
  },

  {
    id: "dimensions",
    async run(db) {
      const table = await db.all(`
        SELECT business_unit, segment, count(*) AS customers FROM customers GROUP BY ALL ORDER BY ALL`);
      const products = await db.all(`
        SELECT business_unit, count(*) AS products, count(DISTINCT product_category) AS categories
        FROM products GROUP BY ALL ORDER BY ALL`);
      return {
        claim: "Segments, business units and catalog (context for features)",
        expected: null,
        observed: products.map((p) => `${p.business_unit}: ${p.products} products / ${p.categories} categories`).join("; "),
        status: "info",
        table,
        detail: { products },
      };
    },
  },
];
