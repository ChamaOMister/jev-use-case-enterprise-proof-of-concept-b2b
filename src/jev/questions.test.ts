import { describe, expect, it } from "vitest";
import { QUESTIONS, routeAfterJev } from "./questions.js";

describe("QUESTIONS", () => {
  it("asks one noul question, same_order, with the approved wording", () => {
    expect(QUESTIONS).toEqual({
      same_order: {
        type: "noul",
        instructions:
          "Is this invoice the same order as the customer's previous invoice (billed again in whole or in part, or one order split across the two invoices), rather than a separate new order?",
        criteria: {
          true: "Same order as the previous invoice: billed again, or split across both.",
          false: "A separate order the customer placed after the previous one.",
        },
      },
    });
  });
});

describe("routeAfterJev", () => {
  it("auto-approves when p_same_order is below the threshold", () => {
    expect(routeAfterJev(0.49, 0.5)).toBe("auto_approve");
  });

  it("sends p_same_order equal to the threshold to human_review", () => {
    expect(routeAfterJev(0.5, 0.5)).toBe("human_review");
  });

  it("sends p_same_order above the threshold to human_review", () => {
    expect(routeAfterJev(0.9, 0.5)).toBe("human_review");
  });
});
