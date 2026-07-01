/**
 * Cost computation: realized tokens x per-model prices -> USD.
 *
 * Port of minima_harness/ai/usage.py. Keeping the realized-cost basis in the
 * harness (rather than echoing Minima's prior est_cost_usd) lets Minima climb
 * estimate -> observed -> rescaled, its single biggest accuracy lever.
 */

import type { Cost, Model } from "./types.ts";
import type { Usage } from "./types.ts";

// Registry prices are per-million tokens; divide token counts by 1e6.
const PER_MTOK = 1_000_000;

export function costFor(model: Model, usage: Usage): Cost {
  const inUsd = (usage.input * (model.cost.input ?? 0)) / PER_MTOK;
  const outUsd = (usage.output * (model.cost.output ?? 0)) / PER_MTOK;
  const cacheReadUsd = (usage.cache_read * (model.cost.cache_read ?? 0)) / PER_MTOK;
  const cacheWriteUsd = (usage.cache_write * (model.cost.cache_write ?? 0)) / PER_MTOK;
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
