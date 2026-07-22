import { describe, expect, test } from "bun:test";
import { AgentState } from "../src/agent/state.ts";
import { AssistantMessage, Message, text } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { assessStop, isHarnessSteerText, makeStopGate } from "../src/minima/stop_gate.ts";
import type { AskUserRef } from "../src/tools/question.ts";

const SESSION = "run-1";

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

/** Seed an active plan; each entry is a step {status, gate?} where gate is a per-step outcome. */
function seed(
  d: MinimaDb,
  steps: Array<{ status: string; gates?: Array<"verified" | "failed" | "unrunnable"> }>,
) {
  const { planId, stepIds } = d.upsertPlanFromTodos(
    SESSION,
    steps.map((s, i) => ({ content: `step ${i}`, status: s.status, verify: "bun test" })),
    "Plan",
  );
  steps.forEach((s, i) => {
    for (const outcome of s.gates ?? []) {
      d.insertGate({ planId, stepId: stepIds[i], outcome, verifiedBy: "deterministic" });
    }
  });
  return { planId, stepIds };
}

/** A settled terminal turn (agent produced text, no tool calls). */
function terminalTurn(): AssistantMessage {
  return new AssistantMessage({ content: [text("all done!")] });
}

/** A settled turn that still requested tools. */
function toolTurn(): AssistantMessage {
  return new AssistantMessage({ content: [text("working")], stop_reason: "toolUse" });
}

describe("assessStop", () => {
  test("no db / no session → not blocked", () => {
    expect(assessStop(null, SESSION).blocked).toBe(false);
    expect(assessStop(db(), null).blocked).toBe(false);
  });

  test("no active plan → not blocked", () => {
    expect(assessStop(db(), SESSION).blocked).toBe(false);
  });

  test("all steps completed + verified → not blocked", () => {
    const d = db();
    seed(d, [
      { status: "completed", gates: ["verified"] },
      { status: "completed", gates: ["verified"] },
    ]);
    expect(assessStop(d, SESSION)).toMatchObject({ blocked: false, incomplete: 0, redSteps: 0 });
  });

  test("an incomplete step blocks", () => {
    const d = db();
    seed(d, [{ status: "completed", gates: ["verified"] }, { status: "in_progress" }]);
    const a = assessStop(d, SESSION);
    expect(a.blocked).toBe(true);
    expect(a.incomplete).toBe(1);
    expect(a.reasons.join("\n")).toContain("step 2/2 not complete");
  });

  test("a completed step whose latest gate failed blocks", () => {
    const d = db();
    seed(d, [{ status: "completed", gates: ["failed"] }]);
    const a = assessStop(d, SESSION);
    expect(a.blocked).toBe(true);
    expect(a.redSteps).toBe(1);
    expect(a.reasons.join("\n")).toContain("check failing");
  });

  test("latest gate wins: failed→verified does not block", () => {
    const d = db();
    seed(d, [{ status: "completed", gates: ["failed", "verified"] }]);
    expect(assessStop(d, SESSION).blocked).toBe(false);
  });

  test("unrunnable is not a block (environment error, conservative)", () => {
    const d = db();
    seed(d, [{ status: "completed", gates: ["unrunnable"] }]);
    expect(assessStop(d, SESSION)).toMatchObject({ blocked: false, redSteps: 0 });
  });

  test("a stale older active does not block when a newer plan is done (MUB-181)", () => {
    const d = db();
    const stale = d.insertPlan({ sessionId: SESSION, title: "old", status: "active" });
    d.insertStep({ planId: stale, idx: 0, content: "old step", status: "in_progress" });
    const current = d.insertPlan({ sessionId: SESSION, title: "current", status: "done" });
    d.insertStep({ planId: current, idx: 0, content: "new step", status: "completed" });
    expect(assessStop(d, SESSION).blocked).toBe(false);
  });

  test("the latest active still blocks even with an older done plan present", () => {
    const d = db();
    const olderDone = d.insertPlan({ sessionId: SESSION, title: "done earlier", status: "done" });
    d.insertStep({ planId: olderDone, idx: 0, content: "done step", status: "completed" });
    seed(d, [{ status: "in_progress" }]);
    expect(assessStop(d, SESSION).blocked).toBe(true);
  });
});

