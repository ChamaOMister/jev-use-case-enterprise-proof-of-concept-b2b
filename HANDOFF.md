# Handoff: small tasks while Phase 2 waits

You are helping on `biomix-intake-triage`, a TypeScript project (Node ≥ 20, DuckDB, Vitest).
It triages synthetic invoices in three tiers: deterministic rules → Jev model → human review.
Phase 0 (data audit) and Phase 1 (deterministic rules, `npm run check`) are done and working.

Your job is the **small, well-defined tasks below**, in order. Design work (Phase 2 features,
Phase 3 Jev integration, rule thresholds) is **not** yours: it waits for the lead engineer.

## Ground rules (read before any change)

1. **Never commit or push.** Leave all changes as uncommitted edits.
2. **Only touch the files a task names.** In particular, do not edit `src/check/rules.ts`,
   `triage.ts`, `history.ts`, `load.ts`, `run.ts`, `types.ts`, `src/audit/*`, `src/data/db.ts`,
   `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts` or `.gitignore`.
3. **Do not install packages** or change dependency versions.
4. **Privacy (public repo):** no absolute paths, usernames, emails, API keys or machine details in
   any file, test or comment. Never read, print or edit `.env`. Never touch `data/raw/`, `out/`
   or `.claude/`.
5. **After every task run both commands and read the output:**
   ```bash
   npm run typecheck
   npm test
   ```
   Both must pass before you start the next task. Do not report "done" without seeing them pass.
6. **If a new test fails against code you were told not to change, do not "fix" that code.**
   Remove the failing test, then write the test name, the exact failure message and your guess
   at the cause in the Progress log below. That's a finding for the lead, not a bug for you.
7. If a task is unclear, skip it and say why in the Progress log. Don't guess.

## Code conventions (match them exactly)

- ES modules: relative imports end in `.js` even for `.ts` files (`import { x } from "./dates.js";`).
- Strict TypeScript with `noUncheckedIndexedAccess`: array/record indexing returns `T | undefined`,
  so use `arr[0]!` or `arr[0]?.x` in tests, as the existing tests do.
- Tests: Vitest `describe` / `it` / `expect`, one behaviour per `it`, and a name that states the
  behaviour ("rejects an impossible date", not "test 3"). Put the test file next to the code
  (`foo.ts` → `foo.test.ts`). Tests must never read `data/raw/`.
- Look at `src/check/rules.test.ts` and `src/report/format.test.ts` for style before writing tests.

---

## Task 1: `dates.ts` must reject impossible calendar dates (small fix + tests)

**Files:** `src/check/dates.ts`, new `src/check/dates.test.ts`.

**Problem:** `Date.parse("2025-02-30T00:00:00Z")` does not return `NaN` in Node; it rolls over
to 2025-03-02. So `toUtcMs("2025-02-30")` in `src/check/dates.ts` silently accepts an impossible date.

**Steps:**
1. Create `src/check/dates.test.ts` with these tests, and run `npm test`. The Feb-30 test **must fail** first:
   - `addDays("2024-12-31", 1)` is `"2025-01-01"` (year boundary).
   - `addDays("2024-02-28", 1)` is `"2024-02-29"` (leap year).
   - `addDays("2025-02-28", 1)` is `"2025-03-01"` (non-leap year).
   - `addDays("2025-01-31", 30)` is `"2025-03-02"`.
   - `addDays("2025-03-10", 0)` is `"2025-03-10"`.
   - `daysBetween("2025-03-10", "2025-03-12")` is `2`; the reverse is `-2`; same date is `0`.
   - `daysBetween("2024-02-28", "2024-03-01")` is `2` (leap year).
   - `addDays("2025-13-01", 1)` throws (use `expect(() => ...).toThrow(/YYYY-MM-DD/)`).
   - `addDays("2025-02-30", 1)` throws: **this one fails before the fix**.
   - `daysBetween("2025-03-10", "not a date")` throws.
2. Fix `toUtcMs` in `src/check/dates.ts`: after parsing, also throw the same error when
   `new Date(ms).toISOString().slice(0, 10) !== isoDate`. Keep the existing error message format
   (`Not a YYYY-MM-DD date: ...`). Change nothing else in the file.
3. Run `npm run typecheck`, `npm test` and **also `npm run check`**, which needs local data. If
   `npm run check` fails with "Missing CSVs", note it in the log and move on. If it runs, the
   `all` block must still show `auto_approve 6,043 · jev 418 · human_review 0 · excluded 7`.

## Task 2: tests for the history helpers (tests only)

**Files:** new `src/check/history.test.ts`. Do not edit `history.ts`.

