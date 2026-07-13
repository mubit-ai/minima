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
