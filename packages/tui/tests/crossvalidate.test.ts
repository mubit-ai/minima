import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AssistantMessage, type Model, text } from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  buildWriterContext,
  collectRunDiff,
  crossValidate,
  formatCrossValidateReport,
  headSha,
  recordCrossValidationObjection,
  writerObjective,
} from "../src/minima/index.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";

// /crossvalidation: one model writes, a DIFFERENT one reviews, the writer answers once.
// What is load-bearing — the writer's routing is restricted to the chosen id, a fix pass
// fires only on a real objection and only once, and no reviewer failure can be read as one.

const REVIEWER: Model = {
  id: "reviewer-1",
  provider: "faux",
  api: "faux",
  name: "Reviewer",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

/** Replies in order; the last one repeats so an over-eager loop cannot run off the end. */
function replies(...texts: string[]) {
  const seen: string[] = [];
  let i = 0;
  const fn = (async (_m: Model, ctx: { messages: { content: unknown }[] }) => {
    seen.push(JSON.stringify(ctx.messages[0]?.content ?? ""));
    const t = texts[Math.min(i, texts.length - 1)] ?? "";
    i++;
    return new AssistantMessage({ content: [text(t)], stop_reason: "stop" });
  }) as never;
  return { fn, seen, calls: () => i };
}

function spawner(outcome: ChildResult["outcome"] = "success") {
  const seen: Delegation[] = [];
  const fn: SpawnFn = async (d) => {
    seen.push(d);
    return {
      step_id: d.step_id,
      childId: `c${seen.length}`,
      text: `did: ${d.step_id}`,
      costUsd: 0.01,
      quality: null,
      outcome,
      workdir: null,
    };
  };
  return { fn, seen };
}

const base = (over: Partial<Parameters<typeof crossValidate>[0]> = {}) => ({
  task: "make the pipe drain",
  writerId: "writer-1",
  reviewer: REVIEWER,
  collectDiff: () => "diff --git a/x b/x\n+drained",
  ...over,
});

describe("crossvalidate — the loop", () => {
  test("approval on the first pass: one review, no fix spawn", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: approve");
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    expect(sp.seen.map((d) => d.step_id)).toEqual(["crossvalidate"]);
    expect(rv.calls()).toBe(1);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]?.verdict?.objects).toBe(false);
    expect(r.rounds[0]?.fix).toBeNull();
  });

  test("the writer's routing is restricted to the chosen id, and the reviewer sees the task", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: approve");
    await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    expect(sp.seen[0]?.candidates).toEqual(["writer-1"]);
    expect(rv.seen[0]).toContain("make the pipe drain");
    expect(rv.seen[0]).toContain("+drained");
  });

  test("objection spawns exactly one fix pass carrying the concerns, then re-reviews", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: object\nCONCERNS:\n- console.log left in\n", "VERDICT: approve");
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    expect(sp.seen.map((d) => d.step_id)).toEqual(["crossvalidate", "crossvalidate:fix"]);
    expect(sp.seen[1]?.objective).toContain("console.log left in");
    expect(sp.seen[1]?.candidates).toEqual(["writer-1"]);
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]?.fix).not.toBeNull();
    expect(r.rounds[1]?.verdict?.objects).toBe(false);
  });

  test("a reviewer that keeps objecting still gets only ONE fix pass", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: object\nCONCERNS:\n- still broken\n");
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    expect(sp.seen.filter((d) => d.step_id === "crossvalidate:fix")).toHaveLength(1);
    expect(rv.calls()).toBe(2);
    expect(r.rounds.at(-1)?.verdict?.objects).toBe(true);
    expect(formatCrossValidateReport(r, "writer-1", "reviewer-1")).toContain("still standing");
  });

  test("an unusable reply is a skip — never a fabricated objection, never a fix pass", async () => {
    const sp = spawner();
    const rv = replies("looks fine to me!");
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    expect(sp.seen.map((d) => d.step_id)).toEqual(["crossvalidate"]);
    expect(r.rounds[0]?.verdict).toBeNull();
    expect(r.rounds[0]?.skipped).toBe("unparsed");
  });

  test("a reviewer that never ran is reported as UNREVIEWED, not as a rambling one", async () => {
    const sp = spawner();
    const dead = (async () => {
      throw new Error("401 no api key");
    }) as never;
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: dead });

    expect(r.rounds[0]?.skipped).toBe("error");
    const report = formatCrossValidateReport(r, "writer-1", "reviewer-1");
    expect(report).toContain("NEVER RAN");
    expect(report).toContain("NOT cross-validated");
    // The one thing this must never read as: a clean bill of health.
    expect(report).not.toContain("approved");
  });

  test("child spend is totalled for the budget ledger, writer + every fix pass", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: object\nCONCERNS:\n- x\n", "VERDICT: approve");
    const r = await crossValidate({ ...base(), spawn: sp.fn, completeFn: rv.fn });

    // spawner() bills 0.01 per child: the writer plus one fix pass.
    expect(r.childCostUsd).toBeCloseTo(0.02, 10);
  });

  test("a writer that changed nothing is not reviewed at all", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: object\nCONCERNS:\n- nope\n");
    const r = await crossValidate({
      ...base({ collectDiff: () => "" }),
      spawn: sp.fn,
      completeFn: rv.fn,
    });

    expect(rv.calls()).toBe(0);
    expect(r.emptyDiff).toBe(true);
    expect(formatCrossValidateReport(r, "writer-1", "reviewer-1")).toContain(
      "no changes to review",
    );
  });

  test("reviewer spend books through onCostUsd and lands in the report total", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: approve");
    const booked: number[] = [];
    const r = await crossValidate({
      ...base(),
      spawn: sp.fn,
      completeFn: rv.fn,
      onCostUsd: (u) => booked.push(u),
    });

    expect(booked).toHaveLength(1);
    expect(r.reviewCostUsd).toBe(booked[0] as number);
  });
});

