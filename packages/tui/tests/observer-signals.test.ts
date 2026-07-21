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
  ObserverController,
  harnessConfig,
} from "../src/minima/index.ts";

// PR-E5 observer→signals bridge: a WARN-severity observer verdict stamped with THIS rung's
// rec_id joins the landed D2 signals map as `observer_flagged` — signals-map ONLY, never
// outcome/quality/evidence provenance. Omit-absent contract: the key rides only when the
// observer actually observed the rung. Hermetic: mock fetch service + faux provider.

const CHEAP: Model = {
  id: "cheap-model",
  provider: "faux",
  api: "faux",
  name: "Cheap",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

/** Mock service: always recommends cheap-model; rec ids are deterministic (rec-1, rec-2...). */
function mockService() {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: {
            model_id: "cheap-model",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 1,
          },
          ranked: [
            {
              model_id: "cheap-model",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 1,
            },
          ],
          fallback_model: null,
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

function setup(opts: { observer: boolean }) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  const reg = registerFauxProvider([CHEAP]);
  const svc = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["cheap-model"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: false,
    stopStrikes: 0,
    observer: opts.observer,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  agent.db = db;
  agent.runId = db.startRun({ projectKey: "p" });
  return { agent, reg, svc, db };
}

function insertVerdict(
  db: MinimaDb,
  runId: string,
  severity: "info" | "warn",
  recId: string | null,
): void {
  db.insertObserverVerdict({
    runId,
    turn: 1,
    kind: "test_edit",
    claim: "edited a test file mid-step",
    evidenceRef: "tests/parser.test.ts",
    severity,
    recId,
  });
}

function sentSignals(body: Record<string, unknown>): Record<string, boolean> {
  expect(body.signals).toBeDefined();
  return body.signals as Record<string, boolean>;
}

describe("E5: observer verdicts ride feedback as the observer_flagged implicit signal", () => {
  test("a warn verdict under this rung's rec_id → signals.observer_flagged === true", async () => {
    const { agent, reg, svc, db } = setup({ observer: true });
    insertVerdict(db, agent.runId!, "warn", "rec-1");
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    await agent.promptRouted("do the thing");

    expect(svc.feedbackCalls).toHaveLength(1);
    const signals = sentSignals(svc.feedbackCalls[0] as Record<string, unknown>);
    expect(signals.observer_flagged).toBe(true);
    // The landed D2 keys still ride the same map — one signals block, not two.
    expect(signals.retried).toBe(false);
    expect(signals.session_continued).toBe(false);
    reg.unregister();
    db.close();
  });

  test("no verdicts → observer_flagged is ABSENT from the map (absence is not evidence)", async () => {
    const { agent, reg, svc, db } = setup({ observer: true });
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    await agent.promptRouted("do the thing");

    expect(svc.feedbackCalls).toHaveLength(1);
    const signals = sentSignals(svc.feedbackCalls[0] as Record<string, unknown>);
    expect("observer_flagged" in signals).toBe(false);
    reg.unregister();
    db.close();
  });

  test("a warn verdict under ANOTHER rung's rec_id → observer_flagged never true here", async () => {
    const { agent, reg, svc, db } = setup({ observer: true });
    insertVerdict(db, agent.runId!, "warn", "rec-other");
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    await agent.promptRouted("do the thing");

    expect(svc.feedbackCalls).toHaveLength(1);
    const signals = sentSignals(svc.feedbackCalls[0] as Record<string, unknown>);
    expect(signals.observer_flagged).not.toBe(true);
    reg.unregister();
    db.close();
  });

  test("observer flag OFF → observer_flagged ABSENT even with a warn verdict present", async () => {
    const { agent, reg, svc, db } = setup({ observer: false });
    insertVerdict(db, agent.runId!, "warn", "rec-1");
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    await agent.promptRouted("do the thing");

    expect(svc.feedbackCalls).toHaveLength(1);
    const signals = sentSignals(svc.feedbackCalls[0] as Record<string, unknown>);
    expect("observer_flagged" in signals).toBe(false);
    reg.unregister();
    db.close();
  });

  test("invariant: a verdict changes ONLY the signals map — never outcome, quality, evidence_source, or verified_in_production", async () => {
    const bodies: Record<string, unknown>[] = [];
    for (const withVerdict of [false, true]) {
      const { agent, reg, svc, db } = setup({ observer: true });
      if (withVerdict) insertVerdict(db, agent.runId!, "warn", "rec-1");
      reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
      await agent.promptRouted("do the thing");
      expect(svc.feedbackCalls).toHaveLength(1);
      bodies.push(svc.feedbackCalls[0] as Record<string, unknown>);
      reg.unregister();
      db.close();
    }
    const [clean, flagged] = bodies as [Record<string, unknown>, Record<string, unknown>];
    expect(flagged.outcome).toBe(clean.outcome);
    expect(flagged.quality_score).toBe(clean.quality_score);
    expect(flagged.evidence_source).toBe(clean.evidence_source);
    expect(flagged.verified_in_production).toBe(clean.verified_in_production);
    expect(flagged.judged).toBe(clean.judged);
    // The judged path stays exactly what the judge said — the observer never grades.
    expect(flagged.outcome).toBe("success");
    expect(flagged.quality_score).toBe(0.9);
    expect(flagged.evidence_source).toBe("judge");
    expect(flagged.verified_in_production).toBe(false);
    // The ONLY difference: the observer_flagged key in the shared signals map.
    expect("observer_flagged" in sentSignals(clean)).toBe(false);
    expect(sentSignals(flagged).observer_flagged).toBe(true);
  });

  test("the controller stamps the turn_end rec_id onto verdicts (the join the bridge reads)", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj");
    const runId = db.startRun({ projectKey: "proj" });
    db.upsertPlanFromTodos(runId, [{ content: "fix the parser", status: "in_progress" }]);
    const c = new ObserverController({ db, runId, steer: () => {} });

    await c.consume({
      type: "tool_start",
      name: "edit",
      path: "tests/parser.test.ts",
      content: "x",
    });
    await c.consume({ type: "turn_end", assistantText: "tweaking the test", recId: "rec-x" });

    const verdicts = db.getObserverVerdicts(runId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.rec_id).toBe("rec-x");
    expect(verdicts[0]!.severity).toBe("warn");
    expect(db.hasObserverWarningsForRec("rec-x")).toBe(true);
    expect(db.hasObserverWarningsForRec("rec-y")).toBe(false);
    db.close();
  });
});