Use `bundle()` from `./test-fixtures.js` to build invoices (see `rules.test.ts`). Test:
- `lineSignature` gives the same string for the same products and quantities in a different line order.
- `lineSignature` gives different strings when only a quantity differs.
- `History.customerInvoices("C1")` is an empty array for a customer with no invoices.
- `customerInvoices` returns the customer's invoices oldest first and leaves out other customers'.
- `listPrice(product, year)` returns `undefined` when the product has no sales in that year.
- `listPrice` returns the most common price. With two prices seen equally often, it returns the
  **one seen first**. Build three 2025 invoices with P1 at 1200, 1000, 1200 → 1200; and two at
  1000 then 1200 → 1000.
- `listPrice` counts lines per calendar year separately (a 2024 price doesn't count for 2025).
- `latestYearBefore("P1", 2026)` returns 2024 when P1 was billed only in 2023 and 2024, and
  `undefined` when P1 was billed only in 2026 or later.

Invoice numbers must increase in the order you `add` them (`"000001"`, `"000002"`, …), or `History` throws.

## Task 3: tests for the table printer (tests only)

**Files:** `src/report/format.test.ts` (add new `describe` blocks; keep the existing `displayPath` tests unchanged).

Test `formatCell` and `formatTable` from `./format.js`:
- `formatCell(null)` and `formatCell(undefined)` are `"—"`.
- `formatCell(1234567)` is `"1,234,567"`; `formatCell(0.25)` is `"0.25"`; `formatCell(true)` is `"true"`.
- `formatTable([])` is `"    (no rows)"`.
- For `[{ name: "a", n: 5 }, { name: "bbb", n: 1200 }]` the output has 4 lines (header, rule, 2 rows);
  every line starts with 4 spaces; the number column is right-aligned (the row for `a` ends with
  `"    5"`); the text column is left-aligned. Check the exact strings by splitting on `"\n"`.
- A column where one row has `null` and the rest are numbers is still right-aligned, and the
  `null` shows as `"—"`.

## Task 4: rewrite `README.md` (docs only)

**Files:** `README.md`.

Replace the two-line README with a short, accurate one. Get facts **only** from `package.json`,
`src/check/rules.ts` (the `RULES` descriptions and constants) and `src/check/triage.ts`
(`routeFor`). Sections:
1. **What it is:** one paragraph on the three tiers, on synthetic data.
2. **Setup:** Node ≥ 20, `npm install`, place the delivered CSVs in `data/raw/` (not included; gitignored).
   `TYPESAFE_API_KEY` in `.env` is only needed for the Jev phase. Don't show any key value.
3. **Commands:** `npm run audit`, `npm run check`, `npm test`, `npm run typecheck`, with one line
   each saying what each does and what it writes (`out/audit.json`, `out/check.json`). Say that
   `features`, `jev`, `eval`, `build:data` and `dev` are placeholders for later phases.
4. **Phase 1 rules:** a table of the 8 rule ids with a one-line plain-English description each, and
   which outcome each can produce (`near_duplicate_window` → ambiguous; all others → flag;
   `price_list` can also pass with a note). Then the routing order: excluded (`times_sent > 1`) →
   human review (any flag) → Jev (any ambiguous) → auto-approve.
5. **Splits:** tune < 2026-01-01 ≤ test < 2026-09-01 ≤ demo, by billing date.
6. **Data and privacy:** `data/raw/`, `out/` and `.env` are never committed.

Keep it under ~90 lines. No result numbers (they belong to generated output), no names of people,
no badges, no emojis.

---

## When you finish (or stop)

Fill in the Progress log below: for each task, write **done / skipped / blocked**, the files you
changed, and the last lines of `npm run typecheck` and `npm test` output (the pass/fail summary).
List anything surprising under "Findings for the lead". Do not delete this file.

## Progress log

**Task 1: dates.ts fix**
- Status: done
- Changed files: `src/check/dates.ts`, `src/check/dates.test.ts`
- Last check output:
  - `npm run typecheck`: passed
  - `npm test`: 89 tests passed

**Task 2: tests for history helpers**
- Status: done
- Changed files: `src/check/history.test.ts`
- Last check output:
  - `npm run typecheck`: passed
  - `npm test`: 98 tests passed

**Task 3: tests for the table printer**
- Status: done
- Changed files: `src/report/format.test.ts`
- Last check output:
  - `npm run typecheck`: passed
  - `npm test`: 103 tests passed

**Task 4: rewrite README.md**
- Status: done
- Changed files: `README.md`
- Last check output:
  - `npm run typecheck`: passed
  - `npm test`: 103 tests passed

### Findings for the lead

- In Task 1, `npm run check` executed successfully (no "Missing CSVs" error) and correctly reported: `auto_approve 6,043 · jev 418 · human_review 0 · excluded 7`.
- No new failing tests against the code I was told not to change.
