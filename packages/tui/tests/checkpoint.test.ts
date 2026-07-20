import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentState } from "../src/agent/agent.ts";
import type { BeforeToolCallContext } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  detectRepo,
  gcCheckpoints,
  makeCheckpointHook,
  restore,
  snapshot,
} from "../src/session/checkpoint.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-ckpt-"));
  dirs.push(dir);
  Bun.spawnSync(["git", "init", dir]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "test@test.local"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "Test"]);
  Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

function db3(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  return { db, runId };
}

const porcelain = (top: string) =>
  Bun.spawnSync(["git", "-C", top, "status", "--porcelain"]).stdout.toString();

function ctx(tool: string): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id: "t1", name: tool, arguments: {} },
    args: {},
    context: {} as AgentState,
  };
}

describe("detectRepo (B3.3)", () => {
  test("git repo → toplevel; plain dir → null", () => {
    const repo = tempRepo();
    const top = detectRepo(repo);
    expect(
      top && Bun.spawnSync(["git", "-C", top, "rev-parse", "--is-inside-work-tree"]).exitCode,
    ).toBe(0);
    const plain = mkdtempSync(join(tmpdir(), "minima-nogit-"));
    dirs.push(plain);
    expect(detectRepo(plain)).toBeNull();
  });
});

describe("snapshot (B3.1)", () => {
  test("writes ref + mapping row; user's index/worktree untouched", () => {
    const top = tempRepo();
    const { db, runId } = db3();
    writeFileSync(join(top, "a.txt"), "one\n");
    writeFileSync(join(top, "untracked.txt"), "loose\n");
    const before = porcelain(top);

    const row = snapshot({ top, db, runId, promptOrdinal: 0 });
    if (!row) throw new Error("snapshot failed");
    expect(row.prompt_ordinal).toBe(0);
    expect(row.kind).toBe("turn");
    expect(porcelain(top)).toBe(before); // index + worktree untouched
    const refOut = Bun.spawnSync([
      "git",
      "-C",
      top,
      "for-each-ref",
      "--format=%(refname)",
      "refs/minima/ckpt/",
    ])
      .stdout.toString()
      .trim();
    expect(refOut).toBe(row.ref);
    // B3.2 mapping: the ledger row joins ref ↔ run ↔ prompt ordinal ↔ step.
    const listed = db.listCheckpoints(runId);
    expect(listed.length).toBe(1);
    expect(listed[0]!.commit_sha).toBe(row.commit_sha);
  });

  test("dedupe: unchanged tree returns the previous row, no ref churn", () => {
    const top = tempRepo();
    const { db, runId } = db3();
    writeFileSync(join(top, "a.txt"), "one\n");
    const first = snapshot({ top, db, runId, promptOrdinal: 0 });
    const second = snapshot({ top, db, runId, promptOrdinal: 1 });
    expect(second?.id).toBe(first?.id);
    expect(db.listCheckpoints(runId).length).toBe(1);
  });

  test("works in a repo with no commits (unborn HEAD)", () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-ckpt-unborn-"));
    dirs.push(dir);
    Bun.spawnSync(["git", "init", dir]);
    writeFileSync(join(dir, "f.txt"), "x\n");
    const { db, runId } = db3();
    const row = snapshot({ top: dir, db, runId, promptOrdinal: 0 });
    expect(row).not.toBeNull();
  });

  test("step attribution lands on the row (B3.2)", () => {
    const top = tempRepo();
    const { db, runId } = db3();
    const { stepIds } = db.upsertPlanFromTodos(
      runId,
      [{ content: "s", status: "in_progress" }],
      "T",
    );
    writeFileSync(join(top, "a.txt"), "one\n");
    const row = snapshot({ top, db, runId, promptOrdinal: 0, stepId: stepIds[0] });
    expect(row?.step_id).toBe(stepIds[0]!);
  });
});

