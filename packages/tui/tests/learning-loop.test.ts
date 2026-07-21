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
import { writeExhaustionGate } from "../src/minima/failure_kind.ts";
import type { VerifiedOutcome } from "../src/minima/big_plan.ts";
import { deterministicOutcomeLabel } from "../src/minima/big_plan.ts";
import type { ConfidenceTier, GateOutcome } from "../src/minima/big_plan_contract.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// A7 — the learning-loop hardening pass over Stage 7:
//   1. the deterministic feedback label is GRADED by the gate's confidence tier (🟢→success,
//      🟡/🔴-tier-but-verified→partial, failed→failure) instead of collapsing every verified pass to
//      `success` — so Minima learns weaker positive evidence distinctly from verified evidence;
//   2. an exhausted recovery ladder (every rung spent, still failing) leaves ONE terminal audit
//      `recovery` gate + bumps `ladderExhausted`, instead of a silent return.
// A real check still OUTRANKS the LLM judge on a genuine CONTRADICTION (not just when they agree),
// which the M7.2 suite never exercised. All hermetic: faux provider + injected fetch.

// ---------------------------------------------------------------------------
// 1. the pure grading function (deterministicOutcomeLabel)
// ---------------------------------------------------------------------------

function verifiedOutcome(outcome: GateOutcome, confidence: ConfidenceTier | null): VerifiedOutcome {
  return { gateId: "g1", outcome, verifiedBy: "deterministic", confidence };
}

describe("deterministicOutcomeLabel (A7 tier grading, pure)", () => {
  test("graded on: 🟢 verified → success", () => {
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "green"), true)).toBe("success");
  });

  test("graded on: 🟡 verified (self-written / no red→green / coverage-unknown) → partial", () => {
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "yellow"), true)).toBe("partial");
  });

  test("graded on: 🔴-TIER but outcome-verified (A5 fabrication floor) → partial, never failure", () => {
    // A5 forces the tier to red on a fabricated green while the gate outcome stays `verified` — it
    // passed a check, just an untrustworthy one. It must not read as recovery-worthy failure (a
    // stronger model can't fix a fabricated test), nor as a clean success.
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "red"), true)).toBe("partial");
  });

  test("graded on: a null tier is treated as non-green → partial", () => {
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", null), true)).toBe("partial");
  });

  test("failed → failure regardless of grading", () => {
    expect(deterministicOutcomeLabel(verifiedOutcome("failed", "red"), true)).toBe("failure");
    expect(deterministicOutcomeLabel(verifiedOutcome("failed", "red"), false)).toBe("failure");
  });

  test("graded OFF: any verified pass → success (M7.2 binary), tier ignored", () => {
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "green"), false)).toBe("success");
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "yellow"), false)).toBe("success");
    expect(deterministicOutcomeLabel(verifiedOutcome("verified", "red"), false)).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// 2. feedback integration — graded label + judge-vs-gate disagreement
// ---------------------------------------------------------------------------

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

/** A judge that counts its invocations — lets a test prove the gate outranked (or skipped) it. */
function countingJudge(score: number | null) {
  return {
    calls: 0,
    async grade(): Promise<number | null> {
      this.calls += 1;
      return score;
    },
  };
}

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

function setup(judge: ReturnType<typeof countingJudge>, gradedOutcome = true) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX_MODEL);
  const reg = registerFauxProvider([FAUX_MODEL]);
  reg.setResponses([new AssistantMessage({ content: [text("answer")], stop_reason: "stop" })]);
  const { fetchLike, feedbackCalls } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: true,
    gradedOutcome,
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

/** Seed one in_progress step + a single deterministic gate of the given verdict under `recId`. */
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

