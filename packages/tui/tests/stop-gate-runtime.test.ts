import { describe, expect, test } from "bun:test";
import type { AgentTool } from "../src/agent/tools.ts";
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
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { type AskUserRef, questionTool } from "../src/tools/question.ts";

// A2 stop-gate through the REAL runtime/loop wiring: with big-plan on and an active plan whose
// step is still in_progress, promptRouted must force-continue the model instead of letting it end,
// and — once strikes are spent, headless (no ask channel) — stop gracefully and leave one audit
// `stop` gate row. Hermetic: faux provider + injected fetch, no network.

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const recommendCalls: string[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ?? "");
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
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
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, recommendCalls };
}

function setup(stopStrikes: number, askUser: AskUserRef | null, tools: AgentTool[] = []) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX);
  const reg = registerFauxProvider([FAUX]);
  const { fetchLike, recommendCalls } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: true,
    stopStrikes,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  const agent = new MinimaAgent({ config, router, meter: new CostMeter(), tools });
  agent.db = db;
  agent.runId = runId;
  if (askUser) agent.askUser = askUser;
  return { agent, reg, db, runId, recommendCalls };
}

/** A terminal turn (no tool calls) — the agent trying to end the run. */
const bail = () => new AssistantMessage({ content: [text("all set!")], stop_reason: "stop" });

describe("A2 stop-gate — runtime integration", () => {
  test("headless: an in_progress plan forces continuation, then stops with one audit gate", async () => {
    const { agent, reg, db, runId, recommendCalls } = setup(2, null);
    db.upsertPlanFromTodos(runId, [{ content: "wire it", status: "in_progress" }]);
    // Three bail turns: deny (strike 1) → deny (strike 2) → strikes spent, headless → stop.
    reg.setResponses([bail(), bail(), bail()]);

    await agent.promptRouted("do the thing");

    // Graceful stop (not an error) → no escalation.
    expect(recommendCalls).toHaveLength(1);
    // The run consumed all three scripted turns (2 forced continuations + the final stop).
    expect(reg.state.pendingResponseCount).toBe(0);
    const plan = db.getActivePlan(runId)!;
    const stops = db.getGates(plan.id).filter((g) => g.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.rec_id).toBeNull();
  });

  test("a completed plan lets the run end immediately (no stop gate, no extra turns)", async () => {
    const { agent, reg, db, runId, recommendCalls } = setup(2, null);
    db.upsertPlanFromTodos(runId, [{ content: "wire it", status: "completed" }]);
    reg.setResponses([bail(), bail(), bail()]);

    await agent.promptRouted("do the thing");

    expect(recommendCalls).toHaveLength(1);
    // Only the first turn ran — the natural stop was allowed.
    expect(reg.state.pendingResponseCount).toBe(2);
    const plan = db.getActivePlan(runId)!;
    expect(db.getGates(plan.id).filter((g) => g.kind === "stop")).toHaveLength(0);
  });

  test("stopStrikes=0 disables the gate — the run ends on the first bail", async () => {
    const { agent, reg, db, runId } = setup(0, null);
    db.upsertPlanFromTodos(runId, [{ content: "wire it", status: "in_progress" }]);
    reg.setResponses([bail(), bail()]);

    await agent.promptRouted("do the thing");

    expect(reg.state.pendingResponseCount).toBe(1);
    const plan = db.getActivePlan(runId)!;
    expect(db.getGates(plan.id).filter((g) => g.kind === "stop")).toHaveLength(0);
  });

  test("a stale older active does not gate when the current plan is done (MUB-181)", async () => {
    const { agent, reg, db, runId } = setup(2, null);
    db.upsertPlanFromTodos(runId, [{ content: "old work", status: "in_progress" }]);
    const current = db.insertPlan({ sessionId: runId, title: "current", status: "done" });
    db.insertStep({ planId: current, idx: 0, content: "new work", status: "completed" });
    reg.setResponses([bail(), bail()]);

    await agent.promptRouted("do the thing");

    // The run ends on the first bail — the stale active is not the plan of record.
    expect(reg.state.pendingResponseCount).toBe(1);
    const stale = db.getActivePlan(runId)!;
    expect(db.getGates(stale.id).filter((g) => g.kind === "stop")).toHaveLength(0);
  });

  test("a question answered mid-run suppresses the gate on the following reply (MUB-181)", async () => {
    const qRef: AskUserRef = { current: async () => "continue chatting" };
    const { agent, reg, db, runId } = setup(2, null, [questionTool(qRef)]);
    db.upsertPlanFromTodos(runId, [{ content: "wire it", status: "in_progress" }]);
    reg.setResponses([
      new AssistantMessage({
        content: [
          toolCall("q1", "question", { question: "Keep going?", options: ["continue chatting"] }),
        ],
        stop_reason: "toolUse",
      }),
      bail(),
      bail(),
    ]);

    await agent.promptRouted("do the thing");

    // The reply after the answered question ends the run: no forced continuation consumed
    // the third scripted response, and no audit stop gate was written.
    expect(reg.state.pendingResponseCount).toBe(1);
    const plan = db.getActivePlan(runId)!;
    expect(db.getGates(plan.id).filter((g) => g.kind === "stop")).toHaveLength(0);
  });
});
