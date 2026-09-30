import { compareInvoiceNumbers, History } from "./history.js";
import { RULES, type Rule } from "./rules.js";
import {
  OUTCOMES,
  ROUTES,
  SPLITS,
  type Catalog,
  type Invoice,
  type InvoiceBundle,
  type Outcome,
  type Route,
  type RuleResult,
  type Split,
} from "./types.js";

export interface InvoiceTriage {
  invoice_number: string;
  split: Split;
  route: Route;
  results: RuleResult[];
}

export interface SplitSummary {
  invoices: number;
  routes: Record<Route, number>;
  rules: Record<string, Record<Outcome, number>>;
}

/** Out of scope first, then any flag → human review, any ambiguity → Jev, otherwise auto-approve. */
export function routeFor(invoice: Invoice, results: readonly RuleResult[]): Route {
  if (invoice.times_sent > 1) return "excluded";
  if (results.some((r) => r.outcome === "flag")) return "human_review";
  if (results.some((r) => r.outcome === "ambiguous")) return "jev";
  return "auto_approve";
}

/**
 * Checks every invoice in invoice_number order. Each invoice is evaluated against the History of
 * the invoices before it and only then added to it, so no rule can see an invoice's future.
 */
export function triage(bundles: readonly InvoiceBundle[], catalog: Catalog, rules: readonly Rule[] = RULES): InvoiceTriage[] {
  const history = new History();
  const ordered = [...bundles].sort((a, b) => compareInvoiceNumbers(a.invoice.invoice_number, b.invoice.invoice_number));
  return ordered.map((bundle) => {
    const results = rules.map((rule) => ({ rule: rule.id, ...rule.evaluate(bundle, { catalog, history }) }));
    history.add(bundle);
    const { invoice_number, split } = bundle.invoice;
    return { invoice_number, split, route: routeFor(bundle.invoice, results), results };
  });
}

/** Counts routes and rule outcomes per split and overall. Rule counts include excluded invoices. */
export function summarize(
  triaged: readonly InvoiceTriage[],
  ruleIds: readonly string[] = RULES.map((r) => r.id),
): Record<Split | "all", SplitSummary> {
  const empty = (): SplitSummary => ({
    invoices: 0,
    routes: Object.fromEntries(ROUTES.map((r) => [r, 0])) as Record<Route, number>,
    rules: Object.fromEntries(ruleIds.map((id) => [id, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))])) as Record<
      string,
      Record<Outcome, number>
    >,
  });
  const summary = Object.fromEntries([...SPLITS, "all"].map((s) => [s, empty()])) as Record<Split | "all", SplitSummary>;

  for (const t of triaged) {
    for (const s of [summary[t.split], summary.all]) {
      s.invoices += 1;
      s.routes[t.route] += 1;
      for (const r of t.results) {
        const counts = (s.rules[r.rule] ??= Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>);
        counts[r.outcome] += 1;
      }
    }
  }
  return summary;
}