describe("crossvalidate — the writer's context", () => {
  const turns = [
    { role: "user", text: "the dashboard pipe never drains" },
    { role: "assistant", text: "right — readable is never consumed" },
    { role: "tool", text: "bash: exit 0" },
    { role: "user", text: "/model claude-opus-4-8" },
  ];

  test("the conversation tail reaches the WRITER and never the reviewer", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: approve");
    await crossValidate({
      ...base({ task: "fix the bug we just discussed" }),
      spawn: sp.fn,
      completeFn: rv.fn,
      context: buildWriterContext(turns),
    });

    expect(sp.seen[0]?.objective).toContain("never drains");
    expect(sp.seen[0]?.objective).toContain("fix the bug we just discussed");
    // Independence is the command. Priming the reviewer with the writer's conversation
    // would make it the writer with extra steps.
    expect(rv.seen[0]).not.toContain("never drains");
  });

  test("tool rows and slash-command echoes are not conversation", () => {
    const ctx = buildWriterContext(turns);
    expect(ctx).toContain("never drains");
    expect(ctx).not.toContain("exit 0");
    expect(ctx).not.toContain("/model");
  });

  test("no conversation → the objective is the bare task, unchanged", () => {
    expect(buildWriterContext([])).toBe("");
    expect(writerObjective("do the thing")).toBe("do the thing");
  });

  test("the fix pass keeps the resolved objective, not the bare task line", async () => {
    const sp = spawner();
    const rv = replies("VERDICT: object\nCONCERNS:\n- x\n", "VERDICT: approve");
    await crossValidate({
      ...base({ task: "fix the bug we just discussed" }),
      spawn: sp.fn,
      completeFn: rv.fn,
      context: buildWriterContext(turns),
    });

    expect(sp.seen[1]?.objective).toContain("never drains");
  });
});

describe("crossvalidate — the gates ledger", () => {
  function fixture(withPlan: boolean) {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj");
    const runId = db.startRun({ projectKey: "proj" });
    if (withPlan) db.upsertPlanFromTodos(runId, [{ content: "ship it", status: "completed" }]);
    return { db, runId };
  }

  test("a surviving objection writes ONE yellow judge milestone gate carrying the concerns", () => {
    const { db, runId } = fixture(true);
    const id = recordCrossValidationObjection(db, runId, ["console.log left in"], "reviewer-1");
    expect(id).not.toBeNull();

    const planId = db.getActivePlan(runId)!.id;
    const gates = db.getGates(planId);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.confidence).toBe("yellow");
    expect(gates[0]?.verified_by).toBe("judge");
    const factors = JSON.parse(String(gates[0]?.factors_json));
    expect(factors.crossvalidation).toBe(true);
    expect(factors.concerns).toEqual(["console.log left in"]);
  });

  test("approval and no-plan write nothing — a reviewer can never mint positive evidence", () => {
    const withPlan = fixture(true);
    expect(recordCrossValidationObjection(withPlan.db, withPlan.runId, [], "r")).toBeNull();
    expect(db_gateCount(withPlan)).toBe(0);

    const noPlan = fixture(false);
    expect(
      recordCrossValidationObjection(noPlan.db, noPlan.runId, ["real concern"], "r"),
    ).toBeNull();
  });

  function db_gateCount(f: { db: MinimaDb; runId: string }): number {
    const plan = f.db.getActivePlan(f.runId);
    return plan ? f.db.getGates(plan.id).length : 0;
  }
});

describe("collectRunDiff — what the reviewer can actually see", () => {
  function repo() {
    const top = mkdtempSync(join(tmpdir(), "xval-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: top });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(top, "kept.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    return { top, git };
  }

  test("a brand-new file is in the diff (git diff alone cannot see it)", () => {
    const { top } = repo();
    expect(collectRunDiff(top, null)).toBeNull();

    writeFileSync(join(top, "brand_new.ts"), "export const x = 1;\n");
    const diff = collectRunDiff(top, null);
    expect(diff).toContain("brand_new.ts");
    expect(diff).toContain("export const x = 1;");
  });

  test("a change the writer COMMITTED is still in the diff when based on the pre-run sha", () => {
    const { top, git } = repo();
    const baseSha = headSha(top);
    expect(baseSha).not.toBeNull();

    writeFileSync(join(top, "kept.txt"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-qm", "the writer committed its own work");

    // The bug this pins: HEAD-relative sees a clean tree and reports "nothing to review".
    expect(collectRunDiff(top, null)).toBeNull();
    expect(collectRunDiff(top, baseSha)).toContain("+two");
  });
});
