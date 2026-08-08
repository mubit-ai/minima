/**
 * F9b (MUB-234) — the commits ledger and its reader.
 *
 * Two seams, both named by the ticket: the database layer, and the tool's execute path
 * against a real temporary repository (F9a's prior art, reused exactly). The end-to-end
 * assertions go through `git_commit` and read the SHA back out of git, so what is pinned is
 * "authoring a commit records the join", not "a function I called wrote a row".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { isCommitArg, whyCommitReport } from "../src/minima/why.ts";
import { type CommitContext, commitChanges, makeCommitDeps } from "../src/session/commit.ts";
import { registerGitCommitTool } from "../src/tools/git_commit.ts";

const dirs: string[] = [];
const dbs: MinimaDb[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.db.close();
});

function git(top: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", top, ...args]).stdout.toString();
}

/** mkdtemp + git init + a configured identity + an --allow-empty root commit. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-commits-ledger-"));
  dirs.push(dir);
  Bun.spawnSync(["git", "init", dir]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "dev@example.test"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "Repo Owner"]);
  Bun.spawnSync(["git", "-C", dir, "config", "commit.gpgsign", "false"]);
  Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function write(top: string, relPath: string, content: string): void {
  const full = join(top, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  Bun.spawnSync(["git", "-C", top, "add", relPath]);
}

function freshDb(): MinimaDb {
  const db = new MinimaDb(":memory:");
  dbs.push(db);
  db.ensureProject("p");
  return db;
}

/** A routed rung with a realized cost, exactly as the feedback path leaves it. */
function decision(
  db: MinimaDb,
  runId: string,
  recId: string,
  model: string,
  costUsd: number | null,
  ts: number,
): void {
  db.db.run(
    `INSERT INTO routing_decisions (rec_id, run_id, chosen_model, actual_cost_usd, ts)
     VALUES (?, ?, ?, ?, ?)`,
    [recId, runId, model, costUsd, ts],
  );
}

function depsFor(
  top: string,
  db: MinimaDb | null,
  runId: string | null,
  opts: { ledger?: boolean; liveModel?: string | null } = {},
) {
  const ctx: CommitContext = {
    cwd: top,
    db,
    getRunId: () => runId,
    getLiveModelId: () => opts.liveModel ?? null,
    ledger: opts.ledger,
  };
  return makeCommitDeps(ctx);
}

// ------------------------------------------------------------------ the database layer

describe("commits ledger — schema and the join", () => {
  test("the migration adds a commits table to a fresh database", () => {
    const db = freshDb();
    const table = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='commits'")
      .get();
    expect(table).not.toBeNull();
    const cols = new Set(
      (db.db.query("PRAGMA table_info(commits)").all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols).toEqual(new Set(["sha", "run_id", "rec_ids", "created"]));
  });

  test("recordCommit writes exactly one row, and re-recording the same SHA does not duplicate", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    db.recordCommit({ sha: "abc1234def", runId, recIds: ["rec-1"] });
    db.recordCommit({ sha: "abc1234def", runId, recIds: ["rec-1", "rec-2"] });
    const rows = db.db.query("SELECT * FROM commits").all() as { rec_ids: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.rec_ids)).toEqual(["rec-1"]);
  });

  test("unattributedRecIds claims a run's rungs once — the second commit does not re-credit the first", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-1", "claude-sonnet-5", 0.1, 1);
    decision(db, runId, "rec-2", "claude-opus-5", 0.2, 2);

    const first = db.unattributedRecIds(runId);
    expect(first).toEqual(["rec-1", "rec-2"]);
    db.recordCommit({ sha: "aaa1111", runId, recIds: first });

    // A third rung lands, then a second commit: only the NEW rung is claimed.
    decision(db, runId, "rec-3", "claude-haiku-4-5", 0.05, 3);
    expect(db.unattributedRecIds(runId)).toEqual(["rec-3"]);
  });

  test("the rung currently executing is claimed even though its decision row is not written yet", () => {
    // A commit is authored from INSIDE a turn, and persistDecision only writes that turn's row
    // when it ENDS. Reading routing_decisions alone therefore misses the very rung that made
    // the changes — in a one-turn session it would leave the commit with no contributors at
    // all, indistinguishable from an unrouted commit.
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    expect(db.unattributedRecIds(runId, "rec-live")).toEqual(["rec-live"]);

    db.recordCommit({ sha: "live111", runId, recIds: db.unattributedRecIds(runId, "rec-live") });
    // The turn now ends and its row lands: the commit already owns it, so the NEXT commit
    // must not claim it a second time.
    decision(db, runId, "rec-live", "claude-sonnet-5", 0.3, 1);
    expect(db.unattributedRecIds(runId)).toEqual([]);
    // And the evidence resolves through the join that was written ahead of it.
    expect(db.commitContributions("live111").map((c) => c.chosen_model)).toEqual([
      "claude-sonnet-5",
    ]);
  });

  test("a live rec_id whose row already landed is not listed twice", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-1", "claude-sonnet-5", 0.1, 1);
    expect(db.unattributedRecIds(runId, "rec-1")).toEqual(["rec-1"]);
  });

  test("another run's rungs are never claimed", () => {
    const db = freshDb();
    const mine = db.startRun({ projectKey: "p" });
    const theirs = db.startRun({ projectKey: "p" });
    decision(db, mine, "rec-mine", "claude-sonnet-5", 0.1, 1);
    decision(db, theirs, "rec-theirs", "claude-opus-5", 5, 1);
    expect(db.unattributedRecIds(mine)).toEqual(["rec-mine"]);
  });

  test("findCommitBySha resolves a prefix, and reports unknown and ambiguous plainly", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    db.recordCommit({ sha: "abcdef1234567890", runId, recIds: [] });
    expect(db.findCommitBySha("abcdef1").kind).toBe("found");
    expect(db.findCommitBySha("ABCDEF1").kind).toBe("found");
    expect(db.findCommitBySha("abcdef1234567890").kind).toBe("found");
    expect(db.findCommitBySha("9999999").kind).toBe("unknown");

    db.recordCommit({ sha: "abcdef1999999999", runId, recIds: [] });
    const lookup = db.findCommitBySha("abcdef1");
    expect(lookup.kind).toBe("ambiguous");
    if (lookup.kind === "ambiguous") expect(lookup.shas).toHaveLength(2);
  });

  test("a malformed rec_ids blob yields no contributors rather than throwing", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    db.recordCommit({ sha: "bad1234", runId, recIds: [] });
    db.db.run("UPDATE commits SET rec_ids = '{not json' WHERE sha = 'bad1234'");
    expect(() => db.commitContributions("bad1234")).not.toThrow();
    expect(db.commitContributions("bad1234")).toEqual([]);
  });
});

