/**
 * Real git commits (F9a, MUB-230) — the single path behind both the `git_commit` tool and
 * the `/commit` command.
 *
 * Committing was already reachable through `bash`, so this adds no capability; it makes the
 * commits WELL-FORMED and enforceable, which a prompt instruction over an opaque bash string
 * can never be. Two paths to a commit therefore remain, and only this one is attributed —
 * an accepted cost, not an oversight (steering `git commit` in bash was rejected: bash_steer
 * ships a user-visible promise that ordinary git commands are never blocked, and `eval
 * "$CMD"` is undecidable anyway).
 *
 * Reuses checkpoint.ts's `git()` spawn helper and repo resolver, but deliberately NOT its
 * discipline. A checkpoint is plumbing: commit-tree into refs/minima/, no hooks, a throwaway
 * index, the `minima <minima@local>` shadow identity. A real commit inverts all three — it
 * runs the user's `pre-commit`/`commit-msg` hooks, it commits the user's own index, and it is
 * authored by the user's configured git identity. Nothing here sets GIT_AUTHOR_* or
 * GIT_COMMITTER_*, which is exactly what keeps the shadow identity out of real history.
 *
 * Trailers carry a POINTER, not the evidence: one deduped `Co-Authored-By` per contributing
 * model plus a single `Minima-Run-Id`. A per-turn `Minima-Rec-Id` was rejected — a commit
 * spanning a dozen turns would carry a dozen opaque trailers, and trailers reviewers find
 * noisy are trailers reviewers strip. The run's models, cost and gates stay in the ledger.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { git, makeRepoResolver } from "./checkpoint.ts";

export interface CommitDeps {
  /** Repo toplevel resolver (checkpoint.ts:makeRepoResolver) — null outside a work tree. */
  top: () => string | null;
  /** Model ids that contributed to this run, newest last. Deduped here, order preserved. */
  models: () => string[];
  /** The run behind the commit — one `Minima-Run-Id` pointer, or none when absent. */
  runId: () => string | null;
}

/** What {@link makeCommitDeps} needs from the running session. The db seam is structural
 *  rather than a MinimaDb import: this module has no business knowing the whole schema. */
export interface CommitContext {
  cwd: string;
  db: { getRunDecisions(runId: string): Record<string, unknown>[] } | null;
  getRunId: () => string | null;
  /** The model the CURRENT turn is running on, from live agent state. */
  getLiveModelId: () => string | null;
}

/**
 * The one dependency set behind both commit surfaces, so the `git_commit` tool and `/commit`
 * cannot drift into producing different commits.
 *
 * Contributing models are the run's routed decisions plus the live model. Two known
 * approximations, both deliberate:
 *  - The live model is appended because the current turn's decision row is only written when
 *    the turn ENDS — without it, the model that just made the changes would be missing from
 *    its own commit. It goes last so a model already credited keeps its first-use position.
 *  - Attribution is per RUN, not per diff: a run's read-only turns, and turns already
 *    covered by an earlier commit, are credited too. Narrowing it needs the commit↔turn join
 *    that MUB-234 owns. Over-crediting is the safe direction — omitting a model that wrote
 *    code is the worse error.
 */
export function makeCommitDeps(ctx: CommitContext): CommitDeps {
  return {
    top: makeRepoResolver(ctx.cwd),
    models: () => {
      const ids: string[] = [];
      const runId = ctx.getRunId();
      if (ctx.db && runId) {
        for (const decision of ctx.db.getRunDecisions(runId)) {
          const chosen = decision.chosen_model;
          if (typeof chosen === "string" && chosen) ids.push(chosen);
        }
      }
      const live = ctx.getLiveModelId();
      if (live) ids.push(live);
      return ids;
    },
    runId: ctx.getRunId,
  };
}

export type CommitResult =
  | { ok: true; sha: string; report: string }
  /**
   * `no-repo` is an environment fact the caller reports plainly; `refused` (a harness
   * precondition) and `failed` (git itself, including a hook rejection) are failed ACTIONS
   * the caller surfaces as errors — a hook rejection must never read as a silent no-op.
   */
  | { ok: false; kind: "no-repo" | "refused" | "failed"; reason: string };

/** Co-author addresses are synthetic but stable, and per-model: forges dedupe co-authors by
 *  email, so a shared address would collapse every model into one contributor. */
const COAUTHOR_DOMAIN = "noreply.minima.sh";

/** A git trailer line: `Token: value`, token being word-with-dashes (git's own rule). */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;

function modelAddress(modelId: string): string {
  const local =
    modelId
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model";
  return `${local}@${COAUTHOR_DOMAIN}`;
}

/**
 * Dedupe key for a model id. Minima's routing catalogue and the harness calling registry
 * keep separate ids and the two spellings drift — a provider prefix on one side and not the
 * other is the common case (minima/mapping.ts exists for exactly this). Without folding
 * them, one model earns two `Co-Authored-By` lines under two synthetic addresses. Folding on
 * the prefix also merges the same model reached through different providers, which is right:
 * for authorship, same model means same co-author.
 */
function modelKey(modelId: string): string {
  const bare = modelId.slice(modelId.lastIndexOf("/") + 1);
  return (bare || modelId).toLowerCase();
}