describe("restore (B3.1 round trip)", () => {
  test("byte-identical: modified restored, created deleted, deleted resurrected, ignored untouched — and the safety snapshot undoes the undo", () => {
    const top = tempRepo();
    const { db, runId } = db3();
    writeFileSync(join(top, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(top, "ignored.txt"), "keep me\n");
    writeFileSync(join(top, "a.txt"), "one\n");
    mkdirSync(join(top, "sub"));
    writeFileSync(join(top, "sub", "c.txt"), "old\n");
    writeFileSync(join(top, "x.sh"), "#!/bin/sh\n");
    chmodSync(join(top, "x.sh"), 0o755);

    const ckpt = snapshot({ top, db, runId, promptOrdinal: 0 });
    if (!ckpt) throw new Error("snapshot failed");

    // Mutate like an agent turn: modify, create (incl. new dir), delete, de-exec.
    writeFileSync(join(top, "a.txt"), "two\n");
    mkdirSync(join(top, "newdir"));
    writeFileSync(join(top, "newdir", "b.txt"), "new\n");
    rmSync(join(top, "sub", "c.txt"));
    chmodSync(join(top, "x.sh"), 0o644);

    const result = restore({ top, db, runId, targetTreeSha: ckpt.tree_sha });
    if (!result) throw new Error("restore failed");
    expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(top, "newdir", "b.txt"))).toBe(false);
    expect(existsSync(join(top, "newdir"))).toBe(false); // empty parent pruned
    expect(readFileSync(join(top, "sub", "c.txt"), "utf8")).toBe("old\n");
    expect(readFileSync(join(top, "ignored.txt"), "utf8")).toBe("keep me\n");
    // worktree exec bit restored (stat, not index — the user's index is untouched by design)
    expect(statSync(join(top, "x.sh")).mode & 0o111).not.toBe(0);

    // The safety snapshot captured the pre-restore state: restoring IT undoes the undo.
    expect(result.safety?.kind).toBe("safety");
    const back = restore({ top, db, runId, targetTreeSha: result.safety!.tree_sha });
    if (!back) throw new Error("second restore failed");
    expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(top, "newdir", "b.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(top, "sub", "c.txt"))).toBe(false);
  });
});

describe("gcCheckpoints (B3.3)", () => {
  test("prunes old runs' refs + rows, keeps the current run", () => {
    const top = tempRepo();
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const oldRun = db.startRun({ projectKey: "p" });
    const curRun = db.startRun({ projectKey: "p" });
    writeFileSync(join(top, "a.txt"), "one\n");
    snapshot({ top, db, runId: oldRun, promptOrdinal: 0 });
    writeFileSync(join(top, "a.txt"), "two\n");
    snapshot({ top, db, runId: curRun, promptOrdinal: 0 });

    const pruned = gcCheckpoints({ top, db, currentRunId: curRun, keepRuns: 0 });
    expect(pruned).toBe(1);
    expect(db.listCheckpoints(oldRun).length).toBe(0);
    expect(db.listCheckpoints(curRun).length).toBe(1);
    const refs = Bun.spawnSync([
      "git",
      "-C",
      top,
      "for-each-ref",
      "--format=%(refname)",
      "refs/minima/ckpt/",
    ])
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(refs.length).toBe(1);
    expect(refs[0]!).toContain(curRun);
  });
});

describe("makeCheckpointHook (B3 trigger)", () => {
  test("first mutating call per arm snapshots once; read-only calls never do", async () => {
    const top = tempRepo();
    const { db, runId } = db3();
    writeFileSync(join(top, "a.txt"), "one\n");
    const { arm, hook } = makeCheckpointHook({ top, db, getRunId: () => runId });

    expect(await hook(ctx("write"))).toBeNull(); // not armed yet
    expect(db.listCheckpoints(runId).length).toBe(0);

    arm();
    expect(await hook(ctx("read"))).toBeNull(); // read-only: stays armed
    expect(db.listCheckpoints(runId).length).toBe(0);
    expect(await hook(ctx("write"))).toBeNull(); // never blocks
    expect(db.listCheckpoints(runId).length).toBe(1);
    await hook(ctx("bash")); // disarmed — same prompt, no second snapshot
    expect(db.listCheckpoints(runId).length).toBe(1);

    writeFileSync(join(top, "a.txt"), "two\n");
    arm();
    await hook(ctx("task")); // task counts as mutating (hook-free children can write)
    expect(db.listCheckpoints(runId).length).toBe(2);
  });

  test("non-git dir → one-time notice, never a snapshot, never a block", async () => {
    const { db, runId } = db3();
    const notices: string[] = [];
    const { arm, hook } = makeCheckpointHook({
      top: null,
      db,
      getRunId: () => runId,
      notify: (m) => notices.push(m),
    });
    arm();
    expect(await hook(ctx("write"))).toBeNull();
    arm();
    expect(await hook(ctx("edit"))).toBeNull();
    expect(notices.length).toBe(1);
    expect(notices[0]!).toContain("not a git repository");
    expect(db.listCheckpoints(runId).length).toBe(0);
  });
});
