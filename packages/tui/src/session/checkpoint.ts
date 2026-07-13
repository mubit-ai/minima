/**
 * Git-shadow checkpoints (B3, MUB-136) — worktree snapshots the user's git never sees.
 *
 * Every snapshot stages the WHOLE worktree into a throwaway index (GIT_INDEX_FILE), writes
 * a tree + parentless commit, and parks it under refs/minima/ckpt/<runId>/<seq>-<id>. The
 * user's .git/index and worktree are never touched by a snapshot; restores touch exactly
 * the paths that differ. .gitignore'd files are excluded by design (they appear in neither
 * tree, so restores never touch them either). Caveat: user-created untracked files are
 * captured by later snapshots, so restoring PAST their creation deletes them — inherent to
 * worktree snapshotting; the pre-restore safety snapshot preserves them.
 *
 * All git calls are Bun.spawnSync plumbing (add/write-tree/commit-tree/update-ref/diff-tree/
 * read-tree/checkout-index) — no hooks fire, and refs keep snapshot objects gc-reachable.
 * The per-run index file is REUSED across snapshots: a fresh index would re-hash the whole
 * worktree every time; a warm one keeps git's stat cache so `add -A` is near-instant.
 */

import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeforeToolCall } from "../agent/tools.ts";
import type { CheckpointRow, MinimaDb } from "../db/minima_db.ts";

/** Snapshot identity: explicit so hosts without a derivable email can't break commit-tree. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "minima",
  GIT_AUTHOR_EMAIL: "minima@local",
  GIT_COMMITTER_NAME: "minima",
  GIT_COMMITTER_EMAIL: "minima@local",
};

/** Tools whose execution can mutate the worktree (task: children run without lead hooks). */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
  "task",
]);

function git(
  top: string,
  args: string[],
  opts?: { env?: Record<string, string>; stdin?: Uint8Array },
): { ok: boolean; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["git", "-C", top, ...args], {
    env: { ...process.env, ...opts?.env },
    stdin: opts?.stdin,
  });
  return {
    ok: res.exitCode === 0,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

/** Repo toplevel for cwd, or null outside a work tree (checkpoints then stay off). */
export function detectRepo(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (res.exitCode !== 0) return null;
  const top = res.stdout.toString().trim();
  return top || null;
}

const indexPathFor = (runId: string) => join(tmpdir(), `minima-ckpt-${runId}.index`);

/** True while a snapshot/restore runs — spawnSync blocks, but parallel hooks await around us. */
let inFlight = false;

export interface SnapshotOpts {
  top: string;
  db: MinimaDb;
  runId: string;
  /** Replay-space prompt ordinal (db.countLeadUserEvents at snapshot time). */
  promptOrdinal: number;
  stepId?: string | null;
  kind?: "turn" | "safety";
}

/**
 * Snapshot the worktree. Returns the new row, the existing newest row when the tree is
 * unchanged (dedupe — no ref churn on read-only turns), or null on any git failure
 * (bookkeeping must never break a turn; callers log-and-swallow).
 */
export function snapshot(opts: SnapshotOpts): CheckpointRow | null {
  if (inFlight) return null;
  inFlight = true;
  try {
    const env = { ...GIT_IDENTITY, GIT_INDEX_FILE: indexPathFor(opts.runId) };
    if (!git(opts.top, ["add", "-A"], { env }).ok) return null;
    const tree = git(opts.top, ["write-tree"], { env });
    if (!tree.ok) return null;
    const treeSha = tree.stdout.trim();

    const prev = opts.db.latestCheckpoint(opts.runId);
    if (prev && prev.tree_sha === treeSha) return prev;

    const commit = git(
      opts.top,
      [
        "commit-tree",
        treeSha,
        "-m",
        `minima checkpoint run=${opts.runId} prompt=${opts.promptOrdinal}`,
      ],
      { env },
    );
    if (!commit.ok) return null;
    const commitSha = commit.stdout.trim();

    const seq = String(opts.db.listCheckpoints(opts.runId).length + 1).padStart(6, "0");
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const ref = `refs/minima/ckpt/${opts.runId}/${seq}-${id}`;
    if (!git(opts.top, ["update-ref", ref, commitSha]).ok) return null;

    const rowId = opts.db.insertCheckpoint({
      id,
      runId: opts.runId,
      ref,
      commitSha,
      treeSha,
      promptOrdinal: opts.promptOrdinal,
      stepId: opts.stepId ?? null,
      kind: opts.kind ?? "turn",
    });
    return opts.db.listCheckpoints(opts.runId).find((c) => c.id === rowId) ?? null;
  } finally {
    inFlight = false;
  }
}

/** One record of `diff-tree -r --no-renames -z <target> <now>` raw output. */
interface DiffRecord {
  targetMode: string;
  nowMode: string;
  status: string;
  path: string;
}

function parseRawDiff(raw: string): DiffRecord[] {
  // -z raw format: ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0" repeated.
  const parts = raw.split("\0");
  const records: DiffRecord[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    if (!meta.startsWith(":") || !path) continue;
    const fields = meta.slice(1).split(" ");
    if (fields.length < 5) continue;
    records.push({
      targetMode: fields[0]!,
      nowMode: fields[1]!,
      status: fields[4]!,
      path,
    });
  }
  return records;
}

/** Remove now-empty parent dirs after a deletion pass (checkout-index won't). */
function pruneEmptyDirs(top: string, paths: string[]): void {
  const dirs = new Set<string>();
  for (const p of paths) {
    let d = dirname(p);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = dirname(d);
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(top, d);
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      // best-effort — a non-empty/locked dir just stays
    }
  }
}