/** Trailers for this run: `Co-Authored-By` deduped by model in first-use order (the first
 *  spelling seen is the one credited), then at most one `Minima-Run-Id`. */
function buildTrailers(deps: CommitDeps): string[] {
  const trailers: string[] = [];
  const seen = new Set<string>();
  for (const raw of deps.models()) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(modelKey(id))) continue;
    seen.add(modelKey(id));
    trailers.push(`Co-Authored-By: ${id} <${modelAddress(id)}>`);
  }
  const runId = deps.runId()?.trim();
  if (runId) trailers.push(`Minima-Run-Id: ${runId}`);
  return trailers;
}

/**
 * Append trailers to an author's message. A trailer already present is never repeated, and
 * fresh ones join an existing trailer block rather than opening a second one. A single-line
 * message is a SUBJECT even when it looks like a trailer ("feat: add a" matches the token
 * rule), so the blank line is mandatory whenever there is only one block.
 */
function appendTrailers(message: string, trailers: string[]): string {
  const base = message.replace(/\s+$/, "");
  const present = new Set(base.split("\n").map((l) => l.trim().toLowerCase()));
  const fresh = trailers.filter((t) => !present.has(t.toLowerCase()));
  if (fresh.length === 0) return base;
  const blocks = base.split(/\n[ \t]*\n/);
  const last = blocks[blocks.length - 1] ?? "";
  const joinsBlock =
    blocks.length > 1 && last.length > 0 && last.split("\n").every((l) => TRAILER_LINE.test(l));
  return `${base}${joinsBlock ? "\n" : "\n\n"}${fresh.join("\n")}`;
}

/** Mid-rebase / mid-merge, from the state files git itself uses. Null when the tree is idle. */
function inProgressOperation(top: string): "rebase" | "merge" | null {
  const dir = git(top, ["rev-parse", "--absolute-git-dir"]);
  const gitDir = dir.ok ? dir.stdout.trim() : "";
  if (!gitDir) return null;
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  return null;
}

function hasStagedChanges(top: string): boolean {
  return git(top, ["diff", "--cached", "--name-only"]).stdout.trim().length > 0;
}

/**
 * The commit itself, spawned ASYNC unlike every other call here: `pre-commit` and
 * `commit-msg` are the user's own code of unbounded duration (a test suite, a formatter),
 * and spawnSync would freeze the TUI for as long as they run.
 */
async function gitCommitAsync(top: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["git", "-C", top, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    out: [stdout, stderr]
      .map((t) => t.trim())
      .filter(Boolean)
      .join("\n"),
  };
}

export interface CommitRequest {
  message: string;
  /** Paths to commit. Empty = commit the staged index. NEVER `-a` under either shape. */
  paths?: string[];
}

export async function commitChanges(
  deps: CommitDeps,
  request: CommitRequest,
): Promise<CommitResult> {
  const top = deps.top();
  if (!top) {
    return {
      ok: false,
      kind: "no-repo",
      reason: "Not a git repository — there is nothing here to commit into.",
    };
  }

  const message = request.message.trim();
  if (!message) {
    return { ok: false, kind: "refused", reason: "A commit message is required." };
  }

  const operation = inProgressOperation(top);
  if (operation) {
    return {
      ok: false,
      kind: "refused",
      reason:
        `Refusing to commit during an in-progress ${operation}: finish or abort it first ` +
        `(git ${operation} --continue, or git ${operation} --abort), then commit.`,
    };
  }

  const paths = (request.paths ?? []).map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0 && !hasStagedChanges(top)) {
    return {
      ok: false,
      kind: "refused",
      reason:
        "Nothing staged to commit. Stage the changes you want first, or pass the `paths` " +
        "to commit — git_commit never stages the whole worktree with -a.",
    };
  }

  // A partial commit can only name paths git already knows, so `git commit -- new_file`
  // fails outright on an untracked path. `add -N` (intent-to-add) is what makes it known
  // WITHOUT staging content: a tracked path is left alone entirely, so a user's partial
  // `git add -p` staging survives — including when a hook then rejects the commit, where a
  // real `git add` would have silently overwritten it. Never `-A`, never `-a`.
  if (paths.length > 0) {
    const add = git(top, ["add", "-N", "--", ...paths]);
    if (!add.ok) {
      return {
        ok: false,
        kind: "failed",
        reason: `Could not stage the requested paths:\n${add.stderr.trim() || add.stdout.trim()}`,
      };
    }
  }

  // `-m` with the finished message: no editor can open, and both hooks still run. Paths go
  // after `--` so a path can never be read as an option, and they keep the commit partial —
  // anything else the user had staged stays staged rather than riding along.
  const args = ["commit", "-m", appendTrailers(message, buildTrailers(deps))];
  if (paths.length > 0) args.push("--", ...paths);

  const res = await gitCommitAsync(top, args);
  if (!res.ok) {
    return {
      ok: false,
      kind: "failed",
      reason: `git commit failed${res.out ? `:\n${res.out}` : "."}`,
    };
  }

  const sha = git(top, ["rev-parse", "HEAD"]).stdout.trim();
  const stat = git(top, ["show", "--stat", "--format=%s", sha]).stdout.trim();
  return { ok: true, sha, report: `Committed ${sha.slice(0, 7)}\n${stat}` };
}
