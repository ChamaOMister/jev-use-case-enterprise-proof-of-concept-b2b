# Phase 4 — planted-case eval (design)

Status: written on 2026-09-30 under the user's standing go-ahead ("best judgement, no spec
approval"). Code in `src/eval/`. Outside it: the `eval` script, README, and Phase 3's
`loadFromPendingDelivery` moved unchanged from `src/jev/run.ts` into `src/jev/pending.ts` so both CLIs share it.

## Goal

The data has no ground truth for "same order". Phase 4 builds **planted cases** with known answers
from real, clean invoices, asks Jev about each one exactly as Phase 3 does, and then:

1. picks the routing threshold on `tune` planted cases,
2. reports how well that threshold does on `test` planted cases,
3. shows how many real jev-routed `tune`/`test` invoices it would send to human review.

`demo` is left alone: no planted cases come from it, and it is left out of every report.

## Planted cases

Each case is a pair (previous invoice, current invoice) of one real customer, plus that customer's
real invoices before the pair as history. The current invoice is billed `g` days after the previous
one. Per split, one list of `per-label` gaps is drawn from the gap distribution of the real
jev-routed `tune` invoices, and the k-th case of each label uses the k-th gap. Both labels get the
same gaps, so the gap can't give away the label. Every source invoice is `auto_approve` in Phase 1 (clean), and each
real invoice is a source for at most one case.

| kind | label | how it is built |
|------|-------|-----------------|
| `split` | same_order | A real invoice X (≥ 2 lines) has its lines split at random into two non-empty groups: previous = the first group on X's date, current = the rest `g` days later. |
| `rebill` | same_order | previous = X unchanged; current = a random non-empty **strict** subset of X's lines, `g` days later (a partial rebill; an exact rebill is already flagged by `duplicate_lines`). |
| `moved` | new_order | Two consecutive real invoices P → N of one customer (a real later order); N is moved to `g` days after P. |

Rules that keep the cases realistic and free of label hints:

- A built invoice copies its source's header (schedule, `from_pending_delivery`) and lines; line
  numbers, totals and line billing dates are recomputed. Prices are never changed.
- The source invoices and both invoices of the pair (at their final dates) are in one split and
  one calendar year, so a yearly price change can't hint that the invoices are far apart. The
  case's split is that split.
