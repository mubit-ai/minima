import { describe, expect, test } from "bun:test";
import { type AgentTool, errorResult } from "../src/agent/tools.ts";
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

// A3 anti-spiral through the REAL runtime/loop wiring: a model that keeps calling the same failing
// tool is fed into the ring by the actual afterToolCall hook; the harness first steers it, then —
// when it persists — stops the run gracefully and leaves one audit `stop` gate. Hermetic.

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

/** A tool that always fails (returns errorResult → details.error). */
const failTool: AgentTool = {
  name: "failtool",
  description: "always fails",
  parameters: {
    jsonSchema: { type: "object", properties: { x: { type: "number" } } },
    validate: (v) => ({ ok: true, value: (v ?? {}) as Record<string, unknown> }),
  },
  async execute() {
    return errorResult("nope");
  },
};

/** A settled turn that calls the failing tool with the SAME args (same signature). */
const failCall = (i: number) =>
  new AssistantMessage({
    content: [toolCall(`c${i}`, "failtool", { x: 1 })],
    stop_reason: "toolUse",
  });

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

function setup(over: Partial<ReturnType<typeof harnessConfig>> = {}) {
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
    stopStrikes: 0, // isolate anti-spiral from the A2 stop-gate
    stepCap: 0, // isolate the doom-loop detector from the turn cap
    spiralRepeats: 3,
    ...over,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  const agent = new MinimaAgent({
    config,
    router,
    meter: new CostMeter(),
    tools: [failTool],
  });
  agent.db = db;
  agent.runId = runId;
  // A Big Plan exists (as in real use); the audit stop gate attaches to it. A2 is off
  // (stopStrikes:0), so the in_progress step does not itself force continuation.
  db.upsertPlanFromTodos(runId, [{ content: "work", status: "in_progress" }]);
  return { agent, reg, db, runId, recommendCalls };
}

describe("A3 anti-spiral — runtime integration", () => {
  test("a repeated failing tool call is steered, then stopped, with one audit gate", async () => {
    const { agent, reg, db, runId, recommendCalls } = setup();
    reg.setResponses([failCall(1), failCall(2), failCall(3), failCall(4), failCall(5)]);

    await agent.promptRouted("do the thing");

    // Graceful stop (not an error) → no escalation.
    expect(recommendCalls).toHaveLength(1);
    // Consumed turns 1–4 (3 to detect + 1 that confirms persistence) → 1 response left.
    expect(reg.state.pendingResponseCount).toBe(1);
    // The steer reached the model's context.
    const steered = agent.agentState.messages.some(
      (m) => m.role === "user" && m.textContent.includes("stuck in a loop"),
    );
    expect(steered).toBe(true);
    // Exactly one audit stop gate, tagged doom_loop, invisible to the feedback join.
    const plan = db.getActivePlan(runId)!;
    const stops = db.getGates(plan.id).filter((g) => g.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(JSON.parse(stops[0]!.factors_json ?? "{}")).toMatchObject({ reason: "doom_loop" });
    expect(stops[0]!.rec_id).toBeNull();
  });

  test("spiralRepeats=0 disables the detector (the loop runs until responses exhaust)", async () => {
    const { agent, reg, db, runId } = setup({ spiralRepeats: 0 });
    reg.setResponses([failCall(1), failCall(2), failCall(3), failCall(4)]);

    await agent.promptRouted("do the thing");

    expect(reg.state.pendingResponseCount).toBe(0); // never intervened
    const plan = db.getActivePlan(runId)!;
    expect(db.getGates(plan.id).filter((g) => g.kind === "stop")).toHaveLength(0);
  });
});
