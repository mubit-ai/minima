/**
 * Map a Minima RankedModel to a harness Model.
 *
 * Port of minima_harness/minima/mapping.py. Minima's routing catalogue and the harness
 * calling registry are kept separate: Minima is the source of truth for routing, the
 * harness registry for calling. A tolerant lookup (exact -> id-only -> provider/model
 * split -> fallback) resolves a recommendation to a callable model even when ids drift.
 */

import { providerKeyPresent } from "../ai/provider_catalog.ts";
import { allModels, findModelById, tryGetModel } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import type { ModelCard, RankedModel } from "./schemas.ts";

function fallbackCost(model: Model): number {
  const total = (model.cost.input ?? 0) + (model.cost.output ?? 0);
  // Treat an unpriced (0-cost) model as most-expensive so a local stub isn't the default.
  return total <= 0 ? Number.POSITIVE_INFINITY : total;
}

export class ModelMapping {
  /** Resolve Minima's pick to a callable harness model. */
  toModel(ranked: RankedModel, offlineDefault?: Model): Model {
    const model = this.resolve(ranked.provider, ranked.model_id);
    if (model) return model;
    if (offlineDefault) return offlineDefault;
    throw new Error(
      `no harness model for minima pick ${ranked.provider}/${ranked.model_id}; register it or pass an offlineDefault`,
    );
  }

  /** Offline fallback: the cheapest registered model the user can actually run. */
  defaultModel(): Model {
    const models = allModels();
    if (!models.length) throw new Error("harness model registry is empty");
    const byCost = [...models].sort(
      (a, b) => fallbackCost(a) - fallbackCost(b) || a.id.localeCompare(b.id),
    );
    for (const model of byCost) {
      if (providerKeyPresent(model.provider)) return model;
    }
    return byCost[0]!;
  }

  resolve(provider: string, modelId: string): Model | undefined {
    // 1. exact (provider, id)
    let model = tryGetModel(provider, modelId);
    if (model) return model;
    // 2. id-only (Minima's provider string may differ from ours)
    model = findModelById(modelId);
    if (model) return model;
    // 3. openrouter-style "provider/model" ids
    if (modelId.includes("/")) {
      const [prov, , mid] = partition(modelId, "/");
      model = tryGetModel(prov, modelId) ?? tryGetModel(prov, mid) ?? findModelById(mid);
      if (model) return model;
    }
    return undefined;
  }
}

function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, "", ""];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/**
 * Overlay Minima's authoritative live pricing onto the registered harness models.
 *
 * Offline-safe: any failure is swallowed and returns 0, leaving seeded prices in place.
 */
export function syncCatalog(
  client: { models: (opts?: { include_stale?: boolean }) => Promise<{ models: ModelCard[] }> },
  mapping = new ModelMapping(),
): Promise<number> {
  return doSync(client, mapping).catch(() => 0);
}

async function doSync(
  client: { models: (opts?: { include_stale?: boolean }) => Promise<{ models: ModelCard[] }> },
  mapping: ModelMapping,
): Promise<number> {
  const resp = await client.models({ include_stale: true });
  const cards = resp.models ?? [];
  let updated = 0;
  for (const card of cards) {
    const model = mapping.resolve(card.provider, card.model_id);
    if (!model) continue;
    model.cost = {
      input: card.input_cost_per_mtok,
      output: card.output_cost_per_mtok,
      cache_read: card.cache_read_cost_per_mtok ?? model.cost.cache_read,
      cache_write: model.cost.cache_write,
    };
    if (card.context_window) model.context_window = card.context_window;
    if (card.max_output_tokens) model.max_tokens = card.max_output_tokens;
    registerModelAgain(model);
    updated += 1;
  }
  return updated;
}

// Local import to avoid a cycle at module-eval time.
import { registerModel as registerModelAgain } from "../ai/registry.ts";
