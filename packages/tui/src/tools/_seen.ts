/**
 * Seen-lines ledger (P3 edit guard) — which lines of which file, at which content hash,
 * this session has actually seen. State lives in SQLite behind the structural SeenIndex
 * seam (this module never imports MinimaDb); tool output carries only the [snap:…]
 * projection. Fail-open by construction: any index error flips the ledger off for the
 * rest of the session — the guard must never break an edit for infrastructure reasons.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type SeenTool = "read" | "grep" | "write" | "edit";

export interface SeenRange {
  start: number;
  end: number;
}

export interface SeenRow {
  start_line: number;
  end_line: number;
  file_hash: string;
  tool: string;
}

interface AttributedRange extends SeenRange {
  tool: string;
}

export interface SeenIndex {
  listSeenLines(runId: string, path: string): SeenRow[];
  replaceSeenLines(
    runId: string,
    path: string,
    fileHash: string,
    rows: { start: number; end: number; tool: string }[],
  ): void;
}

export function sha256Hex(data: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

export const HASH_FILE_MAX_BYTES = 4 * 1024 * 1024;

export async function hashFile(
  path: string,
  maxBytes: number = HASH_FILE_MAX_BYTES,
): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return sha256Hex(await readFile(path));
  } catch {
    return null;
  }
}

export function coalesce<T extends SeenRange>(ranges: T[]): T[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: T[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function intersects(a: SeenRange, b: SeenRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

/** 1-based line spans of each non-overlapping occurrence (split()-consistent scan).
 * A trailing newline terminates the last occupied line — it never extends the span. */
export function occurrenceSpans(body: string, needle: string, all: boolean): SeenRange[] {
  if (!needle) return [];
  const height = countNewlines(needle) - (needle.endsWith("\n") ? 1 : 0);
  const spans: SeenRange[] = [];
  let line = 1;
  let counted = 0;
  let from = 0;
  for (;;) {
    const i = body.indexOf(needle, from);
    if (i === -1) break;
    for (let j = counted; j < i; j += 1) if (body.charCodeAt(j) === 10) line += 1;
    counted = i;
    spans.push({ start: line, end: line + height });
    if (!all) break;
    from = i + needle.length;
  }
  return spans;
}

const REREAD_SHOWN = 5;

function formatReread(path: string, ranges: SeenRange[]): { shown: string; full: string[] } {
  const full = ranges.map((r) => `${path}:${r.start}-${r.end}`);
  const extra = full.length - REREAD_SHOWN;
  const shown =
    extra > 0 ? `${full.slice(0, REREAD_SHOWN).join(", ")}, +${extra} more` : full.join(", ");
  return { shown, full };
}

export function staleMessage(
  path: string,
  oldHash: string,
  newHash: string,
  ranges: SeenRange[],
): { message: string; reread: string[] } {
  const { shown, full } = formatReread(path, ranges);
  return {
    message: `edit: stale file: ${path} changed since it was read (snap ${oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)}). re-read these ranges: ${shown} then retry the edit.`,
    reread: full,
  };
}

export function unseenMessage(
  path: string,
  ranges: SeenRange[],
): { message: string; reread: string[] } {
  const { shown, full } = formatReread(path, ranges);
  return {
    message: `edit: unread lines in ${path}: this session has no read evidence covering the target. re-read these ranges: ${shown} then retry the edit.`,
    reread: full,
  };
}

function remapThroughEdit(
  prior: AttributedRange[],
  spans: SeenRange[],
  delta: number,
): AttributedRange[] {
  const out: AttributedRange[] = [];
  for (const r of prior) {
    let segs: SeenRange[] = [{ start: r.start, end: r.end }];
    for (const s of spans) {
      const next: SeenRange[] = [];
      for (const g of segs) {
        if (g.end < s.start || g.start > s.end) {
          next.push(g);
          continue;
        }
        if (g.start < s.start) next.push({ start: g.start, end: s.start - 1 });
        if (g.end > s.end) next.push({ start: s.end + 1, end: g.end });
      }
      segs = next;
    }
    for (const g of segs) {
      const k = spans.filter((s) => s.end < g.start).length;
      out.push({ start: g.start + k * delta, end: g.end + k * delta, tool: r.tool });
    }
  }
  return out;
}

function spansAfterEdit(spans: SeenRange[], delta: number): SeenRange[] {
  return spans.map((s, i) => ({ start: s.start + i * delta, end: s.end + (i + 1) * delta }));
}

export class SeenLedger {
  private index: SeenIndex | null = null;
  private runId: string | null = null;
  private broken = false;

  attach(index: SeenIndex, runId: string): void {
    this.index = index;
    this.runId = runId;
  }

  get enabled(): boolean {
    return this.index !== null && this.runId !== null && !this.broken;
  }

  rows(path: string): SeenRow[] | null {
    if (!this.enabled || !this.index || !this.runId) return null;
    try {
      return this.index.listSeenLines(this.runId, resolve(path));
    } catch {
      this.broken = true;
      return null;
    }
  }

  record(path: string, fileHash: string, ranges: SeenRange[], tool: SeenTool): boolean {
    if (!this.enabled || !this.index || !this.runId) return false;
    if (ranges.length === 0) return false;
    try {
      const key = resolve(path);
      const surviving: AttributedRange[] = this.index
        .listSeenLines(this.runId, key)
        .filter((r) => r.file_hash === fileHash)
        .map((r) => ({ start: r.start_line, end: r.end_line, tool: r.tool }));
      const added: AttributedRange[] = coalesce(ranges).map((r) => ({
        start: r.start,
        end: r.end,
        tool,
      }));
      this.index.replaceSeenLines(this.runId, key, fileHash, coalesce([...surviving, ...added]));
      return true;
    } catch {
      this.broken = true;
      return false;
    }
  }

  applyEdit(
    path: string,
    edit: { spans: SeenRange[]; lineDelta: number; newHash: string },
  ): boolean {
    if (!this.enabled || !this.index || !this.runId) return false;
    try {
      const key = resolve(path);
      const prior: AttributedRange[] = this.index
        .listSeenLines(this.runId, key)
        .map((r) => ({ start: r.start_line, end: r.end_line, tool: r.tool }));
      const spans = [...edit.spans].sort((a, b) => a.start - b.start);
      const kept = remapThroughEdit(prior, spans, edit.lineDelta);
      const fresh: AttributedRange[] = spansAfterEdit(spans, edit.lineDelta).map((s) => ({
        start: s.start,
        end: s.end,
        tool: "edit",
      }));
      this.index.replaceSeenLines(this.runId, key, edit.newHash, coalesce([...kept, ...fresh]));
      return true;
    } catch {
      this.broken = true;
      return false;
    }
  }
}
