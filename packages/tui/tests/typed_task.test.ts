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
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  type HarnessConfig,
  harnessConfig,
} from "../src/minima/index.ts";
import { createSpawn, delegationPrompt } from "../src/minima/spawn.ts";
import { type ChildResult, type Delegation, type SpawnContext, taskTool } from "../src/tools/task.ts";

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
  return async (url: string, init?: { method?: string; body?: string }) => {
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
}

function leadAgent(over: Partial<HarnessConfig> = {}): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: mockService() });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
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
  return agent;
}

function reset(): ReturnType<typeof registerFauxProvider> {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX_MODEL);
  return registerFauxProvider([FAUX_MODEL]);
}

const OBJ_SCHEMA = {
  type: "object",
  properties: { answer: { type: "number" }, label: { type: "string" } },
  required: ["answer"],
};

function del(over: Partial<Delegation> = {}): Delegation {
  return {
    step_id: over.step_id ?? "s1",
    objective: "produce the answer",
    output_format: "a JSON object",
    boundaries: "read-only",
    effort: "light",
    ...over,
  } as Delegation;
}

const emptyCtx: SpawnContext = { depth: 1, parentSignal: null, priorResults: [] };
function reply(t: string): AssistantMessage {
  return new AssistantMessage({ content: [text(t)] });
}

