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
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// A4 live-loop coverage: the ladder's failure-kind matcher wired through promptRouted. Mirrors
// tests/ladder.test.ts's faux-provider + injected-fetch harness; asserts the two behaviors the
// classic-ladder tests don't — a transient BACKOFF (retry the SAME model, send NO feedback) and a
// structural REPLAN whose plan-revision steer actually reaches the model on the retry.

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

/** Recommends cheap-model unless it's excluded, then big-model. Records recommend/feedback bodies. */
function ladderService() {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      const req = init?.body ? JSON.parse(init.body) : {};
      recommendCalls.push(req);
      const excluded: string[] = req.constraints?.excluded_models ?? [];
      const pick = excluded.includes("cheap-model") ? "big-model" : "cheap-model";
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: {
            model_id: pick,
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: pick === "cheap-model" ? 0.001 : 0.01,
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
  return { fetchLike, recommendCalls, feedbackCalls };
}

function setup(db: MinimaDb, over: Record<string, unknown> = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([CHEAP, BIG]);
  const svc = ladderService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    candidates: ["cheap-model", "big-model"],
    allowOffline: false,
    minimaApiKey: "k",
    groundTruth: true,
    stopStrikes: 0, // isolate the ladder from the A2 stop-gate
    spiralRepeats: 0, // and from A3
    stepCap: 0,
    ...over,
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
  return { agent, reg, svc };
}

describe("A4 failure-kind matcher — live loop", () => {
  test("transient error → BACKOFF: retries the SAME model, sends no failure feedback", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db);
    db.upsertPlanFromTodos(agent.runId!, [{ content: "work", status: "in_progress" }]);

    // Rung 1: a rate-limit blip (surfaces as stop_reason:'error'); rung 2: the same model succeeds.
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "openai-compat request failed: HTTP 429 rate limit",
      }),
      new AssistantMessage({ content: [text("recovered on the same model")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // Backoff kept the model: no exclusion, still cheap-model, and it's counted as a backoff.
    expect(routing?.chosenModelId).toBe("cheap-model");
    expect(agent.ladderBackoffs).toBe(1);
    expect(agent.ladderEscalations).toBe(0);
    expect(svc.recommendCalls).toHaveLength(2);
    expect((svc.recommendCalls[1] as any).constraints?.excluded_models ?? []).not.toContain(
      "cheap-model",
    );

    // A 429 is not the model's fault → the transient rung sent NO feedback; only the success did.
    expect(svc.feedbackCalls).toHaveLength(1);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("success");

    // Audit-only recovery gate: kind=recovery, backoff/🟡, rec_id NULL.
    const plan = db.getActivePlan(agent.runId!)!;
    const recoveries = db.getGates(plan.id).filter((g) => g.kind === "recovery");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.confidence).toBe("yellow");
    expect(recoveries[0]!.rec_id).toBeNull();
    expect(JSON.parse(recoveries[0]!.factors_json ?? "{}")).toMatchObject({
      intervention: "backoff",
    });

    reg.unregister();
    db.close();
  });

  test("persistent grounded 🔴 → REPLAN: the plan-revision steer reaches the model on the retry", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db);
    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "A", status: "in_progress" },
    ]);
    // The check keeps failing under every rung's rec (identity join → one red per rec).
    for (const recId of ["rec-1", "rec-2", "rec-3"]) {
      db.insertGate({
        planId,
        stepId: stepIds[0]!,
        outcome: "failed",
        verifiedBy: "deterministic",
        confidence: "red",
        recId,
      });
    }
    reg.setResponses([
      new AssistantMessage({ content: [text("1")] }),
      new AssistantMessage({ content: [text("2")] }),
      new AssistantMessage({ content: [text("3")] }),
    ]);

    await agent.promptRouted("hard");

    // First red escalated, the persistent red replanned (once — the last rung has no rung left).
    expect(agent.ladderEscalations).toBe(1);
    expect(agent.ladderReplans).toBe(1);
    // The replan preamble was prepended to a later rung's prompt → the model actually saw it.
    expect(reg.state.requests.some((r) => r.user.includes("REVISE YOUR PLAN"))).toBe(true);
    // A real check-fail is NOT suppressed: every one of the 3 rungs sent failure feedback (the
    // length pin matters — a regression routing the replan rung through transient-suppression would
    // silently drop it to 2 and a bare `.every` would still pass).
    expect(svc.feedbackCalls).toHaveLength(3);
    expect(svc.feedbackCalls.every((f) => (f as any).outcome === "failure")).toBe(true);
    // Propensity integrity: the replan rung did NOT exclude the escalated model — only the first
    // (escalate) rung excluded cheap-model, so the 3rd recommend still carries just that exclusion.
    expect((svc.recommendCalls[2] as any).constraints?.excluded_models).toEqual(["cheap-model"]);

    reg.unregister();
    db.close();
  });

  test("kill-switch: groundTruth ON but failureMatcher OFF → classic always-escalate ladder", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db, { failureMatcher: false });
    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "A", status: "in_progress" },
    ]);
    for (const recId of ["rec-1", "rec-2", "rec-3"]) {
      db.insertGate({
        planId,
        stepId: stepIds[0]!,
        outcome: "failed",
        verifiedBy: "deterministic",
        confidence: "red",
        recId,
      });
    }
    reg.setResponses([
      new AssistantMessage({ content: [text("1")] }),
      new AssistantMessage({ content: [text("2")] }),
      new AssistantMessage({ content: [text("3")] }),
    ]);

    await agent.promptRouted("hard");

    // With the matcher disabled, a persistent red escalates EVERY rung (no replan, no backoff), and
    // writes no `recovery` audit rows — byte-identical to the pre-A4 ladder (invariant #1).
    expect(agent.ladderEscalations).toBe(2);
    expect(agent.ladderReplans).toBe(0);
    expect(agent.ladderBackoffs).toBe(0);
    expect(db.getGates(planId).filter((g) => g.kind === "recovery")).toHaveLength(0);
    expect(svc.feedbackCalls).toHaveLength(3);
    expect(svc.feedbackCalls.every((f) => (f as any).outcome === "failure")).toBe(true);

    reg.unregister();
    db.close();
  });

  test("non-transient hard error (matcher ON) → escalate AND still sends failure feedback", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db);
    db.upsertPlanFromTodos(agent.runId!, [{ content: "work", status: "in_progress" }]);

    // A capability-style hard error (NOT matched by TRANSIENT_RE), then a recovery on big-model.
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "boom: upstream 500",
      }),
      new AssistantMessage({ content: [text("fixed on big")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // Escalated (excluded cheap-model → big-model), NOT a backoff.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(agent.ladderEscalations).toBe(1);
    expect(agent.ladderBackoffs).toBe(0);
    // The model IS penalized: a non-transient failure still sends failure feedback (only 429s are
    // suppressed). Both rungs reported: failure@cheap, success@big.
    expect(svc.feedbackCalls).toHaveLength(2);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("failure");
    expect((svc.feedbackCalls[1] as any).outcome).toBe("success");
    expect(
      db.getGates(db.getActivePlan(agent.runId!)!.id).filter((g) => g.kind === "recovery"),
    ).toHaveLength(0);

    reg.unregister();
    db.close();
  });

  test("a real gate-fail + a coincidental 429 on the same rung → escalate + failure feedback (not backoff)", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db);
    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "A", status: "in_progress" },
    ]);
    // The FIRST rung (rec-1) verifiably fails its check AND its run ends on a rate limit.
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      verifiedBy: "deterministic",
      confidence: "red",
      recId: "rec-1",
    });
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "HTTP 429 rate limit",
      }),
      new AssistantMessage({ content: [text("fixed on big")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // The real check-fail OUTRANKS the coincidental 429: the ladder ESCALATES (excludes cheap →
    // big-model), it does NOT backoff, and the genuinely-failing model IS penalized in feedback.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(agent.ladderEscalations).toBe(1);
    expect(agent.ladderBackoffs).toBe(0);
    expect(svc.feedbackCalls).toHaveLength(2);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("failure");

    reg.unregister();
    db.close();
  });

  test("backoffMs > 0: the delay branch runs and the same model is still retried", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(db, { backoffMs: 5 });
    db.upsertPlanFromTodos(agent.runId!, [{ content: "work", status: "in_progress" }]);

    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "HTTP 429 rate limit",
      }),
      new AssistantMessage({ content: [text("recovered")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // The awaited sleep(backoffMs) path is exercised; the backoff still retries the SAME model.
    expect(routing?.chosenModelId).toBe("cheap-model");
    expect(agent.ladderBackoffs).toBe(1);
    expect(svc.feedbackCalls).toHaveLength(1);

    reg.unregister();
    db.close();
  });
});