export interface RestoreResult {
  /** Paths written back from the target tree (modified/deleted-since → recreated). */
  restored: string[];
  /** Paths created since the target snapshot → removed. */
  deleted: string[];
  /** The pre-restore safety snapshot (undo the undo via its tree). */
  safety: CheckpointRow | null;
}

/**
 * Restore the worktree to `targetTreeSha`, byte-identical for everything git tracks in
 * either tree. Takes a safety snapshot first. Directories on created paths (gitlinks/
 * embedded repos) are never deleted; gitlink records are never checked out.
 */
export function restore(opts: {
  top: string;
  db: MinimaDb;
  runId: string;
  targetTreeSha: string;
}): RestoreResult | null {
  const ordinal = opts.db.countLeadUserEvents(opts.runId);
  const safety = snapshot({
    top: opts.top,
    db: opts.db,
    runId: opts.runId,
    promptOrdinal: ordinal,
    kind: "safety",
  });
  if (!safety) return null;

  const diff = git(opts.top, [
    "diff-tree",
    "-r",
    "--no-renames",
    "-z",
    opts.targetTreeSha,
    safety.tree_sha,
  ]);
  if (!diff.ok) return null;
  const records = parseRawDiff(diff.stdout);

  // Deletion pass FIRST (handles file↔dir swaps): status A = exists only in "now".
  const deleted: string[] = [];
  for (const rec of records) {
    if (rec.status !== "A") continue;
    const abs = join(opts.top, rec.path);
    try {
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) continue; // gitlink/embedded repo — never delete directories
      unlinkSync(abs);
      deleted.push(rec.path);
    } catch {
      // best-effort per path; a failed delete leaves the file for the user to see
    }
  }
  pruneEmptyDirs(opts.top, deleted);

  // Restore pass: everything in the target side that differs (M/D/T), minus gitlinks.
  const toRestore = records
    .filter((r) => r.status !== "A" && r.targetMode !== "160000")
    .map((r) => r.path);
  if (toRestore.length > 0) {
    const env = {
      ...GIT_IDENTITY,
      GIT_INDEX_FILE: join(tmpdir(), `minima-restore-${opts.runId}.index`),
    };
    try {
      if (!git(opts.top, ["read-tree", opts.targetTreeSha], { env }).ok) return null;
      const stdin = new TextEncoder().encode(`${toRestore.join("\0")}\0`);
      if (!git(opts.top, ["checkout-index", "-f", "-z", "--stdin"], { env, stdin }).ok) return null;
    } finally {
      try {
        unlinkSync(env.GIT_INDEX_FILE);
      } catch {
        // already gone
      }
    }
  }
  return { restored: toRestore, deleted, safety };
}

