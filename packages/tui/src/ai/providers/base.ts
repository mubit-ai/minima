/**
 * Provider interface and the provider registry.
 *
 * Port of minima_harness/ai/providers/base.py. A provider owns the stream()
 * implementation for one `api` id (e.g. "anthropic-messages"). Real providers
 * register themselves; the faux provider registers on demand for hermetic tests.
 */

import type { StreamEvent } from "../events.ts";
import type { Context, Model } from "../types.ts";

/** A streaming provider bound to one Model.api id. */
export interface Provider {
  readonly apiId: string;
  stream(
    model: Model,
    context: Context,
    opts?: { options?: Record<string, unknown>; signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
}

// api id -> provider instance. Instances are reused; the faux provider exposes
// per-test handles rather than mutating this singleton.
const REGISTRY = new Map<string, Provider>();

export function registerProvider(api: string, provider: Provider): void {
  REGISTRY.set(api, provider);
}

export function unregisterProvider(api: string): void {
  REGISTRY.delete(api);
}

export function getProvider(api: string): Provider {
  const p = REGISTRY.get(api);
  if (!p) {
    const available = [...REGISTRY.keys()].sort().join(", ") || "<none>";
    throw new Error(`no provider registered for api '${api}' (available: ${available})`);
  }
  return p;
}

export function registeredApis(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** Test-only: clear the registry between hermetic tests. */
export function resetRegistry(): void {
  REGISTRY.clear();
}
