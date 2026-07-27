/**
 * Cost computation: realized tokens x per-model prices -> USD.
 *
 * Port of the Python harness's ai/usage.py. Keeping the realized-cost basis in the
 * harness (rather than echoing Minima's prior est_cost_usd) lets Minima climb
 * estimate -> observed -> rescaled, its single biggest accuracy lever.
 */

import type { Cost, Model, ModelCost, ModelRates } from "./types.ts";
import type { Usage } from "./types.ts";

// Registry prices are per-million tokens; divide token counts by 1e6.
const PER_MTOK = 1_000_000;

/**
 * The rate card this call bills at. Providers that tier on prompt size (Gemini 2.5 Pro
 * above 200k) switch EVERY rate at the threshold, not just input. The boundary is
 * exclusive — Google prices "prompts <= 200k" at the base rate.
 */
export function ratesFor(cost: ModelCost, promptTokens: number): ModelRates {
  const tier = cost.long_context;
  return tier && promptTokens > tier.above_prompt_tokens ? tier : cost;
}

export function costFor(model: Model, usage: Usage): Cost {
  // The tier is chosen by PROMPT size. usage.input is the UNCACHED remainder, so add the
  // cached tokens back to recover the prompt the provider actually counted — otherwise a
  // heavily cached 300k prompt would bill at the short-prompt rate.
  const promptTokens = usage.input + usage.cache_read + usage.cache_write;
  const rates = ratesFor(model.cost, promptTokens);
  const inUsd = (usage.input * (rates.input ?? 0)) / PER_MTOK;
  const outUsd = (usage.output * (rates.output ?? 0)) / PER_MTOK;
  const cacheReadUsd = (usage.cache_read * (rates.cache_read ?? 0)) / PER_MTOK;
  const cacheWriteUsd = (usage.cache_write * (rates.cache_write ?? 0)) / PER_MTOK;
  const total = inUsd + outUsd + cacheReadUsd + cacheWriteUsd;
  return {
    input: inUsd,
    output: outUsd,
    cache_read: cacheReadUsd,
    cache_write: cacheWriteUsd,
    total,
  };
}

/** Populate `usage.cost` for `model` and return usage (mutates, matches the Python helper). */
export function attachCost(model: Model, usage: Usage): Usage {
  usage.cost = costFor(model, usage);
  return usage;
}
