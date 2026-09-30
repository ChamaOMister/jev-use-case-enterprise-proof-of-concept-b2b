/**
 * Phase 3: asks Jev the same_order question for one state, through a file cache so a repeated
 * state under the same requested model never calls (or pays for) the API again.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EntryType, SystemOneResult, TypeSafeClient, Usage } from "@typesafe-ai/sdk";
import { QUESTIONS } from "./questions.js";

export const DEFAULT_CACHE_DIR = "out/jev-cache";
export const DEFAULT_MODEL = "jev-latest";

/** What a cache file holds: the full API response plus the model that was requested. */
type CachedResponse = SystemOneResult<typeof QUESTIONS> & { model_requested: string };

export interface JevAnswer {
  p_same_order: number;
  model_requested: string;
  model_returned: string;
  usage: Usage;
  cached: boolean;
}

export interface AskerOptions {
  client: TypeSafeClient;
  model: string;
  cacheDir?: string;
}

/** sha256 of `{ model, state, questions }`, with the requested model. */
export function cacheKey(model: string, state: object): string {
  return createHash("sha256").update(JSON.stringify({ model, state, questions: QUESTIONS })).digest("hex");
}

/** Returns an `ask(state)` that calls Jev sequentially per await, reading and writing the cache. */
export function createAsker({ client, model, cacheDir = DEFAULT_CACHE_DIR }: AskerOptions): (state: object) => Promise<JevAnswer> {
  return async (state) => {
    const file = path.join(cacheDir, `${cacheKey(model, state)}.json`);
    let response: CachedResponse;
    let cached: boolean;
    if (existsSync(file)) {
      response = JSON.parse(readFileSync(file, "utf8")) as CachedResponse;
      cached = true;
    } else {
      const result = await client.systemOne({ state: state as EntryType, questions: QUESTIONS, model });
      response = { model_requested: model, model: result.model, answers: result.answers, usage: result.usage };
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(response, null, 2));
      cached = false;
    }
    return {
      p_same_order: response.answers.same_order.noul,
      model_requested: response.model_requested,
      model_returned: response.model,
      usage: response.usage,
      cached,
    };
  };
}
