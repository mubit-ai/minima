import { describe, expect, test } from "bun:test";
import { AgentState } from "../src/agent/state.ts";
import { AssistantMessage, Message, text } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { assessStop, makeStopGate } from "../src/minima/stop_gate.ts";
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
