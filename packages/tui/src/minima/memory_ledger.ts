/**
 * Memory ledger projection (B1) — the read path of the harness's curated cross-session
 * memory. State lives in SQLite (`memories`, written only by the harness/user — the model
 * has no memory-write tool); the model sees a compact ranked projection appended to each
 * turn's system prompt, hard-capped so memory can never crowd out the task (the
 * load-everything approach is the known anti-pattern). Rank: pinned > gate-cited >
 * recency. Which rows were shown is recorded as an `inject` memory_event per distinct set
 * (runtime.ts), so "what the model saw" is replayable from the ledger.
 */

import type { MemoryRow, MinimaDb } from "../db/minima_db.ts";

/** Hard cap on the projected block. MINIMA_TUI_MEMORY_CAP overrides (chars, not tokens —
 * the harness has no tokenizer; ~4 chars/token makes this ≈1k tokens). */
export const MEMORY_PROJECTION_CAP_CHARS = 4000;

export interface MemoryProjection {
  text: string;
  /** Row ids actually included, in render order — the replayable "what the model saw". */
  ids: string[];
  /** Live rows that ranked below the cap and were dropped. */
  dropped: number;
}

export function memoryProjectionCap(): number {
  const env = process.env.MINIMA_TUI_MEMORY_CAP;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return MEMORY_PROJECTION_CAP_CHARS;
}

/** pinned first, then gate-cited, then recency — provenance outranks freshness. */
function rankMemories(rows: MemoryRow[]): MemoryRow[] {
  const tier = (m: MemoryRow) => (m.status === "pinned" ? 0 : m.evidence_source === "gate" ? 1 : 2);
  return [...rows].sort((a, b) => tier(a) - tier(b) || b.updated - a.updated);
}

function renderMemory(m: MemoryRow): string {
  const trigger = m.trigger ? ` (when: ${m.trigger})` : "";
  return `- [${m.kind}] ${m.content.trim()}${trigger}`;
}

const HEADER = [
  "# Memory (curated notes from past sessions in this repo — manage with /memory)",
  "Prior context, possibly stale: verify against the current code before relying on an entry.",
].join("\n");

/**
 * Build the capped projection from the project's active + pinned live rows. Whole entries
 * only — an entry that would cross the cap is dropped, never truncated mid-thought.
 * Returns null when nothing is active (the common cold-start case: zero overhead).
 */
export function buildMemoryProjection(
  db: MinimaDb,
  projectKey: string,
  capChars: number = memoryProjectionCap(),
): MemoryProjection | null {
  const rows = rankMemories(db.listMemories(projectKey, { statuses: ["active", "pinned"] }));
  if (rows.length === 0) return null;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = HEADER.length;
  let dropped = 0;
  for (const m of rows) {
    const line = renderMemory(m);
    if (used + line.length + 1 > capChars && ids.length > 0) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    ids.push(m.id);
    used += line.length + 1;
  }
  if (ids.length === 0) return null;
  const tail = dropped > 0 ? `\n(${dropped} more not shown — /memory list)` : "";
  return { text: `${HEADER}\n${lines.join("\n")}${tail}`, ids, dropped };
}

/** Convenience for runtime.ts: resolve the run's project and project its memory. */
export function memoryProjectionFor(
  db: MinimaDb | null,
  runId: string | null,
): MemoryProjection | null {
  if (!db || !runId) return null;
  const run = db.getRun(runId);
  if (!run) return null;
  return buildMemoryProjection(db, run.project_key);
}
