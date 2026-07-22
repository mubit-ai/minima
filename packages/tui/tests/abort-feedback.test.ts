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
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import type { QualityJudge } from "../src/minima/judge.ts";
import { buildFeedbackNotes } from "../src/minima/runtime.ts";

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
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
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, feedbackCalls };
}

function setup(judge: QualityJudge, opts: { bigPlan?: boolean } = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX);
  const reg = registerFauxProvider([FAUX]);
  const svc = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: opts.bigPlan ?? false,
    stopStrikes: 0,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge, meter: new CostMeter(), tools: [] });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  agent.db = db;
  agent.runId = db.startRun({ projectKey: "p" });
  return { agent, reg, svc, db };
}

describe("aborted turns never reach the judge", () => {
  test("stop_reason 'aborted' → no judge.grade call, unlabeled telemetry with an abort note", async () => {
    let judgeCalls = 0;
    const judge: QualityJudge = {
      grade: async () => {
        judgeCalls += 1;
        return 0.9;
      },
    };
    const { agent, reg, svc, db } = setup(judge);
    reg.setResponses([
      new AssistantMessage({
        content: [text("partial ans…\n\n[aborted by user]")],
        stop_reason: "aborted",
      }),
    ]);

    await agent.promptRouted("long task the user Esc'd out of");

    expect(judgeCalls).toBe(0);
    expect(svc.feedbackCalls).toHaveLength(1);
    const fb = svc.feedbackCalls[0] as Record<string, unknown>;
    expect(fb.quality_score).toBeUndefined();
    expect(fb.outcome).toBe("success");
    expect(fb.evidence_source).toBe("none");
    expect(fb.judged).toBe(false);
    expect(String(fb.notes)).toContain("aborted");
    reg.unregister();
    db.close();
  });

  test("a normal turn with the same judge still grades (the skip is abort-specific)", async () => {
    let judgeCalls = 0;
    const judge: QualityJudge = {
      grade: async () => {
        judgeCalls += 1;
        return 0.9;
      },
    };
    const { agent, reg, svc, db } = setup(judge);
    reg.setResponses([new AssistantMessage({ content: [text("full answer")] })]);
    await agent.promptRouted("task");
    expect(judgeCalls).toBe(1);
    const fb = svc.feedbackCalls[0] as Record<string, unknown>;
    expect(fb.evidence_source).toBe("judge");
    expect(String(fb.notes ?? "")).not.toContain("aborted");
    reg.unregister();
    db.close();
  });

  test("a deterministic gate verdict for the rung still outranks the abort", async () => {
    let judgeCalls = 0;
    const judge: QualityJudge = {
      grade: async () => {
        judgeCalls += 1;
        return 0.9;
      },
    };
    const { agent, reg, svc, db } = setup(judge, { bigPlan: true });
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
    reg.setResponses([
      new AssistantMessage({ content: [text("[aborted by user]")], stop_reason: "aborted" }),
    ]);

    await agent.promptRouted("task");

    expect(judgeCalls).toBe(0);
    const fb = svc.feedbackCalls[0] as Record<string, unknown>;
    expect(fb.evidence_source).toBe("gate");
    expect(fb.verified_in_production).toBe(true);
    expect(String(fb.notes)).toContain("verified_by=deterministic");
    expect(String(fb.notes)).toContain("aborted");
    reg.unregister();
    db.close();
  });
});

describe("buildFeedbackNotes abort marker", () => {
  test("unlabeled + aborted", () => {
    expect(buildFeedbackNotes(null, false, null, true)).toBe("unlabeled;aborted");
  });
  test("judged turn stays undefined without an abort", () => {
    expect(buildFeedbackNotes(null, true, null, false)).toBeUndefined();
  });
  test("recovery rung + abort compose", () => {
    expect(buildFeedbackNotes(null, false, "retry_step", true)).toBe(
      "unlabeled;recovery=retry_step;aborted",
    );
  });
});