// ------------------------------------------------------------------ the tool's execute path

describe("commits ledger — authoring a commit records the join", () => {
  function commitTool(top: string, db: MinimaDb | null, runId: string | null, ledger?: boolean) {
    const tools: AgentTool[] = [];
    registerGitCommitTool(tools, true, depsFor(top, db, runId, { ledger }));
    return tools.find((t) => t.name === "git_commit") as AgentTool;
  }

  /** F9a's call convention: the tool takes (id, params, signal, onProgress). */
  const run = (tool: AgentTool, params: Record<string, unknown>) =>
    tool.execute("call-1", params, null, null);

  test("committing through git_commit writes one row joining SHA to its rungs and cost", async () => {
    const top = tempRepo();
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-a", "claude-sonnet-5", 0.25, 1);
    decision(db, runId, "rec-b", "claude-opus-5", 0.75, 2);
    write(top, "a.txt", "hello");

    const tool = commitTool(top, db, runId);
    await run(tool, { message: "feat: a" });

    const sha = git(top, "rev-parse", "HEAD").trim();
    const lookup = db.findCommitBySha(sha);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("unreachable");
    expect(lookup.row.run_id).toBe(runId);
    expect(JSON.parse(lookup.row.rec_ids)).toEqual(["rec-a", "rec-b"]);
    // Queried by SHA, the contributing recommendation ids come back — the ticket's assertion.
    expect(db.commitContributions(sha).map((c) => c.rec_id)).toEqual(["rec-a", "rec-b"]);
  });

  test("two commits in one run partition the rungs between them", async () => {
    const top = tempRepo();
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-1", "claude-sonnet-5", 0.1, 1);
    write(top, "one.txt", "1");
    await run(commitTool(top, db, runId), { message: "feat: one" });
    const first = git(top, "rev-parse", "HEAD").trim();

    decision(db, runId, "rec-2", "claude-opus-5", 0.2, 2);
    write(top, "two.txt", "2");
    await run(commitTool(top, db, runId), { message: "feat: two" });
    const second = git(top, "rev-parse", "HEAD").trim();

    expect(db.commitContributions(first).map((c) => c.rec_id)).toEqual(["rec-1"]);
    expect(db.commitContributions(second).map((c) => c.rec_id)).toEqual(["rec-2"]);
  });

  test("a commit outside a routed session still commits, and is recorded with no contributors", async () => {
    const top = tempRepo();
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" }); // a run, but nothing routed under it
    write(top, "solo.txt", "x");

    const res = await run(commitTool(top, db, runId), { message: "chore: solo" });
    expect((res.details as { committed?: boolean }).committed).toBe(true);

    const sha = git(top, "rev-parse", "HEAD").trim();
    expect(db.findCommitBySha(sha).kind).toBe("found");
    expect(db.commitContributions(sha)).toEqual([]);
    // The distinction that matters: recorded-but-empty reads differently from never-seen.
    expect(whyCommitReport(db, sha)).toContain("No routed recommendations contributed");
  });

  test("the ledger write never breaks the commit: a throwing ledger still leaves the commit in git", async () => {
    const top = tempRepo();
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    write(top, "a.txt", "hello");

    const deps = depsFor(top, db, runId);
    const exploding = {
      ...deps,
      recordCommit: () => {
        throw new Error("disk full");
      },
    };
    const result = await commitChanges(exploding, { message: "feat: survives" });
    expect(result.ok).toBe(true);
    expect(git(top, "log", "--format=%s", "-1").trim()).toBe("feat: survives");
  });
});

