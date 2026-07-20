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

/** Mock service: recommends cheap-model unless it's excluded, then big-model. */
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
          fallback_model: {
            model_id: "big-model",
            provider: "faux",
            predicted_success: 0.95,
            est_cost_usd: 0.01,
            score: 2,
          },
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

function setup(
  judge: ConstJudge,
  db?: MinimaDb,
  opts: { svc?: ReturnType<typeof ladderService>; groundTruth?: boolean } = {},
) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([CHEAP, BIG]);
  const svc = opts.svc ?? ladderService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({ judgeSampleRate: 1,
    candidates: ["cheap-model", "big-model"],
    allowOffline: false,
    minimaApiKey: "k",
    groundTruth: opts.groundTruth ?? false,
    // The ladder tests script the model-routing recovery loop, not the A2 stop-gate; disable the
    // stop-gate so its force-continue can't exhaust the mock and spuriously trip escalation.
    stopStrikes: 0,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge, meter: new CostMeter(), tools: [] });
  if (db) {
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });
  }
  return { agent, reg, svc };
}

/**
 * M7.3: same routing as ladderService, but the moment the escalation rung is requested
 * (cheap-model excluded → big-model picked) it runs `onEscalationRung` — the test uses this to
 * flip the active plan's latest gate to verified, so the recovered rung reads green (red→green).
 */
function gatedLadderService(onEscalationRung: () => void) {
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

describe("recovery ladder", () => {
  test("gate: a provider hard failure recovers on the next rung exactly once", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db);
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "upstream 500",
      }),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // The retry excluded the failed model → the server picked the bigger one.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(svc.recommendCalls).toHaveLength(2);
    expect((svc.recommendCalls[1] as any).constraints.excluded_models).toEqual(["cheap-model"]);
    expect(agent.ladderEscalations).toBe(1);

    // Both rungs sent feedback: the failure AND the recovery.
    expect(svc.feedbackCalls).toHaveLength(2);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("failure");
    expect((svc.feedbackCalls[1] as any).outcome).toBe("success");

    // Both rungs persisted; the retry links to the first rung's rec_id.
    const rows = db.getRunDecisions(agent.runId!);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.parent_rec_id).toBe(String(rows[0]!.rec_id));

    // The failed rung's messages were rolled back — one user turn, one final answer.
    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("recovered answer");
    reg.unregister();
    db.close();
  });

  test("gate: a judged grade below τ escalates; a PASSING grade does not", async () => {
    // τ = 0.7 from the mock service. ConstJudge(0.3) fails it; ConstJudge(0.9) passes.
    {
      const { agent, reg, svc } = setup(new ConstJudge(0.3));
      reg.setResponses([
        new AssistantMessage({ content: [text("bad answer")] }),
        new AssistantMessage({ content: [text("better answer")] }),
        new AssistantMessage({ content: [text("third answer")] }),
      ]);
      await agent.promptRouted("hard question");
      // Judge fails EVERY rung (const 0.3), so it walks all rungs: 1 + 2 retries.
      expect(svc.recommendCalls.length).toBe(3);
      expect(agent.ladderEscalations).toBe(2);
      reg.unregister();
    }
    {
      const { agent, reg, svc } = setup(new ConstJudge(0.9));
      reg.setResponses([new AssistantMessage({ content: [text("good answer")] })]);
      await agent.promptRouted("easy question");
      expect(svc.recommendCalls).toHaveLength(1); // no escalation
      expect(agent.ladderEscalations).toBe(0);
      reg.unregister();
    }
  });

  test("gate: NEVER retries on a null judge (abstain is not a failure)", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(null));
    reg.setResponses([new AssistantMessage({ content: [text("unjudged answer")] })]);
    await agent.promptRouted("whatever");
    expect(svc.recommendCalls).toHaveLength(1);
    expect(agent.ladderEscalations).toBe(0);
    reg.unregister();
  });

  test("recoveryRungs=0 disables the ladder entirely", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9));
    agent.recoveryRungs = 0;
    reg.setResponses([
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
    ]);
    await agent.promptRouted("x"); // provider error surfaces as failure feedback, no retry
    expect(svc.recommendCalls).toHaveLength(1);
    expect(agent.ladderEscalations).toBe(0);
    expect((svc.feedbackCalls[0] as Record<string, unknown>).outcome).toBe("failure");
    reg.unregister();
  });
});

