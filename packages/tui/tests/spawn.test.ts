import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { type ChildEvent, createSpawn, delegationPrompt } from "../src/minima/spawn.ts";
import { taskTool } from "../src/tools/task.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${Math.random().toString(16).slice(2, 8)}`,
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
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return fetchLike;
}

function leadAgent(db: MinimaDb | null, runId: string | null): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: mockService() });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
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
  agent.runId = runId;
  return agent;
}

describe("createSpawn (default child factory)", () => {
  test("gate: child routes on its own model in its own workdir and returns text", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("child answer: 42")] })]);

    const wd = mkdtempSync(join(tmpdir(), "minima-spawn-"));
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const lead = leadAgent(db, runId);

    const events: ChildEvent[] = [];
    const spawn = createSpawn({ parent: lead, workdir: wd, onChildEvent: (e) => events.push(e) });
    const tool = taskTool({ spawn, spawnDepth: 0, maxDepth: 2 });

    const res = await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          {
            step_id: "answer",
            objective: "compute the answer",
            output_format: "one line",
            boundaries: "read-only",
            difficulty: "easy",
            effort: "light",
          },
        ]),
      },
      null,
      null,
    );

    const out = res.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
    expect(out).toContain("child answer: 42");
    expect(out).toContain("1 succeeded");

    // The child's decision row landed in the shared run, demuxed by agentId.
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.agent_id)).toStartWith("answer-");
    expect(rows[0]!.routed).toBe("server"); // the child routed via Minima itself

    // Tagged events flowed up (message + routing activity, all carrying the child id).
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.stepId))).toEqual(new Set(["answer"]));
    expect(events[0]!.depth).toBe(1);

    // The lead's own conversation is untouched by the child's run.
    expect(lead.agentState.messages).toHaveLength(0);

    reg.unregister();
    db.close();
    rmSync(wd, { recursive: true, force: true });
  });

  test("delegationPrompt carries the contract + dependency results", () => {
    const p = delegationPrompt(
      {
        step_id: "b",
        objective: "use A's output",
        output_format: "json",
        boundaries: "src/ only",
        depends_on: ["a"],
      },
      {
        depth: 1,
        parentSignal: null,
        priorResults: [
          {
            step_id: "a",
            childId: "a-1",
            text: "A RESULT",
            costUsd: 0,
            quality: null,
            outcome: "success",
            workdir: null,
          },
        ],
      },
    );
    expect(p).toContain("use A's output");
    expect(p).toContain("Return exactly");
    expect(p).toContain("do NOT touch");
    expect(p).toContain("A RESULT");
  });
});
