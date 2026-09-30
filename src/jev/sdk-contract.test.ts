/**
 * Pins the @typesafe-ai/sdk contract this project relies on, verified against
 * docs.typesafe.ai and the installed index.d.mts. Uses an injected fetch: no key, no network, no cost.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { choice, noul, score, TypeSafeClient, TypeSafeError, VERSION } from "@typesafe-ai/sdk";

/** A response shaped exactly like the examples in docs.typesafe.ai/api. */
const DOCUMENTED_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    yes_no: { type: "noul", noul: 0.12 },
    level: {
      type: "score",
      score: 0.35,
      confidence: 0.61,
      legend: { "0": "low", "1": "mid", "2": "high" },
      probabilities: { "0": 0.7, "1": 0.25, "2": 0.05 },
    },
    pick: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.72 },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const QUESTIONS = {
  yes_no: noul("Is it yes?", { true: "It is yes", false: "It is no" }),
  level: score("How high?", ["low", "mid", "high"]),
  pick: choice("Which one?", { a: "Option a", b: null }),
};

function fakeClient() {
  const calls: { url: string; method: string | undefined; body: unknown; headers: Headers }[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(DOCUMENTED_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json", "x-typesafe-request-id": "req_123" },
      });
    },
  });
  return { client, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe("@typesafe-ai/sdk contract", () => {
  it("is the version the docs describe", () => {
    expect(VERSION).toBe("0.6.0");
  });

  it("helpers build the documented question objects (Score criteria is an ordered array since v0.6.0)", () => {
    expect(QUESTIONS.yes_no).toEqual({
      type: "noul",
      instructions: "Is it yes?",
      criteria: { true: "It is yes", false: "It is no" },
    });
    expect(QUESTIONS.level).toEqual({ type: "score", instructions: "How high?", criteria: ["low", "mid", "high"] });
    expect(QUESTIONS.pick).toEqual({ type: "choice", instructions: "Which one?", criteria: { a: "Option a", b: null } });
  });

  it("sends one POST /v1/systemone with state, all questions, the default model and a bearer key", async () => {
    const { client, calls } = fakeClient();
    const state = { invoice: { lines: 3 }, prior: null };
    await client.systemOne({ state, questions: QUESTIONS });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-key");
    expect(calls[0]!.body).toEqual({ state, questions: QUESTIONS, model: "jev-latest" });
  });

  it("returns typed answers: noul has no confidence; score and choice carry probabilities + confidence", async () => {
    const { client } = fakeClient();
    const { data, requestId } = await client.systemOne({ state: "x", questions: QUESTIONS }).withResponse();

    expect(requestId).toBe("req_123");
    expect(data.model).toBe("jev-1.13.0");
    expect(data.usage).toEqual({ input_tokens: 318, output_tokens: 34 });

    expect(data.answers.yes_no.noul).toBe(0.12);
    expect(data.answers.yes_no).not.toHaveProperty("confidence");

    expect(data.answers.level.score).toBe(0.35);
    expect(data.answers.level.confidence).toBe(0.61);
    expect(data.answers.level.probabilities["2"]).toBe(0.05);

    expect(data.answers.pick.choice).toBe("a");
    expect(data.answers.pick.probabilities.b).toBe(0.2);
    expect(data.answers.pick.confidence).toBe(0.72);
  });

  it("refuses to construct without an API key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(() => new TypeSafeClient()).toThrow(TypeSafeError);
  });
});