describe("recovery ladder — grounded checks (M7.3)", () => {
  test("a grounded RED check escalates; the recovered rung records failure@A + success@B", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    let installVerifiedGate = () => {};
    const svc = gatedLadderService(() => installVerifiedGate());
    const { agent, reg } = setup(new ConstJudge(0.9), db, { svc, groundTruth: true });

    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "wire the endpoint", status: "in_progress" },
    ]);
    // Rung 1 (rec-1) mints a failed check — identity join: the red belongs to THIS rung.
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      verifiedBy: "deterministic",
      confidence: "red",
      recId: "rec-1",
    });
    // When the ladder re-routes to big-model (rec-2), the step verifies (red → green).
    installVerifiedGate = () => {
      db.insertGate({
        planId,
        stepId: stepIds[0]!,
        outcome: "verified",
        verifiedBy: "deterministic",
        confidence: "green",
        recId: "rec-2",
      });
    };

    reg.setResponses([
      new AssistantMessage({ content: [text("attempt on cheap")] }),
      new AssistantMessage({ content: [text("fixed on big")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // The grounded fail excluded cheap-model → the server picked the bigger one.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(svc.recommendCalls).toHaveLength(2);
    expect((svc.recommendCalls[1] as any).constraints.excluded_models).toEqual(["cheap-model"]);
    expect(agent.ladderEscalations).toBe(1);
    expect(agent.ladderExhausted).toBe(0); // A7: it RECOVERED — the ladder was not exhausted

    // failure@A then success@B — the grounded loss AND the recovery both reach Minima.
    expect(svc.feedbackCalls).toHaveLength(2);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("failure");
    expect((svc.feedbackCalls[0] as any).notes).toContain("verified_by=deterministic");
    expect((svc.feedbackCalls[1] as any).outcome).toBe("success");
    expect((svc.feedbackCalls[1] as any).verified_in_production).toBe(true); // green rung

    // Both rungs persisted per model, chained by parent_rec_id.
    const rows = db.getRunDecisions(agent.runId!);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[1]!.outcome).toBe("success");
    expect(rows[1]!.parent_rec_id).toBe(String(rows[0]!.rec_id));
    reg.unregister();
    db.close();
  });

  test("a grounded GREEN check does NOT escalate", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db, { groundTruth: true });
    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "A", status: "in_progress" },
    ]);
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      verifiedBy: "deterministic",
      confidence: "green",
      recId: "rec-1",
    });
    reg.setResponses([new AssistantMessage({ content: [text("done")] })]);
    await agent.promptRouted("easy");
    expect(svc.recommendCalls).toHaveLength(1);
    expect(agent.ladderEscalations).toBe(0);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("success");
    expect((svc.feedbackCalls[0] as any).verified_in_production).toBe(true);
    reg.unregister();
    db.close();
  });

  test("a persistent RED check walks every rung — escalate once, then replan (A4)", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db, { groundTruth: true });
    const { planId, stepIds } = db.upsertPlanFromTodos(agent.runId!, [
      { content: "A", status: "in_progress" },
    ]);
    // A check that keeps failing mints a red under EVERY rung's rec (identity join: each
    // rung only sees its own verdict, so persistence means one red per rec).
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
    // Still walks every rung (1 + 2 retries). A4: the FIRST red escalates (a stronger model might
    // fix it); once the red persists across rungs the approach — not the model — is at fault, so
    // the ladder REPLANS the remaining rungs (keep the model, inject a plan-revision steer) instead
    // of burning more model swaps.
    // 3 rungs = attempts 0,1,2. Only 0 and 1 recover (the last has no rung left): attempt 0's
    // first red escalates, attempt 1's persistent red replans; attempt 2 just ends.
    expect(svc.recommendCalls).toHaveLength(3);
    expect(agent.ladderEscalations).toBe(1);
    expect(agent.ladderReplans).toBe(1);
    // All 3 rungs still send failure feedback (replan/escalate never suppress a real check-fail);
    // the length pin guards against a regression silently dropping a rung via transient-suppression.
    expect(svc.feedbackCalls).toHaveLength(3);
    expect(svc.feedbackCalls.every((f) => (f as any).outcome === "failure")).toBe(true);
    // Two audit-only `recovery` gates, both rec_id NULL (invisible to the feedback join): the
    // replan from attempt 1, and A7's terminal EXHAUSTION gate from attempt 2 (the last rung was
    // still red with no rung left to recover on).
    const recoveries = db.getGates(planId).filter((g) => g.kind === "recovery");
    expect(recoveries).toHaveLength(2);
    expect(recoveries.every((g) => g.rec_id === null)).toBe(true);
    const replan = recoveries.find(
      (g) => JSON.parse(g.factors_json ?? "{}").intervention === "replan",
    );
    const exhausted = recoveries.find((g) => JSON.parse(g.factors_json ?? "{}").exhausted === true);
    expect(replan).toBeDefined();
    expect(exhausted).toBeDefined();
    expect(exhausted!.confidence).toBe("red");
    expect(JSON.parse(exhausted!.factors_json ?? "{}")).toMatchObject({
      kind: "exhausted",
      cause: "gate_failed",
    });
    expect(agent.ladderExhausted).toBe(1);
    reg.unregister();
    db.close();
  });
});