// ------------------------------------------------------------------ the reader

describe("/why <sha> — the reader", () => {
  test("argument shape decides: 7+ hex is a hash, anything else is a step index", () => {
    expect(isCommitArg("abc1234")).toBe(true);
    expect(isCommitArg("ABC1234")).toBe(true);
    expect(isCommitArg("a".repeat(40))).toBe(true);
    // All-digits and 7+ chars is hex, and is read as a hash — the stated tiebreak.
    expect(isCommitArg("1234567")).toBe(true);
    // Step indices and short/invalid tokens are not.
    expect(isCommitArg("3")).toBe(false);
    expect(isCommitArg("12")).toBe(false);
    expect(isCommitArg("abc123")).toBe(false); // six hex — below git's floor
    expect(isCommitArg("abcdefg")).toBe(false); // 'g' is not hex
    expect(isCommitArg("")).toBe(false);
    expect(isCommitArg("a".repeat(41))).toBe(false);
  });

  test("reports contributing models, realized cost and gate verdicts", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-a", "claude-sonnet-5", 0.25, 1);
    decision(db, runId, "rec-b", "claude-opus-5", 0.75, 2);
    db.recordCommit({ sha: "feed1234567", runId, recIds: db.unattributedRecIds(runId) });

    const { planId } = db.upsertPlanFromTodos(runId, [{ content: "s", status: "completed" }], "P");
    db.insertGate({
      planId,
      stepId: db.getPlanSteps(planId)[0]!.id,
      kind: "step_check",
      outcome: "verified",
      confidence: "green",
      verifiedBy: "deterministic",
      recId: "rec-a",
    });

    const report = whyCommitReport(db, "feed123");
    expect(report).toContain("Commit feed123");
    expect(report).toContain("claude-sonnet-5");
    expect(report).toContain("claude-opus-5");
    expect(report).toContain("$1.0000");
    expect(report).toContain("✓");
    expect(report).toContain("🟢");
  });

  test("a rung still awaiting feedback contributes 0 rather than an estimate", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-a", "claude-sonnet-5", null, 1);
    db.recordCommit({ sha: "0000111", runId, recIds: db.unattributedRecIds(runId) });
    expect(whyCommitReport(db, "0000111")).toContain("$0.0000");
  });

  test("a commit still ahead of its own evidence says so, not 'unrouted'", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    db.recordCommit({ sha: "aheadd1", runId, recIds: db.unattributedRecIds(runId, "rec-live") });
    const report = whyCommitReport(db, "aheadd1");
    expect(report).toContain("none has finished its turn yet");
    expect(report).not.toContain("authored outside a routed turn");
  });

  test("an unknown hash reports plainly rather than throwing", () => {
    const db = freshDb();
    const report = whyCommitReport(db, "9999999");
    expect(report).toContain("No ledger entry for commit 9999999");
  });

  test("an ambiguous prefix reports plainly and lists the matches", () => {
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    db.recordCommit({ sha: "abcdef1000000", runId, recIds: [] });
    db.recordCommit({ sha: "abcdef1999999", runId, recIds: [] });
    const report = whyCommitReport(db, "abcdef1");
    expect(report).toContain("Ambiguous commit prefix");
    expect(report).toContain("abcdef1000000".slice(0, 12));
  });

  test("without a database it reports plainly", () => {
    expect(whyCommitReport(null, "abc1234")).toContain("No commits ledger available");
  });
});

// ------------------------------------------------------------------ the kill switch

describe("MINIMA_TUI_COMMIT_LEDGER=0", () => {
  test("disables the write while leaving the attribution trailers intact", async () => {
    const top = tempRepo();
    const db = freshDb();
    const runId = db.startRun({ projectKey: "p" });
    decision(db, runId, "rec-a", "claude-sonnet-5", 0.25, 1);
    write(top, "a.txt", "hello");

    const deps = depsFor(top, db, runId, { ledger: false });
    expect(deps.recordCommit).toBeUndefined();
    const result = await commitChanges(deps, { message: "feat: no ledger" });
    expect(result.ok).toBe(true);

    // No row was written...
    expect(db.db.query("SELECT COUNT(*) AS n FROM commits").get()).toEqual({ n: 0 });
    // ...but the trailers, which never needed the database, are still there.
    const body = git(top, "log", "--format=%B", "-1");
    expect(body).toContain("Co-Authored-By: claude-sonnet-5");
    expect(body).toContain(`Minima-Run-Id: ${runId}`);
  });

  test("the reader says the ledger is off rather than reporting an unknown commit", () => {
    const db = freshDb();
    const report = whyCommitReport(db, "abc1234", false);
    expect(report).toContain("MINIMA_TUI_COMMIT_LEDGER=0");
    expect(report).not.toContain("No ledger entry");
  });
});
