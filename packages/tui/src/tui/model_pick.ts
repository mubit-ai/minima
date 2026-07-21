/**
 * Pin/unpin transitions for the model picker and /model — pure so they're testable.
 * The stash remembers the candidate pool the FIRST pin narrowed away; unpinning restores
 * routing over that pool instead of leaving `candidates` locked to [pinned-id] forever.
 */

import type { Model } from "../ai/types.ts";
import { DEFAULT_CANDIDATES, type HarnessConfig } from "../minima/config.ts";

export interface PinStash {
  pool: string[] | null;
}

export function applyPersistentPin(config: HarnessConfig, stash: PinStash, model: Model): void {
  if (!config.pinned) stash.pool = [...config.candidates];
  config.pinned = true;
  config.candidates = [model.id];
}

export function applyUnpin(config: HarnessConfig, stash: PinStash): void {
  config.pinned = false;
  config.candidates = stash.pool ?? [...DEFAULT_CANDIDATES];
  stash.pool = null;
}
