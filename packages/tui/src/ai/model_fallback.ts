/**
 * Runnable-model resolution for meta calls (judge, classifier).
 *
 * The configured model wins whenever it resolves AND its provider key is present;
 * otherwise walk a small cheap-model preference ladder and pick the first runnable
 * entry. Without this, a user with only (say) a Gemini key silently loses the whole
 * feature the model powers — the default claude-haiku-4-5 judge never grades.
 */

import { providerKeyPresent } from "./provider_catalog.ts";
import { findModelById } from "./registry.ts";
import type { Model } from "./types.ts";

/** Cheap-model preference ladder (ids must exist in the seed registry — cli/main.ts). */
export const CHEAP_FALLBACK_MODELS: readonly string[] = [
  "claude-haiku-4-5",
  "gemini-2.5-flash",
  "gpt-4o-mini",
];

export interface ResolvedRunnableModel {
  model: Model;
  /** True when the preferred model was not runnable and a fallback was substituted. */
  substituted: boolean;
}

/** First runnable model: the preferred id, else the fallback ladder. Null when none. */
export function resolveRunnableModel(
  preferredId: string,
  fallbacks: readonly string[] = CHEAP_FALLBACK_MODELS,
): ResolvedRunnableModel | null {
  const preferred = findModelById(preferredId);
  if (preferred && providerKeyPresent(preferred.provider)) {
    return { model: preferred, substituted: false };
  }
  for (const id of fallbacks) {
    if (id === preferredId) continue;
    const m = findModelById(id);
    if (m && providerKeyPresent(m.provider)) return { model: m, substituted: true };
  }
  return null;
}
