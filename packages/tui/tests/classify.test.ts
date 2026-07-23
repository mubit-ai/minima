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
import { BudgetLedger } from "../src/minima/budget.ts";
import { TaskClassifier, parseClassification } from "../src/minima/classify.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const MAIN: Model = {
  id: "main-model",
  provider: "faux",
  api: "faux",
  name: "Main",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const CLS: Model = {
  id: "cls-model",
  provider: "faux",
  api: "faux",
  name: "Classifier",
  cost: { input: 0.5, output: 1 },
  context_window: 8192,
  max_tokens: 4096,
};

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
            model_id: "main-model",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "main-model",
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
          classification_profile: {
            task_type_source: "heuristic",
            difficulty_source: "heuristic",
            heuristic_task_type: "qa",
            heuristic_difficulty: "easy",
            final_task_type: "code",
            final_difficulty: "easy",
            uncertainty: 0.2,
            confidence: 0.8,
          },
          cluster_key_version: "v1",
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

function setup(opts: { classify?: boolean; onCostUsd?: (usd: number) => void } = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(MAIN);
  registerModel(CLS);
  const reg = registerFauxProvider([MAIN, CLS]);
  const svc = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["main-model"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: false,
    stopStrikes: 0,
    classify: opts.classify ?? true,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  agent.classifier = new TaskClassifier(CLS, { onCostUsd: opts.onCostUsd });
  return { agent, reg, svc };
}

/** Faux requests issued to the classifier model (vs the routed main model). */
function classifierCalls(reg: ReturnType<typeof registerFauxProvider>): number {
  return reg.state.requests.filter((r) => r.model === "cls-model").length;
}

describe("parseClassification", () => {
  test("tiny JSON parses", () => {
    expect(parseClassification('{"task_type":"code","difficulty":"hard","confidence":0.9}')).toEqual(
      { taskType: "code", difficulty: "hard", confidence: 0.9 },
    );
  });
  test("three labeled lines parse", () => {
    expect(parseClassification("task_type: qa\ndifficulty: easy\nconfidence: 0.75")).toEqual({
      taskType: "qa",
      difficulty: "easy",
      confidence: 0.75,
    });
  });
  test("fenced JSON parses", () => {
    expect(
      parseClassification('```json\n{"task_type":"rag","difficulty":"medium","confidence":1}\n```'),
    ).toEqual({ taskType: "rag", difficulty: "medium", confidence: 1 });
  });
  test("fail-closed on junk, out-of-enum, and out-of-range confidence", () => {
    expect(parseClassification("no idea")).toBeNull();
    expect(parseClassification('{"task_type":"poetry","difficulty":"hard","confidence":0.9}')).toBeNull();
    expect(parseClassification('{"task_type":"code","difficulty":"hard","confidence":1.4}')).toBeNull();
    expect(parseClassification("")).toBeNull();
  });
});

describe("client-side classification (MINIMA_TUI_CLASSIFY)", () => {
  test("flag off → no classify call, no task_type on the wire", async () => {
    const { agent, reg, svc } = setup({ classify: false });
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("write a parser");
    expect(classifierCalls(reg)).toBe(0);
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBeUndefined();
    expect(task.task_type_confidence).toBeUndefined();
    reg.unregister();
  });

  test("flag on, confident label → task_type + confidence ride; difficulty NEVER does (PR-7)", async () => {
    const { agent, reg, svc } = setup();
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.9}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    expect(classifierCalls(reg)).toBe(1);
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBe("code");
    expect(task.difficulty).toBeUndefined();
    expect(task.task_type_confidence).toBe(0.9);
    reg.unregister();
  });

  test("0.7 confidence sits below the raised 0.75 floor → no override", async () => {
    const { agent, reg, svc } = setup();
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.7}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBeUndefined();
    reg.unregister();
  });

  test("low confidence (0.4) → no override sent", async () => {
    const { agent, reg, svc } = setup();
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.4}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBeUndefined();
    expect(task.difficulty).toBeUndefined();
    expect(task.task_type_confidence).toBeUndefined();
    reg.unregister();
  });

  test("unparseable reply → fail-open, the turn still routes and runs", async () => {
    const { agent, reg, svc } = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("cannot say")] }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    const routing = await agent.promptRouted("write a parser");
    expect(routing?.chosenModelId).toBe("main-model");
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBeUndefined();
    reg.unregister();
  });

  test("an explicit taskType suppresses the classify call entirely", async () => {
    const { agent, reg, svc } = setup();
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("write a parser", { taskType: "code" });
    expect(classifierCalls(reg)).toBe(0);
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBe("code");
    expect(task.task_type_confidence).toBeUndefined();
    reg.unregister();
  });

  test("sub-agent lanes never classify (agentId set)", async () => {
    const { agent, reg } = setup();
    agent.agentId = "child-1";
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("child subtask");
    expect(classifierCalls(reg)).toBe(0);
    reg.unregister();
  });

  test("cache hit: two identical prompts → exactly one classifier completion", async () => {
    const { agent, reg } = setup();
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.9}')],
      }),
      new AssistantMessage({ content: [text("answer one")] }),
      new AssistantMessage({ content: [text("answer two")] }),
    ]);
    await agent.promptRouted("write a parser");
    await agent.promptRouted("write a parser");
    expect(classifierCalls(reg)).toBe(1);
    reg.unregister();
  });

  test("classifier spend books as wallet overhead, never into feedback cost", async () => {
    let booked = 0;
    const db = new MinimaDb(":memory:");
    const { agent, reg, svc } = setup({
      onCostUsd: (usd) => {
        booked += usd;
        agent.meter?.addOverhead(usd);
        agent.budget?.bookSpend(usd, "classify");
      },
    });
    agent.budget = new BudgetLedger({ db, scopeKey: "s", limitUsd: 5, mode: "warn" });
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.9}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    expect(booked).toBeGreaterThan(0);
    expect(agent.meter!.totals().overheadUsd).toBeCloseTo(booked, 12);
    const fb = svc.feedbackCalls[0] as Record<string, unknown>;
    expect(fb.actual_cost_usd).toBe(agent.meter!.rows[0]!.actualCostUsd);
    const spendRow = db.db
      .query("SELECT note FROM budget_events WHERE kind = 'book'")
      .get() as { note: string } | null;
    expect(spendRow?.note).toBe("classify");
    reg.unregister();
    db.close();
  });
});


