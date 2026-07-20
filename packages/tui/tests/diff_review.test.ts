import { describe, expect, test } from "bun:test";
import { AssistantMessage, type Model, text } from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { collectRunDiff, parseDiffReviewVerdict, runDiffReview } from "../src/minima/index.ts";

// E1 zero-context diff reviewer: parse edges + the trust-ladder gate semantics —
// objection → one yellow judge milestone gate; approval/skip → nothing written.

const META: Model = {
  id: "meta",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

const reply = (t: string) =>
  (async () => new AssistantMessage({ content: [text(t)], stop_reason: "endTurn" })) as never;

function planFixture() {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  db.upsertPlanFromTodos(runId, [{ content: "ship it", status: "completed" }]);
  const planId = db.getActivePlan(runId)!.id;
  return { db, runId, planId };
}

describe("diff review — parsing", () => {
  test("approve / object / concerns / unusable", () => {
    expect(parseDiffReviewVerdict("VERDICT: approve")).toEqual({ objects: false, concerns: [] });
    const obj = parseDiffReviewVerdict(
      "VERDICT: object\nCONCERNS:\n- test_foo deleted without replacement\n- console.log left in the handler",
    );
    expect(obj?.objects).toBe(true);
    expect(obj?.concerns).toEqual([
      "test_foo deleted without replacement",
      "console.log left in the handler",
    ]);
    expect(parseDiffReviewVerdict("looks good to me!")).toBeNull();
  });
});

describe("diff review — gate semantics", () => {
  test("objection writes ONE yellow judge milestone gate carrying the concerns", async () => {
    const { db, runId, planId } = planFixture();
    const booked: number[] = [];
    const outcome = await runDiffReview({
      db,
      sessionId: runId,
      planId,
      metaModel: META,
      diff: "diff --git a/x b/x\n-assert x\n+// assert x",
      onCostUsd: (usd) => booked.push(usd),
      completeFn: reply("VERDICT: object\nCONCERNS:\n- assertion commented out"),
    });
    expect(outcome?.verdict.objects).toBe(true);
    expect(outcome?.gateId).not.toBeNull();
    expect(booked).toHaveLength(1);
    const gates = db.getGates(planId).filter((g) => g.kind === "milestone");
    expect(gates).toHaveLength(1);
    const gate = gates[0]!;
    expect(gate.outcome).toBe("verified"); // concerns, not a refutation — never a failure
    expect(gate.confidence).toBe("yellow");
    expect(gate.verified_by).toBe("judge");
    expect(JSON.parse(gate.factors_json ?? "{}")).toMatchObject({
      diff_review: true,
      concerns: ["assertion commented out"],
    });
  });

  test("approval writes nothing — the reviewer can never mint positive evidence", async () => {
    const { db, runId, planId } = planFixture();
    const outcome = await runDiffReview({
      db,
      sessionId: runId,
      planId,
      metaModel: META,
      diff: "diff --git a/x b/x\n+fine",
      completeFn: reply("VERDICT: approve"),
    });
    expect(outcome?.verdict.objects).toBe(false);
    expect(outcome?.gateId).toBeNull();
    expect(db.getGates(planId)).toHaveLength(0);
  });

  test("unusable reply / empty diff / no model / abort all skip without writing", async () => {
    const { db, runId, planId } = planFixture();
    const base = { db, sessionId: runId, planId, metaModel: META };
    expect(
      await runDiffReview({ ...base, diff: "d", completeFn: reply("hard to say really") }),
    ).toBeNull();
    expect(
      await runDiffReview({ ...base, diff: "", completeFn: reply("VERDICT: approve") }),
    ).toBeNull();
    expect(
      await runDiffReview({
        ...base,
        metaModel: null,
        diff: "d",
        completeFn: reply("VERDICT: approve"),
      }),
    ).toBeNull();
    const ac = new AbortController();
    ac.abort();
    expect(
      await runDiffReview({
        ...base,
        diff: "d",
        signal: ac.signal,
        completeFn: reply("VERDICT: approve"),
      }),
    ).toBeNull();
    expect(db.getGates(planId)).toHaveLength(0);
  });
});

describe("diff review — collectRunDiff", () => {
  test("returns null outside a git repository", () => {
    expect(collectRunDiff("/tmp", null)).toBeNull();
  });
});
