import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAsker } from "./ask.js";
import { QUESTIONS } from "./questions.js";

const RESPONSE = {
  model: "jev-1.13.0",
  answers: { same_order: { type: "noul", noul: 0.12 } },
  usage: { input_tokens: 318, output_tokens: 34 },
};

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "jev-cache-test-"));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

function fakeAsker(model = "jev-latest") {
  const bodies: unknown[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { ask: createAsker({ client, cacheDir, model }), bodies };
}

describe("createAsker", () => {
  it("sends the state, the questions and the requested model as the request body", async () => {
    const { ask, bodies } = fakeAsker("jev-1.13.0");
    await ask({ a: 1 });
    expect(bodies).toEqual([{ state: { a: 1 }, questions: QUESTIONS, model: "jev-1.13.0" }]);
  });

  it("returns p_same_order, the returned model and the usage of a fresh call", async () => {
    const { ask } = fakeAsker();
    expect(await ask({ a: 1 })).toEqual({
      p_same_order: 0.12,
      model_requested: "jev-latest",
      model_returned: "jev-1.13.0",
      usage: { input_tokens: 318, output_tokens: 34 },
      cached: false,
    });
  });

  it("stores the full response in <sha256>.json in the cache dir", async () => {
    const { ask } = fakeAsker();
    await ask({ a: 1 });
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.parse(readFileSync(path.join(cacheDir, files[0]!), "utf8"))).toEqual({ model_requested: "jev-latest", ...RESPONSE });
  });

  it("answers a repeated state from the cache without calling fetch", async () => {
    const { ask, bodies } = fakeAsker();
    await ask({ a: 1 });
    const again = await ask({ a: 1 });
    expect(bodies).toHaveLength(1);
    expect(again.cached).toBe(true);
    expect(again.p_same_order).toBe(0.12);
  });

  it("makes a new call for a different state", async () => {
    const { ask, bodies } = fakeAsker();
    await ask({ a: 1 });
    await ask({ a: 2 });
    expect(bodies).toHaveLength(2);
  });

  it("makes a new call for the same state under a different requested model", async () => {
    const first = fakeAsker("jev-latest");
    await first.ask({ a: 1 });
    const second = fakeAsker("jev-1.13.0");
    await second.ask({ a: 1 });
    expect(second.bodies).toHaveLength(1);
  });
});