describe("agreement telemetry (classifier program PR-1)", () => {
  function withDb(agent: MinimaAgent) {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });
    return db;
  }

  test("confident client label vs server heuristic → disagreement row stamped", async () => {
    const { agent, reg } = setup();
    const db = withDb(agent);
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"code","difficulty":"hard","confidence":0.9}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    const row = db.getRunDecisions(agent.runId!)[0] as Record<string, unknown>;
    expect(row.client_task_type).toBe("code");
    expect(row.client_difficulty).toBe("hard");
    expect(row.client_confidence).toBe(0.9);
    expect(row.heuristic_task_type).toBe("qa");
    expect(row.heuristic_difficulty).toBe("easy");
    expect(row.classify_disagreement).toBe(1);
    expect(row.cluster_key_version).toBe("v1");
    reg.unregister();
  });

  test("below-floor label is telemetry, not an override: stamped but not on the wire", async () => {
    const { agent, reg, svc } = setup();
    const db = withDb(agent);
    reg.setResponses([
      new AssistantMessage({
        content: [text('{"task_type":"qa","difficulty":"easy","confidence":0.4}')],
      }),
      new AssistantMessage({ content: [text("answer")] }),
    ]);
    await agent.promptRouted("write a parser");
    const task = (svc.recommendCalls[0] as { task: Record<string, unknown> }).task;
    expect(task.task_type).toBeUndefined();
    const row = db.getRunDecisions(agent.runId!)[0] as Record<string, unknown>;
    expect(row.client_task_type).toBe("qa");
    expect(row.client_confidence).toBe(0.4);
    expect(row.classify_disagreement).toBe(0); // agrees with the mock's heuristic "qa"
    reg.unregister();
  });

  test("classify off → telemetry columns NULL, cluster_key_version still stamped", async () => {
    const { agent, reg } = setup({ classify: false });
    const db = withDb(agent);
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("write a parser");
    const row = db.getRunDecisions(agent.runId!)[0] as Record<string, unknown>;
    expect(row.client_task_type).toBeNull();
    expect(row.client_confidence).toBeNull();
    expect(row.classify_disagreement).toBeNull();
    expect(row.cluster_key_version).toBe("v1");
    reg.unregister();
  });
});
