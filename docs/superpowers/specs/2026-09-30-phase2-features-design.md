# Phase 2 — Features for Jev (design)

Status: approved by the user; implementation in `src/features/`.

## Goal

For each invoice, compute the features Jev will receive in Phase 3, when it decides whether a
`jev` invoice is a duplicate/split of the customer's previous invoice or a genuine follow-up order.

## Approach

Walk the invoices in invoice_number order (as `triage()` does). Each invoice's features come only
from the same customer's earlier invoices; the invoice is then appended to that customer's past.
The customers.* summary columns (whole-period aggregates) are never used.

## Files

- `src/features/features.ts`: `Features`, `FEATURES` (id + description, like `RULES`), and the pure
  `featuresFor(current, past)`, where `past` is the same customer's earlier bundles, oldest first.
- `src/features/build.ts`: `buildFeatures(bundles)` sorts a copy with `compareInvoiceNumbers`, keeps
  a Map customer → past bundles, computes and then appends, and returns
  `{ invoice_number, features }[]` in invoice_number order. Throws on a duplicate invoice_number.
- `src/features/run.ts`: CLI (`--raw-dir`, `--out` = out/features.json): `loadBundles` → `triage`
  (route + split) → `buildFeatures`. Prints, per split and "all", for jev invoices only: invoices,
  median product_jaccard, share with union_matches_past_basket, median prior_short_gap_share,
  median total_ratio. Writes `{ generated_at, raw_dir, features, invoices: [{ invoice_number,
  split, route, features }] }` for all invoices.
- `package.json`: `"features": "tsx src/features/run.ts"`; README gets one Commands line.

## Definitions

"prev" = last bundle in `past`. "Product set" = distinct product_ids. Quantities are summed per
product across lines. Dates use `daysBetween`. Short gap = ≤ `NEAR_DUPLICATE_DAYS`. Any feature
that needs a prev, a past or a nonzero denominator is `null` without one.

| feature | definition |
|---|---|
| prev_invoice_number | prev's invoice_number |
| gap_days | days from prev.billing_date to current.billing_date |
| shared_products | \|products(current) ∩ products(prev)\| |
| product_jaccard | \|∩\| / \|∪\| of the two product sets |
| shared_same_qty | shared products whose summed quantity is equal on both |
| total_ratio | current total / prev total |
| same_payment_schedule | payment_schedule equal to prev's |
| union_matches_past_basket | products(current) ∪ products(prev) equals the product set of some past invoice other than prev |
| prior_invoice_count | past.length (never null) |
| tenure_days | days from past[0] to current |
| median_gap_days | median gap between consecutive past invoices (needs ≥ 2 past) |
| prior_short_gap_share | share of those gaps that are short (needs ≥ 2 past) |
| invoices_last_7_days | past invoices with daysBetween(p, current) ≤ 7 (never null) |
| total_vs_median | current total / median of past totals |
| new_products | products on current that appear on no past invoice (never null) |
| line_count, invoice_total_cents, payment_schedule | copied from the invoice |

Median of an even-length list = mean of the two middle values. Ratios, shares and Jaccard are
rounded to 4 decimals so the JSON is stable.

## Tests

- `features.test.ts`: each feature, its null case, rounding, even-length median.
- `build.test.ts`: truncation (buildFeatures(first k) = first k of buildFeatures(all), for every
  k, ≥ 8 invoices over 2 customers) — the proof no feature sees the future; shuffled input gives
  identical output; other customers never matter; a duplicate invoice_number throws.

## Sanity check on real data

jev invoices in "all" = 418; every one has gap_days ≤ 2 and a non-null prev_invoice_number.