describe("recovery ladder — exhaustion causes (A7)", () => {
  /** Seed an active plan with one in_progress, verify-less step (no gate) so the exhaustion writer
   * has a plan to attach to, without any grounded verdict interfering with the cause under test. */
  function seedActivePlan(db: MinimaDb, runId: string) {
    db.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress" }]);
    return db.getLatestPlan(runId)!.id;
  }
  function exhaustionGate(db: MinimaDb, planId: string) {
    return db
      .getGates(planId)
      .filter((g) => g.kind === "recovery")
      .find((g) => JSON.parse(g.factors_json ?? "{}").exhausted === true);
  }

  test("no gate + a persistent sub-τ judge → exhaustion cause='judge_failed'", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.3), db, { groundTruth: true });
    const planId = seedActivePlan(db, agent.runId!);
    reg.setResponses([
      new AssistantMessage({ content: [text("1")] }),
      new AssistantMessage({ content: [text("2")] }),
      new AssistantMessage({ content: [text("3")] }),
    ]);
    await agent.promptRouted("hard");
    expect(svc.recommendCalls).toHaveLength(3); // escalate x2 then exhaust
    expect(agent.ladderEscalations).toBe(2);
    expect(agent.ladderExhausted).toBe(1);
    const g = exhaustionGate(db, planId);
    expect(g).toBeDefined();
    expect(g!.confidence).toBe("red");
    expect(JSON.parse(g!.factors_json ?? "{}").cause).toBe("judge_failed");
    reg.unregister();
    db.close();
  });

  test("persistent non-transient provider error → exhaustion cause='hard_error'", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db, { groundTruth: true });
    const planId = seedActivePlan(db, agent.runId!);
    reg.setResponses([
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
    ]);
    await agent.promptRouted("x");
    expect(agent.ladderEscalations).toBe(2); // a non-transient error escalates
    expect(agent.ladderExhausted).toBe(1);
    const g = exhaustionGate(db, planId);
    expect(g).toBeDefined();
    expect(JSON.parse(g!.factors_json ?? "{}").cause).toBe("hard_error");
    reg.unregister();
    db.close();
  });

  test("a rate-limit storm across every rung → exhaustion cause='transient' (not hard_error)", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db, { groundTruth: true });
    const planId = seedActivePlan(db, agent.runId!);
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "HTTP 503",
      }),
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "HTTP 503",
      }),
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "HTTP 503",
      }),
    ]);
    await agent.promptRouted("x");
    // A transient blip backs off the SAME model (no exclusion, no feedback) — A4 — so the infra
    // storm never teaches Minima; the exhaustion audit keeps it distinct from a capability failure.
    expect(agent.ladderBackoffs).toBe(2);
    expect(agent.ladderEscalations).toBe(0);
    expect(svc.feedbackCalls).toHaveLength(0); // transient suppresses feedback on every rung
    expect(agent.ladderExhausted).toBe(1);
    const g = exhaustionGate(db, planId);
    expect(g).toBeDefined();
    expect(JSON.parse(g!.factors_json ?? "{}").cause).toBe("transient");
    reg.unregister();
    db.close();
  });
});
