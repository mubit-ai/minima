import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  flaggedFooter,
  gateConfidence,
  ledgerBehavior,
  redPrompt,
} from "../src/minima/behavior.ts";
import {
  groundTruthHooks,
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
import { todowriteTool } from "../src/tools/todowrite.ts";

// M8.2 — the ground-truth spine end-to-end, pinned as a regression. Test 1 seeds the ledger (the
// /gt-seed / seedPlan pattern) to pin the full footer snapshot — tiers, drift, and the M7.1 stamp —
// in one glance. Test 2 is the live-gate join: the hooks are REGISTERED on the agent and every gate
// row is minted during real tool dispatch inside a routed rung, so it carries that rung's rec_id
// (the v6 identity join), while the M7.2/M7.3 route→run→feedback→escalation loop runs against an
// in-memory MinimaDb + faux provider.

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
      recId: "seed-rec",
      sessionId: runId,
    });
    db.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "verified",
      confidence: gateConfidence(YELLOW),
      verifiedBy: "deterministic",
      factors: YELLOW,
      recId: "seed-rec",
      sessionId: runId,
    });
    db.insertGate({
      planId,
      stepId: stepIds[2]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
      recId: "seed-rec",
      sessionId: runId,
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
    stampGroundedOutcome(db, "seed-rec");
    const dec = db.getRunDecisions(runId).find((r) => r.rec_id === "seed-rec")!;
    expect(dec.gt_outcome).toBe("failed"); // identity join over the rec's gates — the red wins
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

    // A gated mock: routes cheap→big when cheap is excluded. When it re-routes to big, the awaited
    // callback below "does the work" (the red→green a stronger model achieves) through the real
    // done-gate rather than by seeding rows.
    let onEscalationRung: () => Promise<void> = async () => {};
    const recommendCalls: Record<string, unknown>[] = [];
    const feedbackCalls: Record<string, unknown>[] = [];
    const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
        const req = init?.body ? JSON.parse(init.body) : {};
        recommendCalls.push(req);
        const excluded: string[] = req.constraints?.excluded_models ?? [];
        const pick = excluded.includes("cheap-model") ? "big-model" : "cheap-model";
        if (pick === "big-model") await onEscalationRung();
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
      tools: [todowriteTool([], { groundTruth: true })],
    });
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });

    // M8.2 live-gate join — nothing below is seeded. The flag file IS the ground truth: the
    // step's check (`test -f`) is red until the "work" creates it. The flag name avoids
    // test/spec so the factor heuristics read it as a pre-existing check with unknown coverage.
    const dir = mkdtempSync(join(tmpdir(), "gt-e2e-"));
    const flag = join(dir, "done.flag");
    const { before: beforeGate, after: afterGate } = groundTruthHooks(agent);
    agent.addBeforeToolCall(beforeGate);
    agent.addAfterToolCall(afterGate);
    const start = [
      { content: "wire the endpoint", status: "in_progress", verify: `test -f ${flag}` },
    ];
    const done = [{ content: "wire the endpoint", status: "completed", verify: `test -f ${flag}` }];

    // Rung 1 (cheap, rec-1): the plan lands through the sink (pre-work baseline: flag absent →
    // red), then the rung claims completion while the check is still red — the done-gate blocks
    // the todowrite mid-dispatch and records the failed attempt under rec-1 (M4.1): the grounded
    // 🔴 the ladder sees. Rung 2 (big, rec-2): the escalation "does the work" (flag created
    // below) and the retried todowrite passes the gate — the verified row lands under rec-2.
    onEscalationRung = async () => {
      writeFileSync(flag, "ok\n");
    };
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("tc-plan", "todowrite", { tasks: JSON.stringify(start) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-red", "todowrite", { tasks: JSON.stringify(done) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("blocked on cheap")] }),
      new AssistantMessage({
        content: [toolCall("tc-green", "todowrite", { tasks: JSON.stringify(done) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("fixed on big")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    const plan = db.getLatestPlan(agent.runId)!;
    const step = db.getPlanSteps(plan.id)[0]!;
    expect(step.baseline).toBe("red"); // captured before the flag existed
    expect(plan.status).toBe("done"); // 99B: the completing after-hook closed the plan

    // Escalated exactly once, recovered on the bigger model.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(agent.ladderEscalations).toBe(1);
    expect(feedbackCalls.map((f) => (f as any).outcome)).toEqual(["failure", "success"]);

    // Gate rows written by the hooks, not seeded — the blocked attempt then the recovered pass,
    // both attributed to the same step, with measured factors (the red→green flip is real).
    const gateRows = db.getGates(plan.id);
    expect(gateRows.map((g) => g.outcome)).toEqual(["failed", "verified"]);
    expect(gateRows.map((g) => g.step_id)).toEqual([step.id, step.id]);
    expect(gateRows.map((g) => g.rec_id)).toEqual(["rec-1", "rec-2"]); // minted inside their rungs
    const passFactors = JSON.parse(gateRows[1]!.factors_json!) as Record<string, unknown>;
    expect(passFactors.redToGreen).toBe(true); // measured against the captured baseline
    expect(db.getPlanSteps(plan.id)[0]!.status).toBe("completed");

    // DB dump: two routing rows, per model, each with a grounded outcome stamped (M7.1) and the
    // grounded loss/win recorded (M7.3), chained by parent_rec_id. Live tiers are honest: the
    // failed attempt derives red; the pass derives yellow, not green — no file_changes were
    // recorded, so coverage is unknown and the ladder withholds green (the seeded test above
    // pins the full green story).
    const rows = db.getRunDecisions(agent.runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.chosen_model).toBe("cheap-model");
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[0]!.gt_outcome).toBe("failed");
    expect(rows[0]!.gt_confidence).toBe("red");
    expect(rows[1]!.chosen_model).toBe("big-model");
    expect(rows[1]!.outcome).toBe("success");
    expect(rows[1]!.gt_outcome).toBe("verified");
    expect(rows[1]!.gt_confidence).toBe("yellow");
    expect(rows[1]!.parent_rec_id).toBe(String(rows[0]!.rec_id));
    reg.unregister();
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });
});