/**
 * Prune checkpoint refs: keep the current run and the `keepRuns` most recently
 * snapshotted others; delete every ref (one batched update-ref) + row + warm index
 * of the rest. Returns the pruned run count.
 */
export function gcCheckpoints(opts: {
  top: string;
  db: MinimaDb;
  currentRunId?: string | null;
  keepRuns?: number;
}): number {
  const keep = opts.keepRuns ?? 5;
  const runs = opts.db.checkpointRuns();
  const keepSet = new Set(runs.slice(0, keep));
  if (opts.currentRunId) keepSet.add(opts.currentRunId);
  const drop = runs.filter((r) => !keepSet.has(r));
  if (drop.length === 0) return 0;

  const refs = git(opts.top, ["for-each-ref", "--format=%(refname)", "refs/minima/ckpt/"]);
  if (!refs.ok) return 0;
  const doomed = refs.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => drop.some((runId) => r.startsWith(`refs/minima/ckpt/${runId}/`)));
  if (doomed.length > 0) {
    const stdin = new TextEncoder().encode(doomed.map((r) => `delete ${r}\0\0`).join(""));
    git(opts.top, ["update-ref", "--stdin", "-z"], { stdin });
  }
  for (const runId of drop) {
    opts.db.deleteCheckpoints(runId);
    try {
      unlinkSync(indexPathFor(runId));
    } catch {
      // no warm index for that run
    }
  }
  return drop.length;
}

export interface CheckpointHookDeps {
  /** Repo toplevel; null = not a git repo (hook stays dormant after one notice). */
  top: string | null;
  db: MinimaDb | null;
  getRunId: () => string | null;
  /** In-progress GT step at snapshot time (null when GT off). */
  getStepId?: () => string | null;
  /** One-line notices ("checkpoints off — not a git repo", snapshot failures). */
  notify?: (message: string) => void;
}

export interface CheckpointArm {
  /** Re-arm at prompt dispatch: the NEXT mutating tool call snapshots once. */
  arm: () => void;
  hook: BeforeToolCall;
}

/**
 * The B3 trigger: a BeforeToolCall that snapshots on the FIRST mutating tool call after
 * each arm() (one per prompt), then disarms. Never blocks, never throws — a checkpoint
 * failure is a notice, not a broken turn.
 */
export function makeCheckpointHook(deps: CheckpointHookDeps): CheckpointArm {
  let armed = false;
  let noticedNonGit = false;
  const hook: BeforeToolCall = async (ctx) => {
    if (!armed || !MUTATING_TOOLS.has(ctx.toolCall.name)) return null;
    armed = false;
    try {
      const runId = deps.getRunId();
      if (!deps.db || !runId) return null;
      if (!deps.top) {
        if (!noticedNonGit) {
          noticedNonGit = true;
          deps.notify?.(
            "checkpoints off — not a git repository (undo/rewind code restore unavailable)",
          );
        }
        return null;
      }
      const row = snapshot({
        top: deps.top,
        db: deps.db,
        runId,
        promptOrdinal: deps.db.countLeadUserEvents(runId),
        stepId: deps.getStepId?.() ?? null,
      });
      if (!row) deps.notify?.("checkpoint snapshot failed (continuing without one)");
    } catch {
      // log-and-swallow: bookkeeping never breaks the hot path
    }
    return null;
  };
  return { arm: () => (armed = true), hook };
}
