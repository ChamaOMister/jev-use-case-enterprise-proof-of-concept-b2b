/** Phase 3: the one question Jev answers for each jev-routed invoice, and the routing on its answer. */
import { noul } from "@typesafe-ai/sdk";
import type { Route } from "../check/types.js";

export const QUESTIONS = {
  same_order: noul(
    "Is this invoice the same order as the customer's previous invoice (billed again in whole or in part, or one order split across the two invoices), rather than a separate new order?",
    {
      true: "Same order as the previous invoice: billed again, or split across both.",
      false: "A separate order the customer placed after the previous one.",
    },
  ),
};

/**
 * Tuned by Phase 4 (`npm run eval`, model jev-1.13.0): the largest threshold that flags every
 * planted partial rebill on `tune`. Splits of one order score low and auto-approve by design: they
 * bill each line once. Phase 1's rebilled_products now catches rebills of products already on the
 * previous invoice first; Jev at this threshold is the second opinion on the rest.
 */
export const DEFAULT_THRESHOLD = 0.39;

/** Below the threshold → auto_approve; at or above it → human_review. */
export function routeAfterJev(pSameOrder: number, threshold: number): Extract<Route, "auto_approve" | "human_review"> {
  return pSameOrder < threshold ? "auto_approve" : "human_review";
}