- A case is dropped if `duplicate_lines` would flag the current invoice (same products and
  quantities as one of the customer's invoices ≤ 7 days earlier); only jev-routable cases count.
- A moved pair where N repeats P's lines is dropped by this same check.
- State = Phase 3's `stateFor`, with features from Phase 2's `featuresFor(current, [...history, previous])`.
- Deterministic: a seeded PRNG (`--seed`, default 1). Same seed → same cases → Jev cache hits.

Size: `--per-label N` per split (default 60): N `moved` and N same_order (⌈N/2⌉ `split` + ⌊N/2⌋
`rebill`). Default total 240 calls ≈ 265k input tokens (about 56% of the Phase 3 full run).

## Metrics (`src/eval/metrics.ts`, pure)

Positive = same_order; flagged = `p_same_order ≥ threshold` (Phase 3's `routeAfterJev` → human_review).

- **recall** = same_order cases flagged; **false-alarm rate** = new_order cases flagged. Both with
  Wilson 95% intervals. Recall is also shown per kind.
- **AUC** (ties count ½): how well p separates the labels regardless of threshold.
- **Threshold choice (tune only):** the largest t with tune recall ≥ `--target-recall` (default
  0.9) — the fewest human reviews that still catch 90% of same-order cases. Missing a double bill
  costs more than a human look. The candidates are the tune p values.
- **Leakage check (free, dry-run too):** the AUC of each `comparison` feature on the planted cases.
  If one feature alone separates the labels almost perfectly, the planted cases are too easy and
  the Jev numbers don't mean much.
- **Real load:** with the chosen threshold, the real jev-routed `tune`/`test` invoices at or above it,
  read from `--jev-results` (default out/jev.json; skipped with a note if it is missing, and a
  warning if its model differs).

## CLI (`src/eval/run.ts`, `npm run eval`)

Flags: `--raw-dir`, `--out` (default out/eval.json), `--model` (default `jev-latest`; run with
`jev-1.13.0`), `--per-label`, `--seed`, `--target-recall`, `--jev-results`, `--dry-run`.

`--dry-run` builds the cases and prints the counts per split × kind, the feature AUCs and one state;
no API key, no network. A real run asks Jev through Phase 3's `createAsker` (same cache) and
prints: the chosen threshold; per split recall, false-alarm rate, AUC and per-kind recall; feature
AUCs; the real load. It writes `{ generated_at, raw_dir, model_requested, models_returned, seed,
per_label, target_recall, threshold, metrics, feature_auc, real_load, cases: [{ case_id, kind,
label, split, source_invoices, gap_days, p_same_order, cached }] }`.

## Files

- `src/eval/plant.ts` — `plantCases(...)` and the seeded PRNG. Pure; takes bundles and Phase 1 routes.
- `src/eval/metrics.ts` — `auc`, `wilson`, `confusionAt`, `chooseThreshold`.
- `src/eval/run.ts` — CLI. `package.json` `eval` script; README line.

## Tests (no network, no data/raw)

- plant: labels per kind; split halves partition X's lines, both non-empty, totals = Σ lines;
  rebill is a strict subset; moved keeps N's lines and has P as previous; the gap comes from the
  given distribution; same split and year; no demo; no source reused; duplicate signatures dropped;
  same seed → same cases; the states have no id-like keys.
- metrics: AUC on known examples (perfect, inverted, ties); Wilson on known values; threshold is
  the largest that meets the target; `p = t` counts as flagged.

## Rollout

Dry run (free: counts and the leakage check) → one paid run of 240 calls with `--model jev-1.13.0`,
**only after the user's go-ahead** → the user decides whether to make the chosen threshold
Phase 3's `DEFAULT_THRESHOLD`.

## Out of scope

`build:data` (the UI's results file) belongs to Phase 5. No prompt or question changes: if Jev
can't separate the labels, this phase reports that and doesn't try to fix it.

## Outcome (2026-09-30, model jev-1.13.0, seed 1)

First run, with every same_order kind as a positive: AUC 0.62 on tune and 0.59 on test. For 90% recall the
threshold fell to 0.06, which would send 404 of the 411 real invoices to human review. Jev separates
**rebills** from new orders almost perfectly (AUC ≈ 1.0, median p ≈ 0.5) but scores **splits** lower
than new orders (median p 0.07; split vs moved AUC 0.18–0.24): it reads "same order" as "lines overlap".

Decision (user, option 1): only partial rebills must reach human review. They bill twice; a split
bills each line once. `--flag-kinds` (default `rebill`) sets the positives; splits and moved orders
are negatives. The question text is unchanged, so every cached answer stays valid. Re-run from the
cache with the rule fixed beforehand (largest threshold flagging ≥ 90% of tune rebills):

| | threshold | rebill recall | false alarms | real jev invoices to human review |
|---|---|---|---|---|
| tune | 0.44 | 0.90 (0.74–0.97) | 0 of 90 | 0 of 340 |
| test | 0.44 | 0.83 (0.66–0.93) | 0 of 90 | 0 of 71 |

With `--target-recall 1` the threshold is 0.39: every tune and test rebill is caught, false alarms are 0 on tune and
2.2% on test, and 8 of the 411 real invoices go to review. The user chose 0.39, which is now `DEFAULT_THRESHOLD`
and the eval default (`--target-recall 1`).

### Probe: rebills with changed quantities

The exact-quantity feature `shared_same_qty` alone matched Jev on rebills (AUC 0.997 on tune, 0.988 on test), and
the planted rebills repeat quantities exactly by construction. The probe kind `rebill_changed` (30 per split,
`--changed-per-split`) re-bills some of an invoice's lines with every quantity changed. It is built last, from its
own PRNG, so the other 240 cases and their cached answers are unchanged (60 new calls, 57,968 input tokens). It
stays out of the threshold metrics unless it is listed in `--flag-kinds`; its results are reported per kind.

| vs moved (AUC) | Jev | shared_same_qty | product_jaccard | total_ratio |
|---|---|---|---|---|
| rebill_changed, tune | 0.973 | 0.492 | 0.961 | 0.049 |
| rebill_changed, test | 0.929 | 0.467 | 0.938 | 0.046 |

Jev ranks changed rebills well but gives them lower p (median 0.35 tune, 0.33 test), so at 0.39 it catches only
40% on tune and 23% on test. To catch about 90% it needs t ≈ 0.25, and then 7% of new orders on tune (17% on test)
go to review.

Rule "every product on the current invoice was on the previous one" (`shared_products` = the current invoice's
distinct products), on the same cases: 100% of rebills and changed rebills caught, 0% of splits, 2% of moved
orders flagged; on real data it flags 11 of 340 tune and 3 of 71 test invoices. The planted rebills are product
subsets by construction, which favours this rule the same way the first set favoured `shared_same_qty`.

### Decision: the rule goes into Phase 1

The rule is now the Phase 1 rule `rebilled_products` (flag → human_review), evaluated before Jev: an invoice ≤ 2 days
after the customer's previous invoice whose distinct products were all on it. Phase 1 on real data: jev 404,
human_review 14 (11 tune, 3 test, 0 demo), auto_approve and excluded unchanged. Jev stays behind the rule at 0.39 as a
second opinion on invoices that add a product.

The eval keeps scoring Jev on every planted case (so the threshold and its cached answers are unchanged) and now also
reports the rule's share per kind and the whole pipeline (rule or Jev ≥ 0.39). Planted gaps come from every
near-duplicate-window tune invoice, the same 340 as before the rule. Re-run fully from cache (0 new calls):

| pipeline share sent to human review | split | rebill | rebill_changed | moved |
|---|---|---|---|---|
| tune | 0% | 100% | 100% | 1.7% |
| test | 0% | 100% | 100% | 3.3% |

Real tune/test invoices to human review: 14 by the rule plus 6 by Jev (5 tune, 1 test) = 20 of 411. Demo: Jev flags 1
of 7. The planted rebills never add a product, so this set cannot measure how well Jev catches rebills that do; the
rule cannot catch those.
