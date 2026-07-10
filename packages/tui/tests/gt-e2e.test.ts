import { describe, expect, test } from "bun:test";
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
import {
  flaggedFooter,
  gateConfidence,
  ledgerBehavior,
  redPrompt,
} from "../src/minima/behavior.ts";
import {
  planStripDrift,
  planStripInfo,
  planStripLabel,
  stampGroundedOutcome,
} from "../src/minima/ground_truth.ts";
import type { Factors } from "../src/minima/gt_contract.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// M8.2 — the ground-truth spine end-to-end, pinned as a regression. Track A does not yet write live
// gates, so the plan+gates are seeded (the /gt-seed / seedPlan pattern), but everything downstream —
// footer snapshot, tiers, drift, the M7.1 stamp, and the M7.2/M7.3 route→run→feedback→escalation
// loop — is exercised for real against an in-memory MinimaDb + faux provider.

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};
const YELLOW: Factors = { ...GREEN, checkOrigin: "agent_new" };
const RED: Factors = { ...GREEN, pass: false };

describe("Ground-Truth spine — end-to-end demo (M8.2)", () => {
  test("seeded plan renders the full footer snapshot (🟢🟡🔴 + drift) and stamps a grounded outcome", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });

    const { planId, stepIds } = db.upsertPlanFromTodos(
      runId,
      [
        { content: "add auth model", status: "completed", verify: "bun test auth" },
        { content: "write login handler", status: "completed", verify: "bun test login" },
        { content: "integrate billing", status: "in_progress", verify: "bun test billing" },
      ],
      "Checkout",
    );
    // One gate per tier: a trusted pass, a self-written pass, and a hard fail.
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
    });
    db.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "verified",
      confidence: gateConfidence(YELLOW),
      verifiedBy: "deterministic",
      factors: YELLOW,
    });
    db.insertGate({
      planId,
      stepId: stepIds[2]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
    });
    // An off-plan edit → drift.
    db.insertFileChange({
      planId,
      stepId: stepIds[2]!,
      path: "billing/stripe.ts",
      kind: "modified",
      origin: "off_plan",
    });

    // --- Strip snapshot (M1.3 + M2.3) ---
    const info = planStripInfo(db, runId)!;
    expect(planStripLabel(info)).toBe("▸ plan 3/3 — integrate billing");
    expect(planStripDrift(info.drift)).toBe("   ⚠ 1 off-plan (drift)");

    // --- Tier → behavior (M6.1/M6.2) ---
    const beh = ledgerBehavior(db, runId);
    expect(beh.flaggedCount).toBe(1); // the yellow step
    expect(beh.footerNote).toBe(flaggedFooter(1));
    expect(beh.block?.stepId).toBe(stepIds[2]!); // the run halts on the red step
    expect(beh.block?.prompt).toBe(redPrompt("check did not pass"));

    // --- DB dump ---
    expect(db.getPlanSteps(planId)).toHaveLength(3);
    expect(db.getGates(planId).map((g) => g.confidence)).toEqual(["green", "yellow", "red"]);
    expect(db.countOffPlanChanges(planId)).toBe(1);

    // --- M7.1 grounded stamp onto a routing decision ---
    db.writeDecision({
      recId: "seed-rec",
      runId,
      taskLabel: "demo",
      chosenModel: "anthropic/claude-sonnet-5",
      decisionBasis: "seed",
      confidence: 0.8,
      thresholdUsed: 0.7,
      ranked: [],
      estCostUsd: 0,
      actualCostUsd: 0,
      quality: null,
      judged: false,
      outcome: "failure",
      turns: 1,
      latencyMs: 1,
    });
    stampGroundedOutcome(db, runId, "seed-rec");
    const dec = db.getRunDecisions(runId).find((r) => r.rec_id === "seed-rec")!;
    expect(dec.gt_outcome).toBe("failed"); // the most-recent gate (red) is the grounded verdict
    expect(dec.gt_verified_by).toBe("deterministic");
    expect(dec.gt_confidence).toBe("red");
    db.close();
  });

  test("live loop: a red check escalates, the recovered rung verifies, and both rungs carry grounded outcomes", async () => {
    const CHEAP: Model = {
      id: "cheap-model",
      provider: "faux",
      api: "faux",
      name: "Cheap",
      cost: { input: 1, output: 2 },
      context_window: 8192,
      max_tokens: 4096,
    };
    const BIG: Model = {
      id: "big-model",
      provider: "faux",
      api: "faux",
      name: "Big",
      cost: { input: 10, output: 20 },
      context_window: 8192,
      max_tokens: 4096,
    };

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");

    // A gated mock: routes cheap→big when cheap is excluded, and when it re-routes to big it flips
    // the plan's latest gate to verified (the red→green a stronger model achieves).
    let onEscalationRung = () => {};
    const recommendCalls: Record<string, unknown>[] = [];
    const feedbackCalls: Record<string, unknown>[] = [];
    const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
        const req = init?.body ? JSON.parse(init.body) : {};
        recommendCalls.push(req);
        const excluded: string[] = req.constraints?.excluded_models ?? [];
        const pick = excluded.includes("cheap-model") ? "big-model" : "cheap-model";
        if (pick === "big-model") onEscalationRung();
        return {
          status: 200,
          json: async () => ({
            recommendation_id: `rec-${recommendCalls.length}`,
            recommended_model: {
              model_id: pick,
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
            ranked: [
              {
                model_id: pick,
                provider: "faux",
                predicted_success: 0.9,
                est_cost_usd: 0.001,
                score: 1,
              },
            ],
            confidence: 0.8,
            decision_basis: "memory",
            threshold_used: 0.7,
            classified_task_type: "code",
            classified_difficulty: "easy",
            catalog_version: "v1",
          }),
        };
      }
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
        feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
        return { status: 200, json: async () => ({ accepted: true }) };
      }
      return { status: 404, json: async () => ({ detail: "nope" }) };
    };

    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(CHEAP);
    registerModel(BIG);
    const reg = registerFauxProvider([CHEAP, BIG]);
    reg.setResponses([
      new AssistantMessage({ content: [text("attempt on cheap")] }),
      new AssistantMessage({ content: [text("fixed on big")] }),
    ]);
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["cheap-model", "big-model"],
      allowOffline: false,
      minimaApiKey: "k",
      groundTruth: true,
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const agent = new MinimaAgent({
      config,
      router,
      judge: new ConstJudge(0.9),
      meter: new CostMeter(),
      tools: [],
    });
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });

    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId, [
      { content: "wire the endpoint", status: "in_progress" },
    ]);
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      verifiedBy: "deterministic",
      confidence: "red",
    });
    onEscalationRung = () => {
      db.insertGate({
        planId,
        stepId: stepIds[0]!,
        outcome: "verified",
        verifiedBy: "deterministic",
        confidence: "green",
      });
    };

    const routing = await agent.promptRouted("do the thing");

    // Escalated exactly once, recovered on the bigger model.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(agent.ladderEscalations).toBe(1);
    expect(feedbackCalls.map((f) => (f as any).outcome)).toEqual(["failure", "success"]);

    // DB dump: two routing rows, per model, each with a grounded outcome stamped (M7.1) and the
    // grounded loss/win recorded (M7.3), chained by parent_rec_id.
    const rows = db.getRunDecisions(agent.runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.chosen_model).toBe("cheap-model");
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[0]!.gt_outcome).toBe("failed");
    expect(rows[0]!.gt_confidence).toBe("red");
    expect(rows[1]!.chosen_model).toBe("big-model");
    expect(rows[1]!.outcome).toBe("success");
    expect(rows[1]!.gt_outcome).toBe("verified");
    expect(rows[1]!.gt_confidence).toBe("green");
    expect(rows[1]!.parent_rec_id).toBe(String(rows[0]!.rec_id));
    reg.unregister();
    db.close();
  });
});
