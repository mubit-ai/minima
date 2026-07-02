/**
 * Populate the harness model registry from live catalogs so the /model picker reflects the
 * models you can actually run — not just the 8 hardcoded seeds.
 *
 * Two sources, both key-gated (only register models whose provider key is present, so the
 * picker never offers a model that would fail with an auth error):
 *   - Minima `/v1/models` — the server's curated, priced catalog (any provider).
 *   - OpenRouter `/api/v1/models` — the full dynamic catalog when OPENROUTER_API_KEY is set.
 *
 * Fail-open: any network/parse error leaves the seeded registry untouched.
 */

import { PROVIDERS, providerKeyPresent } from "../ai/provider_catalog.ts";
import { registerModel, tryGetModel } from "../ai/registry.ts";
import type { ApiId, Model } from "../ai/types.ts";
import { MinimaClient } from "./client.ts";
import type { HarnessConfig } from "./config.ts";
import type { ModelCard } from "./schemas.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const BY_NAME = new Map(PROVIDERS.map((p) => [p.name, p]));

/** Map a provider name to its calling api + base_url (openai-compatible by default). */
function apiFor(provider: string): { api: ApiId; baseUrl?: string } {
  if (provider === "anthropic") return { api: "anthropic-messages" };
  if (provider === "google") return { api: "google-generative-ai" };
  return { api: "openai-completions", baseUrl: BY_NAME.get(provider)?.baseUrl };
}

function synthModel(card: ModelCard): Model {
  const { api, baseUrl } = apiFor(card.provider);
  const reasoning =
    (card.capability_priors?.reasoning ?? card.capability_priors?.reason ?? 0) >= 0.5;
  return {
    id: card.model_id,
    provider: card.provider,
    api,
    name: card.display_name || card.model_id,
    cost: {
      input: card.input_cost_per_mtok,
      output: card.output_cost_per_mtok,
      cache_read: card.cache_read_cost_per_mtok ?? 0,
      cache_write: 0,
    },
    context_window: card.context_window ?? 128_000,
    max_tokens: card.max_output_tokens ?? 8_192,
    reasoning,
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };
}

/** Register runnable models from Minima's /v1/models catalog. Returns the count added. */
export async function populateFromMinima(client: {
  models: (opts?: { include_stale?: boolean }) => Promise<{ models: ModelCard[] }>;
}): Promise<number> {
  let added = 0;
  const resp = await client.models({ include_stale: true });
  for (const card of resp.models ?? []) {
    if (!providerKeyPresent(card.provider)) continue; // only offer models we can actually run
    if (tryGetModel(card.provider, card.model_id)) continue; // seed/existing wins; mapping overlays prices
    registerModel(synthModel(card));
    added += 1;
  }
  return added;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  top_provider?: { max_completion_tokens?: number };
}

/** Register the full OpenRouter catalog when OPENROUTER_API_KEY is set. Returns count added. */
export async function populateFromOpenRouter(fetchImpl: typeof fetch = fetch): Promise<number> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return 0;
  const resp = await fetchImpl(`${OPENROUTER_BASE}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!resp.ok) return 0;
  const body = (await resp.json()) as { data?: OpenRouterModel[] };
  let added = 0;
  for (const m of body.data ?? []) {
    if (!m.id || tryGetModel("openrouter", m.id)) continue;
    // OpenRouter prices are USD per token (string); the registry stores $/Mtok.
    const perM = (v: string | number | undefined) => (Number(v) || 0) * 1e6;
    registerModel({
      id: m.id,
      provider: "openrouter",
      api: "openai-completions",
      name: m.name || m.id,
      cost: {
        input: perM(m.pricing?.prompt),
        output: perM(m.pricing?.completion),
        cache_read: 0,
        cache_write: 0,
      },
      context_window: m.context_length ?? 128_000,
      max_tokens: m.top_provider?.max_completion_tokens ?? 8_192,
      base_url: OPENROUTER_BASE,
    });
    added += 1;
  }
  return added;
}

/**
 * Refresh the registry from every available catalog. Fail-open per source. Safe to call at
 * startup and on /reconnect. Returns total models added.
 */
export async function refreshCatalog(
  config: HarnessConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let added = 0;
  if (config.minimaUrl && config.minimaApiKey) {
    const client = new MinimaClient({
      baseUrl: config.minimaUrl,
      apiKey: config.minimaApiKey,
      timeoutMs: config.timeout * 1000,
    });
    added += await populateFromMinima(client).catch(() => 0);
  }
  added += await populateFromOpenRouter(fetchImpl).catch(() => 0);
  return added;
}

let bootstrapPromise: Promise<number> | null = null;

/**
 * One-time catalog bootstrap: the first call runs refreshCatalog; every later (or
 * concurrent) call returns the same promise. The model REGISTRY is process-global and the
 * mapping layer mutates model cost in place, so an uncoordinated mid-run re-sync races any
 * concurrently-running (sub-)agents — bootstrap once, then only refresh on an explicit
 * user action (/reconnect) when no run is in flight.
 */
export function refreshCatalogOnce(
  config: HarnessConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!bootstrapPromise) bootstrapPromise = refreshCatalog(config, fetchImpl);
  return bootstrapPromise;
}

/** Test seam: forget the bootstrap memo. */
export function resetCatalogBootstrap(): void {
  bootstrapPromise = null;
}
