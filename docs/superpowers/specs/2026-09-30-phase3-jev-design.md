# Phase 3 — Jev tier (design)

Status: approved by the user on 2026-09-30. Code in `src/jev/`; no Phase 1 or Phase 2 edits.

## Goal

For each of the 418 invoices that Phase 1 routes to `jev` (billed ≤ 2 days after the same
customer's previous invoice), ask Jev whether it is the same order as that previous invoice,
and route it on the answer.

## Question (one `noul`)

- Instructions: "Is this invoice the same order as the customer's previous invoice (billed again
  in whole or in part, or one order split across the two invoices), rather than a separate new order?"
- Yes means: "Same order as the previous invoice: billed again, or split across both."
- No means: "A separate order the customer placed after the previous one."

The answer `p_same_order` is Jev's probability of "yes" (0..1).

## Routing after Jev

`p_same_order < threshold` → `auto_approve`; otherwise → `human_review` (p = threshold goes to
human_review). The threshold was provisional (0.5, a `--threshold` flag); Phase 4 tuned it to
0.39 on `tune` (see the Phase 4 spec's outcome), reports on `test` and leaves `demo` untouched.
After Phase 4, Phase 1's `rebilled_products` sends 14 of the 418 to human review first, so Jev now sees 404.

## State (pure function in `src/jev/state.ts`)

- `current` and `previous`: billing_date, payment_schedule, total_cents, from_pending_delivery,
  and lines (product_name, product_category, package_quantity, unit_price_cents, line_amount_cents).
- `comparison`: gap_days, shared_products, product_jaccard, shared_same_qty, total_ratio,
  same_payment_schedule, union_matches_past_basket (from Phase 2 features).
- `customer_history`: prior_invoice_count, tenure_days, median_gap_days, prior_short_gap_share,
  invoices_last_7_days, total_vs_median, new_products (from Phase 2 features).
- Never included: customer/seller/invoice ids, customer names or cities, the customers.* summary
  columns, or anything from later invoices.

`from_pending_delivery` is read from `invoices` by a small query in `src/jev/` (via `openRawDb`'s
Db), not by changing the Phase 1 loader. It is on the invoice header, so it is known when the invoice arrives.

## Calling Jev (`src/jev/ask.ts`)

- `TypeSafeClient` from `@typesafe-ai/sdk`, with an injectable `fetch` for tests.
- Cache: `out/jev-cache/<sha256>.json`, keyed by sha256 of `{ model, state, questions }` (the
  requested model). A cache hit never calls the API. Store the full response (model, answers, usage).
- Model: `--model`, default `jev-latest`. Record both the requested and the returned model name;
  once the pilot shows the resolved version, the user pins it with `--model`.
- Sequential calls, with the SDK's retries.

## CLI (`src/jev/run.ts`, `npm run jev`)

`loadBundles` → `triage` → `buildFeatures` → the jev invoices → state → ask → route.
Flags: `--raw-dir`, `--out` (default out/jev.json), `--model`, `--threshold`, `--split`, `--limit`,
`--dry-run` (prints the state for the first selected invoice; no API key needed, no network).
It loads `.env` with `process.loadEnvFile` only for a non-dry run and only if the file exists; it
never prints the environment. It prints per split and "all": invoices, median p, count at or
above the threshold, cache hits, and input/output tokens. It writes `{ generated_at, raw_dir,
model_requested, models_returned, question, threshold, invoices: [{ invoice_number, split,
p_same_order, route_after_jev, cached }] }`.

## Tests (no network, no data/raw)

- state: fields per section; no id-like keys anywhere; previous invoice's lines are included.
- ask: a cache hit makes no fetch; a different state makes a new call; request body = state + questions + model.
- routing: below the threshold → auto_approve; equal to it → human_review.

## Rollout

Dry run → a pilot of about 20 `tune` invoices → all 418. Each paid step needs the user's go-ahead.

## Phase 4 (for context; not built here)

Planted cases with known answers, built from real invoices: one order split into two invoices a
day apart (label: same order), and a genuinely different later order moved next to the previous
one (label: new order). Used to tune the threshold on `tune` and measure it on `test`.
