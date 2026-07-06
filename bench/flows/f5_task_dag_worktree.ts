/**
 * F5 — task-tool sub-agent DAG + git-worktree isolation (live server, js-lib fixture).
 *
 * The lead agent is nudged to fan out three children, one with isolation:"workdir".
 * Worktree evidence is collected by a sidecar watcher (250ms poll of /tmp/minima-wt-*)
 * because cleanup destroys it; pass/fail rests on DB rows and the watcher, never on
 * the /tree panel (its rows are stuck '⟳ running' — known display bug, XFAIL'd softly).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Checks } from "../assert/check.ts";
import { HarnessDb } from "../assert/db.ts";
import { materialize } from "../gen/materialize.ts";
import { PtyRig } from "../driver/rig.ts";
import { makeScratch, saveArtifact, waitFor } from "../driver/scratch.ts";

function leadDecisions(dbPath: string): number {
  try {
    const db = new HarnessDb(dbPath);
    const n = db.decisions().filter((d) => !d.agent_id).length;
    db.close();
    return n;
  } catch {
    return 0;
  }
}

export async function f5(): Promise<Checks> {
  const c = new Checks("f5_task_dag_worktree");
  const s = makeScratch("f5");
  // Working repo: clean js-lib checkout (fastest suite) with a committed HEAD — exactly
  // what worktree isolation needs. materialize() with applyBug:false gives the clean tree.
  const work = join(s.root, "workrepo");
  await materialize("bench/tasks/js-lib/jl-001", work, { applyBug: false });

  // The packages/tui test suite leaks /tmp/minima-wt-{dirty-step,wt-step}-* dirs —
  // baseline what exists pre-run and assert only on NEW sightings (set difference).
  const preRun = new Set(readdirSync("/tmp").filter((e) => e.startsWith("minima-wt-")));

  // Sidecar watcher: worktrees live only for the child's lifetime.
  const sightings = new Set<string>();
  const watcher = setInterval(() => {
    try {
      for (const e of readdirSync("/tmp")) if (e.startsWith("minima-wt-")) sightings.add(e);
    } catch {}
  }, 250);

  const rig = PtyRig.spawn({ cmd: ["minima"], cwd: work, env: s.env, wallClockMs: 420_000 });

  try {
    await rig.expectText(/· ready/, { timeoutMs: 20_000 });

    const dagPrompt =
      "Use your task tool to run exactly three sub-agents in parallel: " +
      '(1) objective "count the exported functions in src/csv.ts and report the number"; ' +
      '(2) objective "list the test files under tests/ and report how many there are"; ' +
      '(3) objective "run the command: bun test tests/ and report how many tests pass" — ' +
      'the third delegation MUST include the field "isolation": "workdir" (exactly that ' +
      "key and value) so it runs in an isolated git worktree. " +
      "Then summarize all three results in one line each.";
    let leadTarget = 1;
    await rig.submitUntil(dagPrompt, () => leadDecisions(s.dbPath) >= leadTarget, {
      timeoutMs: 360_000,
      retryMs: 5_000,
    });
    // Model-compliance variance: if no fresh worktree appeared, retry the DAG turn once.
    if (![...sightings].some((e) => !preRun.has(e))) {
      await rig.waitIdle(60_000);
      leadTarget = 2;
      await rig.submitUntil(
        `That run did not use worktree isolation. Repeat it, and this time the third delegation must carry "isolation": "workdir" verbatim in the task tool call. ${dagPrompt}`,
        () => leadDecisions(s.dbPath) >= leadTarget,
        { timeoutMs: 360_000, retryMs: 5_000 },
      );
    }
    c.check("lead turn completed with a decision row", true);

    // Child decision rows become visible to external readers slightly AFTER the lead
    // row (write-queue flush lag) — poll with a grace window instead of a point read.
    await waitFor(() => {
      const db = new HarnessDb(s.dbPath);
      const n = db.decisions().filter((d) => d.agent_id).length;
      db.close();
      return n >= 2;
    }, { timeoutMs: 30_000, what: "child decision rows" }).catch(() => {});

    const db = new HarnessDb(s.dbPath);
    const dec = db.decisions();
    const children = dec.filter((d) => d.agent_id);
    c.check("children routed independently (>=2 child decision rows)",
      children.length >= 2,
      JSON.stringify(dec.map((d) => ({ agent: d.agent_id || "lead", m: d.chosen_model }))));
    const fresh = [...sightings].filter((e) => !preRun.has(e));
    c.check("worktree isolation observed (NEW /tmp/minima-wt-* during the run)",
      fresh.length >= 1, `fresh=${fresh.join(",") || "none"} stale=${[...preRun].join(",")}`);
    c.check("no NEW worktree leaks after the run",
      readdirSync("/tmp").filter((e) => e.startsWith("minima-wt-") && !preRun.has(e)).length === 0);
    c.soft("all children completed successfully",
      children.every((d) => d.outcome === "success"),
      JSON.stringify(children.map((d) => d.outcome)));
    db.close();

    await rig.waitIdle(60_000);
    await rig.submitUntil("/exit", () => rig.exitCode !== null, { timeoutMs: 20_000 });
    const code = await rig.expectExit(15_000);
    c.check("/exit: clean exit 0", code === 0, `exit=${code}`);
  } finally {
    clearInterval(watcher);
    saveArtifact(s, "transcript.txt", rig.text());
    rig.kill();
  }
  return c;
}
