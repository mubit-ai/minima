/**
 * Harness model registry — the calling-side catalogue (distinct from Minima's routing
 * catalogue). A lean port of the Python harness's ai/registry.py: providers/the runtime seed
 * callable models here; the Minima integration layer (mapping.ts) resolves Minima's
 * ranked pick to a registered model.
 */

import type { Model } from "./types.ts";

const REGISTRY = new Map<string, Model>();

/** Registry key is `${provider}:${id}` so the same id under two providers is distinct. */
function key(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export function registerModel(model: Model): Model {
  REGISTRY.set(key(model.provider, model.id), model);
  return model;
}

export function registerModels(models: Model[]): void {
  for (const m of models) registerModel(m);
}

export function tryGetModel(provider: string, id: string): Model | undefined {
  return REGISTRY.get(key(provider, id));
}

export function findModelById(id: string): Model | undefined {
  for (const m of REGISTRY.values()) {
    if (m.id === id) return m;
  }
  return undefined;
}

export function allModels(): Model[] {
  return [...REGISTRY.values()];
}

/** Test-only: clear the registry. */
export function resetModelRegistry(): void {
  REGISTRY.clear();
}
