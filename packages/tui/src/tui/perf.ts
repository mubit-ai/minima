/**
 * Opt-in perf probe: set MINIMA_TUI_PERF=<file> and the TUI appends JSONL samples (buffered,
 * flushed once per second) so PTY soak tests can assert that per-render window compute stays
 * bounded as sessions grow and that stdin listener counts don't creep. Zero work when unset.
 */

import { appendFileSync } from "node:fs";

const target = process.env.MINIMA_TUI_PERF?.trim() || null;
let buf: string[] = [];
let flusher: ReturnType<typeof setInterval> | null = null;

export const perfEnabled = target !== null;

// Subprocess counter: with the probe on, Bun.spawnSync is wrapped so soak tests can assert
// that rendering/scrolling forks NOTHING (a useRef(detectRepo(...)) argument once forked git
// on every render — the freeze/title-flap bug). null = wrap unavailable; the verify script
// treats a missing count as a failure rather than silently passing.
let spawns = 0;
let spawnsTracked = false;
if (perfEnabled) {
  try {
    const orig = Bun.spawnSync.bind(Bun);
    Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
      spawns++;
      return orig(...args);
    }) as typeof Bun.spawnSync;
    spawnsTracked = true;
  } catch {
    // Bun.spawnSync not writable in this runtime — counter stays off.
  }
}

export function perfSpawns(): number | null {
  return spawnsTracked ? spawns : null;
}

export function perfSample(sample: Record<string, unknown>): void {
  if (!target) return;
  buf.push(JSON.stringify({ t: Date.now(), ...sample }));
  if (flusher === null) {
    flusher = setInterval(() => {
      if (buf.length === 0) return;
      const out = `${buf.join("\n")}\n`;
      buf = [];
      try {
        appendFileSync(target, out);
      } catch {
        // The probe must never break the TUI (read-only target, deleted dir, ...).
      }
    }, 1000);
    flusher.unref?.();
  }
}
