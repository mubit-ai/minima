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
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// D2: cheap ledger-derived implicit signals ride every routed feedback — `retried`
// (ladder re-run), `user_corrected` (reject/steer on a gate under this rec), and
// `session_continued` (later prompts in the session). Label-model input only: the
// evidence_source / verified_in_production provenance fields are untouched by them.
// Omit-absent contract: a key is sent only when observed (false = observed and did
// not fire); an unobservable signal (no ledger) is omitted, never defaulted to false.

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function judgeReturning(score: number | null) {
  return { async grade(): Promise<number | null> {
    return score;
  } };
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

function setup(judge: { grade(): Promise<number | null> }) {
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
    bigPlan: true,
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

describe("feedback: implicit signals (D2)", () => {
  let judge: { grade(): Promise<number | null> };
  beforeEach(() => {
    judge = judgeReturning(0.9);
  });

  test("first routed prompt sends all-false signals", async () => {
    const { agent, reg, feedbackCalls, db } = setup(judge);

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(1);
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.signals).toEqual({
      retried: false,
      user_corrected: false,
      session_continued: false,
    });
    reg.unregister();
    db.close();
  });

  test("without a ledger, user_corrected is absent — never a fabricated false", async () => {
    const { agent, reg, feedbackCalls, db } = setup(judge);
    agent.db = null;

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(1);
    const fb = feedbackCalls[0] as Record<string, unknown>;
    const signals = fb.signals as Record<string, boolean>;
    expect(signals.retried).toBe(false);
    expect(signals.session_continued).toBe(false);
    expect("user_corrected" in signals).toBe(false);
    reg.unregister();
    db.close();
  });

  test("a reject on this rec's gate sets user_corrected; accept does not", async () => {
    const { agent, reg, feedbackCalls, db, runId } = setup(judge);
    const { planId, stepIds } = db.upsertPlanFromTodos(runId, [
      { content: "wire it", status: "in_progress" },
    ]);
    const gateId = db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      verifiedBy: "deterministic",
      confidence: "green",
      recId: "rec-1",
      sessionId: runId,
    });
    db.recordUserSignal(gateId, "accept");
    expect(db.hasUserCorrectionForRec("rec-1")).toBe(false);
    db.recordUserSignal(gateId, "reject");
    expect(db.hasUserCorrectionForRec("rec-1")).toBe(true);
    expect(db.hasUserCorrectionForRec("rec-other")).toBe(false);

    await agent.promptRouted("do the thing");

    const fb = feedbackCalls[0] as Record<string, unknown>;
    const signals = fb.signals as Record<string, boolean>;
    expect(signals.user_corrected).toBe(true);
    // Signals never touch provenance: the green gate verdict still owns the label.
    expect(fb.evidence_source).toBe("gate");
    expect(fb.verified_in_production).toBe(true);
    reg.unregister();
    db.close();
  });

  test("recovery-ladder rung sends retried=true (first rung false)", async () => {
    judge = judgeReturning(0.1); // below threshold_used=0.5 -> ladder retries
    const { agent, reg, feedbackCalls, db } = setup(judge);
    agent.recoveryRungs = 1;
    reg.setResponses([
      new AssistantMessage({ content: [text("weak answer")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("weak again")], stop_reason: "stop" }),
    ]);

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(2);
    const first = feedbackCalls[0] as Record<string, unknown>;
    const second = feedbackCalls[1] as Record<string, unknown>;
    expect((first.signals as Record<string, boolean>).retried).toBe(false);
    expect((second.signals as Record<string, boolean>).retried).toBe(true);
    reg.unregister();
    db.close();
  });

  test("later prompts in the session send session_continued=true", async () => {
    const { agent, reg, feedbackCalls, db } = setup(judge);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("two")], stop_reason: "stop" }),
    ]);

    await agent.promptRouted("first task");
    await agent.promptRouted("second task");

    expect(feedbackCalls).toHaveLength(2);
    expect((feedbackCalls[0]?.signals as Record<string, boolean>).session_continued).toBe(false);
    expect((feedbackCalls[1]?.signals as Record<string, boolean>).session_continued).toBe(true);
    reg.unregister();
    db.close();
  });
});
