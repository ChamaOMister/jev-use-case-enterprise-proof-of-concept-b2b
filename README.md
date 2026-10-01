# biomix-intake-triage

This project performs a three-tier invoice intake triage on synthetic Biomix data. Invoices pass through deterministic rules, then a Jev model, and finally human review if needed.

## Results

**[docs/report.html](docs/report.html)** is a self-contained results page, published with GitHub Pages: open the **Website** link under **About** on the repo page to view it in the browser (or download the file and open it locally; nothing needs to be installed). It shows where the 6,468 invoices went, what Jev was asked and how it scored, the planted-case evaluation, the review queue and the data audit.

## Setup

- **Requirements:** Node.js >= 20
- **Install:** Run `npm install`
- **Data:** Place the delivered CSVs in `data/raw/` (these are not included and are gitignored).
- **Environment:** `TYPESAFE_API_KEY` in `.env` is only needed for the Jev phase.

## Commands

- `npm run audit`: Runs the data audit and writes results to `out/audit.json`
- `npm run check`: Runs the deterministic rules phase and writes results to `out/check.json`
- `npm run features`: Computes each invoice's features from the customer's earlier invoices and writes results to `out/features.json`
- `npm run jev`: Asks Jev whether each jev-routed invoice is the same order as the customer's previous invoice and writes results to `out/jev.json` (`-- --dry-run` prints one state without calling the API)
- `npm run eval`: Builds planted cases with known answers (an order split, partly rebilled, or partly rebilled with changed quantities vs. a real later order moved next to the previous one), asks Jev about each, picks the threshold that catches the partial rebills on `tune`, reports it on `test` and writes `out/eval.json` (`-- --dry-run` shows the cases and a single-feature baseline without calling the API)
- `npm run report`: Builds `docs/report.html` from the JSON in `out/` (no API calls; run the phases above first)
- `npm test`: Runs the test suite with Vitest
- `npm run typecheck`: Runs TypeScript type checking

Note: `build:data` and `dev` are placeholders for later phases.

## Phase 1 Rules

| Rule ID | Description | Outcome |
|---------|-------------|---------|
| `line_arithmetic` | Every line: package_quantity >= 1, unit price > 0, line amount = quantity x unit price | flag |
| `invoice_total` | Invoice total = sum of line amounts; line_count = number of lines; lines numbered 1..n | flag |
| `commission` | Each line's commission = 5% rounded half up; invoice commission = sum of line commissions | flag |
| `price_list` | Unit price = the product's list price for the year (most common earlier price); a new year's first price must be +0% to +10% per year (compounded) above the last list price; a product's first-ever price passes with a note | flag / pass with note |
| `payment_schedule` | Known schedule; installment count and first due date match it; 30 days apart; amounts sum to the total, differ by <= 1 cent, leftover cents first | flag |
| `party_consistency` | Invoice seller and business unit match customer; lines and installments match header; products are valid | flag |
| `duplicate_lines` | Same products and quantities as an invoice of the same customer <= 7 days earlier | flag |
| `rebilled_products` | Billed <= 2 days after the same customer's previous invoice with only products already on it (a partial rebill; added after Phase 4) | flag |
| `near_duplicate_window` | Billed <= 2 days after the same customer's previous invoice (Jev decides) | ambiguous |

**Routing Order:**
1. **Excluded:** `times_sent > 1`
2. **Human Review:** any `flag`
3. **Jev:** any `ambiguous`
4. **Auto-approve:** otherwise

## Splits

By billing date:
- `tune`: < 2026-01-01
- `test`: >= 2026-01-01 and < 2026-09-01
- `demo`: >= 2026-09-01

## Data and Privacy

The `data/raw/`, `out/`, and `.env` files and directories contain potentially sensitive data or secrets and are never committed.
