import { beforeEach, describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import type { ConfidenceTier, GateOutcome } from "../src/minima/gt_contract.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
  stepOutcomesFromGates,
} from "../src/minima/index.ts";

// M7.2 under the v6 identity join: a deterministic gate outranks the LLM judge in the feedback
// path ONLY for the rung that minted it (gates.rec_id). The verdict becomes the OUTCOME label
// (never a fabricated quality); verified_in_production is claimed only on a green tier; a stale
// gate from an earlier rec can never poison a later prompt; `unrunnable` is an environment
// error — it falls back to the judge. All hermetic: faux provider + injected fetch.

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

/** A judge that counts its invocations — lets a test prove the judge was skipped. */
function countingJudge(score: number | null) {
  return {
    calls: 0,
    async grade(): Promise<number | null> {
      this.calls += 1;
      return score;
    },
  };
}

/** Mints UNIQUE sequential rec ids (rec-1, rec-2, ...) — identity-scoped code must not pass by
 * accident against a fixed id, and tests can predict the first rung's rec. */
function mockService() {
  const feedbackCalls: Record<string, unknown>[] = [];
  let recSeq = 0;
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      recSeq += 1;
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recSeq}`,
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if (method === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, feedbackCalls };
}

function setup(judge: ReturnType<typeof countingJudge>) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX_MODEL);
  const reg = registerFauxProvider([FAUX_MODEL]);
  reg.setResponses([new AssistantMessage({ content: [text("answer")], stop_reason: "stop" })]);
  const { fetchLike, feedbackCalls } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    groundTruth: true,
    // These tests seed an in_progress step purely as a feedback-path fixture; they are not about
    // the A2 stop-gate, so disable it (its default would force-continue the single-response mock).
    stopStrikes: 0,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  const agent = new MinimaAgent({ config, router, judge, meter: new CostMeter(), tools: [] });
  agent.db = db;
  agent.runId = runId;
  return { agent, reg, feedbackCalls, db, runId };
}

/** Seed one step + a single deterministic gate of the given verdict, minted under `recId`. */
function seedGate(
  db: MinimaDb,
  runId: string,
  outcome: GateOutcome,
  confidence: ConfidenceTier,
  recId = "rec-1",
) {
  const { planId, stepIds } = db.upsertPlanFromTodos(runId, [
    { content: "wire the endpoint", status: "in_progress" },
  ]);
  db.insertGate({
    planId,
    stepId: stepIds[0]!,
    outcome,
    verifiedBy: "deterministic",
    confidence,
    recId,
    sessionId: runId,
  });
}

describe("feedback: deterministic gate outranks the judge (M7.2)", () => {
  let judge: ReturnType<typeof countingJudge>;
  beforeEach(() => {
    judge = countingJudge(0.9);
  });

  test("green gate → success, verified_in_production=true, no fabricated quality, judge skipped", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "verified", "green");

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(1);
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success");
    expect(fb.verified_in_production).toBe(true);
    expect(fb.evidence_source).toBe("gate");
    expect(fb.quality_score).toBeUndefined(); // gate verdict → label only, never a fabricated score
    expect(fb.judged).toBe(false);
    expect(String(fb.notes)).toContain("verified_by=deterministic");
    expect(String(fb.notes)).toContain("tier=green");
    expect(judge.calls).toBe(0); // the judge was NOT consulted
    reg.unregister();
    db.close();
  });

  test("yellow gate (self-written test) → partial (A7 graded), verified_in_production=false", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "verified", "yellow");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    // A7: a passing-but-untrustworthy check is weaker evidence than green — graded to partial.
    expect(fb.outcome).toBe("partial");
    expect(fb.verified_in_production).toBe(false); // agent-authored trust is never ground truth
    expect(fb.evidence_source).toBe("none"); // gameable label stays telemetry
    expect(fb.quality_score).toBeUndefined(); // still no fabricated quality
    expect(String(fb.notes)).toContain("tier=yellow");
    expect(judge.calls).toBe(0); // the gate still outranks the judge
    reg.unregister();
    db.close();
  });

  test("red gate → failure, verified_in_production=false (judge skipped)", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    agent.recoveryRungs = 0; // isolate the feedback assertion from the M7.3 ladder
    seedGate(db, runId, "failed", "red");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("failure");
    expect(fb.verified_in_production).toBe(false);
    expect(fb.quality_score).toBeUndefined();
    expect(judge.calls).toBe(0);
    reg.unregister();
    db.close();
  });

  test("unrunnable gate → environment error, judge path proceeds, no failure feedback", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "unrunnable", "red");

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(1); // no ladder rung was burned
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success");
    expect(fb.quality_score).toBe(0.9); // the judge's grade — unrunnable is not evidence
    expect(fb.verified_in_production).toBe(false);
    expect(judge.calls).toBe(1);
    reg.unregister();
    db.close();
  });

  test("a stale gate from an earlier rec never poisons a later prompt", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    reg.setResponses([
      new AssistantMessage({ content: [text("answer 1")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("answer 2")], stop_reason: "stop" }),
    ]);
    agent.recoveryRungs = 0;
    seedGate(db, runId, "failed", "red"); // minted under rec-1

    await agent.promptRouted("first prompt"); // rec-1: the red gate is THIS rung's verdict
    await agent.promptRouted("second prompt"); // rec-2: the stale red must be invisible

    expect(feedbackCalls).toHaveLength(2);
    const first = feedbackCalls[0] as Record<string, unknown>;
    const second = feedbackCalls[1] as Record<string, unknown>;
    expect(first.outcome).toBe("failure");
    expect(second.outcome).toBe("success");
    expect(second.quality_score).toBe(0.9); // judge path — the gate did not outrank it
    expect(judge.calls).toBe(1); // consulted only for the second prompt
    reg.unregister();
    db.close();
  });

  test("no gate → falls back to the judge (verified_in_production=false)", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    // Active plan but no gate → no grounded verdict → judge path unchanged.
    db.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress" }]);

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success");
    expect(fb.quality_score).toBe(0.9); // the judge's grade, not a gate
    expect(fb.verified_in_production).toBe(false);
    expect(fb.evidence_source).toBe("judge");
    expect(judge.calls).toBe(1); // the judge WAS consulted
    reg.unregister();
    db.close();
  });
});

describe("feedback: gate verdicts ride as step_outcomes (process rewards)", () => {
  let judge: ReturnType<typeof countingJudge>;
  beforeEach(() => {
    judge = countingJudge(0.9);
  });

  test("deterministic gate → step_outcomes on the wire with step identity", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "verified", "green");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    const steps = fb.step_outcomes as { step_id: string; outcome: string; rationale?: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.outcome).toBe("success");
    expect(steps[0]!.step_id.length).toBeGreaterThan(0);
    expect(String(steps[0]!.rationale)).toContain("deterministic");
    reg.unregister();
    db.close();
  });

  test("failed gate → step outcome failure even though turn label is failure too", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    agent.recoveryRungs = 0;
    seedGate(db, runId, "failed", "red");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    const steps = fb.step_outcomes as { outcome: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.outcome).toBe("failure");
    reg.unregister();
    db.close();
  });

  test("no gates → step_outcomes absent (judge turn)", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    db.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress" }]);

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.step_outcomes).toBeUndefined();
    reg.unregister();
    db.close();
  });

  test("a stale gate from an earlier rec contributes no step outcome to a later prompt", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    reg.setResponses([
      new AssistantMessage({ content: [text("answer 1")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("answer 2")], stop_reason: "stop" }),
    ]);
    agent.recoveryRungs = 0;
    seedGate(db, runId, "failed", "red"); // minted under rec-1

    await agent.promptRouted("first prompt");
    await agent.promptRouted("second prompt");

    const second = feedbackCalls[1] as Record<string, unknown>;
    expect(second.step_outcomes).toBeUndefined();
    reg.unregister();
    db.close();
  });
});

describe("stepOutcomesFromGates mapping (feedback truth per step)", () => {
  const base = { step_id: "s1", kind: "step_check", outcome: "verified", confidence: "green" };

  test("judge-verified gates are excluded — model self-assessment is not a process reward", () => {
    const steps = stepOutcomesFromGates([{ ...base, verified_by: "judge" }]);
    expect(steps).toHaveLength(0);
  });

  test("unrunnable/unchecked are environmental, not evidence", () => {
    const steps = stepOutcomesFromGates([
      { ...base, outcome: "unrunnable", verified_by: "deterministic" },
      { ...base, outcome: "unchecked", verified_by: "deterministic" },
    ]);
    expect(steps).toHaveLength(0);
  });

  test("last verdict per step wins (red→green flip collapses to success)", () => {
    const steps = stepOutcomesFromGates([
      { ...base, outcome: "failed", verified_by: "deterministic" },
      { ...base, outcome: "verified", verified_by: "deterministic" },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.outcome).toBe("success");
  });

  test("user-verified gates count; rows without a step identity are skipped", () => {
    const steps = stepOutcomesFromGates([
      { ...base, verified_by: "user" },
      { ...base, step_id: null, verified_by: "deterministic" },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.rationale).toContain("user");
  });
});