describe("typed sub-agent outputs (W4.3)", () => {
  test("valid output is parsed into ChildResult.data with canonical text", async () => {
    const reg = reset();
    const value = { answer: 42, label: "ok" };
    reg.setResponses([reply(JSON.stringify(value))]);
    const wd = mkdtempSync(join(tmpdir(), "typed-valid-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(del({ step_id: "v", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect((r as ChildResult & { data?: unknown }).data).toEqual(value);
    expect(r.text).toBe(JSON.stringify(value, null, 2));
    expect(reg.state.callCount).toBe(1);
    expect(r.outcome).toBe("success");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("JSON is extracted from a fenced/prose reply", async () => {
    const reg = reset();
    reg.setResponses([reply("Here you go:\n```json\n{ \"answer\": 7 }\n```\nThanks.")]);
    const wd = mkdtempSync(join(tmpdir(), "typed-fence-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(del({ step_id: "f", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect((r as ChildResult & { data?: unknown }).data).toEqual({ answer: 7 });
    expect(reg.state.callCount).toBe(1);

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("invalid output is re-asked exactly once, then succeeds", async () => {
    const reg = reset();
    const value = { answer: 42, label: "ok" };
    reg.setResponses([reply(JSON.stringify({ answer: "forty-two" })), reply(JSON.stringify(value))]);
    const wd = mkdtempSync(join(tmpdir(), "typed-reask-ok-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(del({ step_id: "ra", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect(reg.state.callCount).toBe(2);
    expect((r as ChildResult & { data?: unknown }).data).toEqual(value);
    expect(r.outcome).toBe("success");
    const reask = reg.state.requests[1]!.user;
    expect(reask).toContain("answer");
    expect(reask).toContain("ONLY");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("still-invalid after one re-ask yields a typed failure, no third call", async () => {
    const reg = reset();
    reg.setResponses([
      reply(JSON.stringify({ answer: "nope" })),
      reply(JSON.stringify({ answer: "still-nope" })),
    ]);
    const wd = mkdtempSync(join(tmpdir(), "typed-reask-fail-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(del({ step_id: "rf", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect(reg.state.callCount).toBe(2);
    expect(r.outcome).toBe("failure");
    expect((r as ChildResult & { data?: unknown }).data).toBeUndefined();
    expect(r.text).toContain("answer");
    expect(r.costUsd).toBeGreaterThan(0);

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("delegationPrompt carries the STRICT output schema section", () => {
    const p = delegationPrompt(del({ step_id: "p", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);
    expect(p).toContain("## Output schema");
    expect(p).toContain('"answer"');
  });

  test("dependents receive the validated object, not prose", () => {
    const ctx: SpawnContext = {
      depth: 1,
      parentSignal: null,
      priorResults: [
        {
          step_id: "a",
          childId: "a-1",
          text: "some prose the model wrote",
          costUsd: 0,
          quality: null,
          outcome: "success",
          workdir: null,
          data: { answer: 99 },
        } as ChildResult & { data?: unknown },
      ],
    };
    const p = delegationPrompt(
      del({ step_id: "b", objective: "use a's output", depends_on: ["a"] }),
      ctx,
    );
    expect(p).toContain("(validated JSON)");
    expect(p).toContain('"answer"');
  });

  test("a failed typed child blocks its dependents", async () => {
    const reg = reset();
    reg.setResponses([
      reply(JSON.stringify({ answer: "bad" })),
      reply(JSON.stringify({ answer: "bad2" })),
    ]);
    const wd = mkdtempSync(join(tmpdir(), "typed-block-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });
    const tool = taskTool({ spawn });

    const res = await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          { step_id: "a", objective: "answer", output_format: "json", boundaries: "none", output_schema: OBJ_SCHEMA },
          { step_id: "b", objective: "use a", output_format: "text", boundaries: "none", depends_on: ["a"] },
        ]),
      },
      null,
      null,
    );
    const out = res.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
    expect(out).toContain("blocked: dependency a failed");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("flag off: a present schema is ignored end-to-end", async () => {
    const reg = reset();
    reg.setResponses([reply(JSON.stringify({ answer: "not-a-number" }))]);
    const wd = mkdtempSync(join(tmpdir(), "typed-off-"));
    const spawn = createSpawn({ parent: leadAgent({ typedTask: false } as Partial<HarnessConfig>), workdir: wd });

    const r = await spawn(del({ step_id: "off", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect(r.outcome).toBe("success");
    expect((r as ChildResult & { data?: unknown }).data).toBeUndefined();
    expect(reg.state.callCount).toBe(1);
    expect(r.text).toBe(JSON.stringify({ answer: "not-a-number" }));

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("schema-less delegation is unaffected (no schema section, no data)", async () => {
    const reg = reset();
    reg.setResponses([reply("plain prose answer, no JSON")]);
    const wd = mkdtempSync(join(tmpdir(), "typed-none-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const p = delegationPrompt(del({ step_id: "n" }), emptyCtx);
    expect(p).not.toContain("## Output schema");

    const r = await spawn(del({ step_id: "n" }), emptyCtx);
    expect(r.outcome).toBe("success");
    expect((r as ChildResult & { data?: unknown }).data).toBeUndefined();
    expect(r.text).toBe("plain prose answer, no JSON");
    expect(reg.state.callCount).toBe(1);

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("a BLOCKED: reply with a schema is not re-asked", async () => {
    const reg = reset();
    reg.setResponses([reply("BLOCKED: objective conflicts with boundaries")]);
    const wd = mkdtempSync(join(tmpdir(), "typed-blocked-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(del({ step_id: "bl", output_schema: OBJ_SCHEMA }) as Delegation, emptyCtx);

    expect(r.outcome).toBe("partial");
    expect(reg.state.callCount).toBe(1);
    expect((r as ChildResult & { data?: unknown }).data).toBeUndefined();

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("an exhausted step budget skips the re-ask", async () => {
    const reg = reset();
    reg.setResponses([reply(JSON.stringify({ answer: "bad" }))]);
    const wd = mkdtempSync(join(tmpdir(), "typed-budget-"));
    const spawn = createSpawn({ parent: leadAgent(), workdir: wd });

    const r = await spawn(
      del({ step_id: "bg", output_schema: OBJ_SCHEMA, budget_usd: 0 }) as Delegation,
      emptyCtx,
    );

    expect(r.outcome).toBe("failure");
    expect(reg.state.callCount).toBe(1);
    expect(r.text.toLowerCase()).toContain("budget");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });
});
