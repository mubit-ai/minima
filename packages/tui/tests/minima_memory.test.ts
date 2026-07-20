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
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import type { HarnessMemory, OutcomeRecord } from "../src/minima/memory.ts";
import { NoopHarnessMemory } from "../src/minima/memory.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-xyz",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
            rationale: "cheapest viable",
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
  return { fetchLike };
}

/** Records recall + write-back calls so tests can assert the loop is wired. */
class FakeMemory implements HarnessMemory {
  recallCalls: string[] = [];
  outcomeCalls: OutcomeRecord[] = [];
  endCalls = 0;
  constructor(private readonly snippets: string[] = []) {}
  async recall(task: string): Promise<string[]> {
    this.recallCalls.push(task);
    return [...this.snippets];
  }
  async recordOutcome(record: OutcomeRecord): Promise<void> {
    this.outcomeCalls.push(record);
  }
  async endSession(): Promise<void> {
    this.endCalls += 1;
  }
}

function buildAgent(opts: {
  memory?: HarnessMemory;
  judge?: { grade: (t: string, o: string) => Promise<number | null> };
  systemPrompt?: string;
  failing?: boolean;
  groundTruth?: boolean;
  beforeRoute?: (r: unknown, t: string) => Promise<null>;
}) {
  const fetchLike = opts.failing
    ? async () => ({ status: 500, json: async () => ({ detail: "down" }) })
    : mockService().fetchLike;
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["test-faux"],
    allowOffline: opts.failing ?? false,
    minimaApiKey: "k",
    groundTruth: opts.groundTruth ?? false,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: opts.judge ?? new ConstJudge(0.9),
    memory: opts.memory,
    systemPrompt: opts.systemPrompt,
    beforeRoute: opts.beforeRoute as never,
  });
}

describe("MinimaAgent <-> Mubit memory", () => {
  test("recall injected into system prompt then restored; outcome written with attribution", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("42")], stop_reason: "stop" })]);

    const mem = new FakeMemory(["prefer an expert model for GraphQL resolvers"]);
    let seenSystem: string | null = null;
    const agent = buildAgent({
      memory: mem,
      systemPrompt: "BASE",
      // beforeRoute fires after recall augmented the prompt, before the model runs.
      beforeRoute: async () => {
        seenSystem = agent.agentState.systemPrompt;
        return null;
      },
    });

    await agent.promptRouted("build a GraphQL resolver");

    expect(mem.recallCalls).toEqual(["build a GraphQL resolver"]);
    expect(seenSystem ?? "").toContain("prefer an expert model for GraphQL resolvers");
    expect(seenSystem ?? "").toContain("BASE");
    expect(agent.agentState.systemPrompt).toBe("BASE"); // restored, no leak

    expect(mem.outcomeCalls).toHaveLength(1);
    expect(mem.outcomeCalls[0]!.recommendationId).toBe("rec-xyz");
    expect(mem.outcomeCalls[0]!.modelId).toBe("test-faux");
    expect(mem.outcomeCalls[0]!.outcome).toBe("success");
    expect(mem.outcomeCalls[0]!.quality).toBe(0.9);
    expect(mem.outcomeCalls[0]!.turns).toBeGreaterThanOrEqual(1);
    reg.unregister();
  });

  test("judge abstention -> quality null passed to memory (no fabrication)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const mem = new FakeMemory();
    const agent = buildAgent({ memory: mem, judge: { grade: async () => null } });
    await agent.promptRouted("do something");
    expect(mem.outcomeCalls[0]!.quality).toBeNull();
    reg.unregister();
  });

  // The plan-authoring gap: the verify contract must reach the model on turn 1 — BEFORE any plan
  // exists — or it authors the whole plan with no checks (the plan projection alone is inert until
  // the first todowrite). The static guidance is injected whenever groundTruth is on and reverted
  // like recall, so it leaks into no later turn and never appears when the flag is off.
  test("ground-truth ON injects the verify contract on turn 1 (no plan yet), then restores it", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);

    let seenSystem: string | null = null;
    const agent = buildAgent({
      systemPrompt: "BASE",
      groundTruth: true,
      beforeRoute: async () => {
        seenSystem = agent.agentState.systemPrompt;
        return null;
      },
    });
    // No agent.db / no plan — planProjectionFor is null, so only the static contract can appear.
    await agent.promptRouted("scaffold a project");

    expect(seenSystem ?? "").toContain("Ground-Truth verification is ON");
    expect(seenSystem ?? "").toContain("`verify`");
    expect(seenSystem ?? "").toContain("BASE");
    expect(agent.agentState.systemPrompt).toBe("BASE"); // reverted — no leak into later turns
    reg.unregister();
  });

  test("ground-truth OFF injects no verify contract", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);

    let seenSystem: string | null = null;
    const agent = buildAgent({
      systemPrompt: "BASE",
      groundTruth: false,
      beforeRoute: async () => {
        seenSystem = agent.agentState.systemPrompt;
        return null;
      },
    });
    await agent.promptRouted("scaffold a project");

    expect(seenSystem ?? "").toBe("BASE");
    reg.unregister();
  });

  test("offline route -> recall still runs, but no outcome write (nothing to attribute)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("offline")] })]);

    const mem = new FakeMemory(["x"]);
    const agent = buildAgent({ memory: mem, failing: true });
    const routing = await agent.promptRouted("hi");
    expect(routing).toBeNull();
    expect(mem.recallCalls).toEqual(["hi"]);
    expect(mem.outcomeCalls).toHaveLength(0);
    reg.unregister();
  });

  test("default memory is NoopHarnessMemory (no behavior change)", () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const agent = buildAgent({});
    expect(agent.memory).toBeInstanceOf(NoopHarnessMemory);
    reg.unregister();
  });

  test("endSession delegates to memory", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const mem = new FakeMemory();
    const agent = buildAgent({ memory: mem });
    await agent.endSession();
    expect(mem.endCalls).toBe(1);
    reg.unregister();
  });
});