describe("makeStopGate", () => {
  const deps = (d: MinimaDb, maxStrikes: number, askUser: AskUserRef | null = null) => ({
    db: d,
    sessionId: SESSION,
    agentId: null,
    maxStrikes,
    askUser,
  });

  test("maxStrikes 0 disables the gate (returns false, no follow-up)", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 0));
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0);
  });

  test("a tool turn is never a stop attempt, even when blocked", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    expect(await gate(toolTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0);
  });

  test("a done plan allows the natural stop", async () => {
    const d = db();
    seed(d, [{ status: "completed", gates: ["verified"] }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0);
  });

  test("denies each stop attempt while strikes remain, one follow-up each", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    for (let i = 0; i < 3; i++) {
      expect(await gate(terminalTurn(), [], state)).toBe(false);
    }
    expect(state.followUp).toHaveLength(3);
    expect((state.followUp[0]!.content[0] as { text: string }).text).toContain("plan is not done");
    expect((state.followUp[2]!.content[0] as { text: string }).text).toContain("attempt 3 of 3");
  });

  test("strikes spent, headless → stops and writes one audit 'stop' gate", async () => {
    const d = db();
    const { planId } = seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 2, null));
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(false); // strike 2
    expect(await gate(terminalTurn(), [], state)).toBe(true); // exhausted → stop
    const stopGates = d.getGates(planId).filter((g) => g.kind === "stop");
    expect(stopGates).toHaveLength(1);
    expect(stopGates[0]!.outcome).toBe("unchecked");
    expect(stopGates[0]!.confidence).toBe("red");
    expect(stopGates[0]!.verified_by).toBeNull();
    expect(stopGates[0]!.rec_id).toBeNull(); // invisible to the feedback join by construction
  });

  test("strikes spent, user 'keep going' → resets and denies again", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = { current: async () => "keep going" };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false); // strike 1 (deny)
    expect(await gate(terminalTurn(), [], state)).toBe(false); // exhausted → asked → keep going
    // strikes reset: the NEXT stop attempt is denied again, not an immediate stop
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp.length).toBeGreaterThanOrEqual(3);
  });

  test("once the step-cap wrap fired, a stop attempt is SKIPPED — no ⛔, no stop (R5c)", async () => {
    // The anti-spiral just told the model "wrap up NOW"; a ⛔ "keep working" the same rung
    // would whipsaw it. The shared per-rung flag (threaded in runtime.ts) suppresses the strike.
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate({ ...deps(d, 3), capWrapFired: () => true });
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0);
  });

  test("a cap-skipped stop attempt is not COUNTED as a strike (R5c)", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    let fired = true;
    const gate = makeStopGate({ ...deps(d, 3), capWrapFired: () => fired });
    const state = new AgentState();
    expect(await gate(terminalTurn(), [], state)).toBe(false); // skipped, not spent
    expect(state.followUp).toHaveLength(0);
    fired = false;
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(1);
    expect((state.followUp[0]!.content[0] as { text: string }).text).toContain("attempt 1 of 3");
  });

  test("strikes spent, user 'accept as done' → stops", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = { current: async () => "accept as done" };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(true);
  });

  test("strikes spent, free-text answer → treated as a steer, run continues", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = { current: async () => "focus on the failing auth test first" };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    const last = state.followUp[state.followUp.length - 1]!;
    expect((last.content[0] as { text: string }).text).toContain("steered");
    expect((last.content[0] as { text: string }).text).toContain("failing auth test");
  });

  test("strikes spent, dismissed (null) → stops", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = { current: async () => null };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(true);
  });

  // Only the EXACT option labels count as a pick; free text is a steer, never a mis-read stop.
  test("free text starting with 'accept' is a steer (not a stop), instruction preserved", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = {
      current: async () => "accept the auth approach but finish the billing step",
    };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(false); // continues, not ends
    const last = state.followUp[state.followUp.length - 1]!;
    expect((last.content[0] as { text: string }).text).toContain("steered");
    expect((last.content[0] as { text: string }).text).toContain("billing step");
  });

  test("free text starting with 'keep' is a steer carrying the instruction (not a generic nudge)", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const ask: AskUserRef = { current: async () => "keep step 1 but rewrite step 3" };
    const gate = makeStopGate(deps(d, 1, ask));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    const last = state.followUp[state.followUp.length - 1]!;
    expect((last.content[0] as { text: string }).text).toContain("rewrite step 3");
  });

  test("a question answered in the prior tool turn suppresses the strike (one-shot)", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    const answered = [{ details: { answered: true, answer: "continue chatting" } }];
    expect(await gate(toolTurn(), answered, state)).toBe(false);
    // The conversational reply right after the answer may end the turn — no strike.
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0);
    // One-shot: the NEXT bare stop attempt is denied again.
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(1);
  });

  test("a dismissed question does not suppress the gate", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    const dismissed = [{ details: { answered: false, reason: "dismissed" } }];
    expect(await gate(toolTurn(), dismissed, state)).toBe(false);
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(1);
  });

  test("an intervening tool turn clears the answer suppression", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    const answered = [{ details: { answered: true, answer: "go on" } }];
    expect(await gate(toolTurn(), answered, state)).toBe(false);
    expect(await gate(toolTurn(), [], state)).toBe(false);
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(1);
  });

  test("queued steering defers to the loop without spending a strike", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 1));
    const state = new AgentState();
    state.steering.push(new Message({ role: "user", content: [text("do X instead")] }));
    // Even though strikes==maxStrikes-worth of headroom exists, queued steering short-circuits.
    expect(await gate(terminalTurn(), [], state)).toBe(false);
    expect(state.followUp).toHaveLength(0); // no continuation pushed; strike not spent
  });
});

// R3b: harness-authored user-role steering renders as a dim compact system line — the model
// still sees the FULL text; only the transcript projection compacts. The predicate must stay
// in lockstep with the actual producers, so it is fed their real output here.
describe("isHarnessSteerText (R3b)", () => {
  const deps = (d: MinimaDb, maxStrikes: number) => ({
    db: d,
    sessionId: SESSION,
    agentId: null,
    maxStrikes,
    askUser: null,
  });

  test("matches the stop-gate's real continuation message", async () => {
    const d = db();
    seed(d, [{ status: "in_progress" }]);
    const gate = makeStopGate(deps(d, 3));
    const state = new AgentState();
    await gate(terminalTurn(), [], state); // strike 1 → ⛔ follow-up
    const text = (state.followUp[0]!.content[0] as { text: string }).text;
    expect(isHarnessSteerText(text)).toBe(true);
  });

  test("does NOT match ordinary user text or the user-steer relay (user words stay a ▸ you bubble)", () => {
    expect(isHarnessSteerText("please fix the footer first")).toBe(false);
    expect(
      isHarnessSteerText("The user reviewed the unfinished plan and steered:\nfocus on auth"),
    ).toBe(false);
  });
});