describe("A7 graded feedback: deterministic gate outranks the judge on DISAGREEMENT", () => {
  test("gate=🟢 verified but the judge would FAIL it (0.3) → success/vip, judge never consulted", async () => {
    const judge = countingJudge(0.3); // the judge disagrees — it would grade this a failure
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "verified", "green");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success"); // the gate wins, not the judge's 0.3
    expect(fb.verified_in_production).toBe(true);
    expect(fb.quality_score).toBeUndefined();
    expect(judge.calls).toBe(0);
    reg.unregister();
    db.close();
  });

  test("gate=🔴 failed but the judge would PASS it (0.9) → failure, judge never consulted", async () => {
    const judge = countingJudge(0.9); // the judge disagrees — it would grade this a success
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    agent.recoveryRungs = 0; // isolate the feedback assertion from the ladder
    seedGate(db, runId, "failed", "red");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("failure"); // a real red check outranks the judge's 0.9
    expect(fb.verified_in_production).toBe(false);
    expect(fb.quality_score).toBeUndefined();
    expect(judge.calls).toBe(0);
    // recoveryRungs=0 → the ladder is DISABLED, so a lone failure is NOT "exhaustion": the
    // `recoveryRungs > 0` guard must hold off both the counter and the terminal gate.
    expect(agent.ladderExhausted).toBe(0);
    const planId = db.getLatestPlan(runId)!.id;
    expect(db.getGates(planId).filter((g) => g.kind === "recovery")).toHaveLength(0);
    reg.unregister();
    db.close();
  });

  test("gate=🔴-TIER but outcome-verified (A5 fabrication floor) → partial, no escalation/exhaustion", async () => {
    // The single most load-bearing A7 claim, driven end-to-end (not just the pure fn): a check that
    // PASSED but whose tier A5 forced to red (a fabricated green) is graded `partial` — never a
    // fabricated `success`, never a `failure` — and because the recovery trigger keys on
    // verifiedOutcome.outcome==='failed' (NOT confidence==='red'), a stronger model is never summoned for it.
    const judge = countingJudge(0.9);
    const { agent, reg, feedbackCalls, db, runId } = setup(judge); // recoveryRungs defaults to 2
    seedGate(db, runId, "verified", "red");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("partial");
    expect(fb.verified_in_production).toBe(false); // a fabricated pass is never verified evidence
    expect(fb.quality_score).toBeUndefined();
    expect(agent.ladderEscalations).toBe(0); // NOT recovery-worthy — the trigger reads `failed`, not tier
    expect(agent.ladderExhausted).toBe(0);
    expect(judge.calls).toBe(0);
    reg.unregister();
    db.close();
  });

  test("gate=🟡 verified + a passing judge (0.9) → partial (A7), judge skipped", async () => {
    const judge = countingJudge(0.9);
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    seedGate(db, runId, "verified", "yellow");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("partial"); // weaker-than-green evidence, graded down
    expect(fb.verified_in_production).toBe(false);
    expect(fb.quality_score).toBeUndefined();
    expect(judge.calls).toBe(0);
    reg.unregister();
    db.close();
  });
});

describe("A7 graded feedback: flag off restores the M7.2 binary label", () => {
  let judge: ReturnType<typeof countingJudge>;
  beforeEach(() => {
    judge = countingJudge(0.9);
  });

  test("gradedOutcome=0: 🟡 verified → success (binary), tier only in notes", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge, /* gradedOutcome */ false);
    seedGate(db, runId, "verified", "yellow");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success"); // M7.2 behavior preserved when the A7 flag is off
    expect(fb.verified_in_production).toBe(false);
    expect(String(fb.notes)).toContain("tier=yellow");
    expect(judge.calls).toBe(0);
    reg.unregister();
    db.close();
  });

  test("gradedOutcome=0: 🟢 verified → success (unchanged)", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge, false);
    seedGate(db, runId, "verified", "green");

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success");
    expect(fb.verified_in_production).toBe(true);
    reg.unregister();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. writeExhaustionGate (pure writer)
// ---------------------------------------------------------------------------

describe("writeExhaustionGate (A7 terminal audit row)", () => {
  test("writes one recovery gate: kind=exhausted, tier red, rec_id NULL (invisible to feedback join)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { planId } = db.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress" }]);

    writeExhaustionGate({ db, sessionId: runId, agentId: null }, "gate_failed");

    const recoveries = db.getGates(planId).filter((g) => g.kind === "recovery");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.rec_id).toBeNull();
    expect(recoveries[0]!.confidence).toBe("red");
    expect(recoveries[0]!.outcome).toBe("unchecked");
    expect(recoveries[0]!.verified_by).toBeNull();
    expect(JSON.parse(recoveries[0]!.factors_json ?? "{}")).toMatchObject({
      recovery: true,
      kind: "exhausted",
      exhausted: true,
      cause: "gate_failed",
    });
    db.close();
  });

  test("fail-open: a null db / missing plan / no session is a silent no-op", () => {
    expect(() =>
      writeExhaustionGate({ db: null, sessionId: "s", agentId: null }, "hard_error"),
    ).not.toThrow();
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    // No active plan for this session → no-op, no throw, no row.
    expect(() =>
      writeExhaustionGate({ db, sessionId: runId, agentId: null }, "judge_failed"),
    ).not.toThrow();
    db.close();
  });
});
