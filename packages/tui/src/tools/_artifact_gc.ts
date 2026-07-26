/**
 * Artifact GC (W3.3) — bounds the P1 spill dir to a byte budget with an LRU prune
 * over the `artifacts` index (last_used ASC, created ASC tiebreak). Runs at store
 * attach and post-spill; rows owned by the attached run are never pruned, and every
 * operation is fail-open — GC trouble never breaks a tool result.
 */

import { rmSync } from "node:fs";
import { basename } from "node:path";
import type { AfterToolCall } from "../agent/tools.ts";
import { resolveWithin } from "./_io.ts";

/** Structural raw-SQL seam (db-layer style): satisfied by MinimaDb's public `db`
 * handle without importing it — same late-bind shape as ArtifactIndex. */
export interface ArtifactSql {
  run(sql: string, params: unknown[]): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
}

const ARTIFACT_NAME = /^[0-9a-f]{64}\.txt$/;

export function claimArtifact(sql: ArtifactSql, sha: string, runId: string): void {
  try {
    sql.run("UPDATE artifacts SET run_id = ? WHERE sha = ?", [runId, sha]);
  } catch {
    // fail-open: an unclaimed row only weakens its own GC shield
  }
}

export function touchArtifact(sql: ArtifactSql, dir: string, path: string): void {
  try {
    const r = resolveWithin(path, dir);
    if (!r.ok) return;
    const name = basename(r.path);
    if (!ARTIFACT_NAME.test(name)) return;
    sql.run("UPDATE artifacts SET last_used = ? WHERE sha = ?", [
      Date.now() / 1000,
      name.slice(0, 64),
    ]);
  } catch {
    // fail-open: a missed touch only ages the row
  }
}

export function pruneArtifacts(
  sql: ArtifactSql,
  opts: { budgetBytes: number; protectRunId: string | null },
): void {
  if (!Number.isFinite(opts.budgetBytes) || opts.budgetBytes <= 0) return;
  try {
    const agg = sql.query("SELECT COALESCE(SUM(bytes), 0) AS total FROM artifacts").all() as {
      total: number;
    }[];
    let total = agg[0]?.total ?? 0;
    if (total <= opts.budgetBytes) return;
    const rows = sql
      .query("SELECT sha, path, run_id, bytes FROM artifacts ORDER BY last_used ASC, created ASC")
      .all() as { sha: string; path: string; run_id: string | null; bytes: number }[];
    for (const row of rows) {
      if (total <= opts.budgetBytes) break;
      if (opts.protectRunId !== null && row.run_id === opts.protectRunId) continue;
      try {
        rmSync(row.path, { force: true });
      } catch {
        continue;
      }
      sql.run("DELETE FROM artifacts WHERE sha = ?", [row.sha]);
      total -= row.bytes;
    }
  } catch {
    // fail-open: an unpruned dir is a disk-space problem, never a correctness one
  }
}

/** Dispatcher-side touch: any successful tool call whose `path` argument resolves
 * into the artifact dir bumps that row's last_used — path-keyed, never tool-name
 * special-cased, so future artifact readers inherit the LRU signal for free. */
export function makeArtifactReadTouchHook(store: {
  noteRead(path: string): void;
}): AfterToolCall {
  return async (ctx) => {
    if (!ctx.isError && !ctx.result.details?.error) {
      const p = ctx.toolCall.arguments.path;
      if (typeof p === "string" && p) store.noteRead(p);
    }
    return null;
  };
}
