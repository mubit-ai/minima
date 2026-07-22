/**
 * Per-step candidate pools: migration + seed round-trip, BigPlan.md rendering, and the
 * createSpawn dispatcher enforcement (registry filter, parent-pool fallback, 422 retry).
 * Hermetic: mock fetch + faux provider; no network, no spend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessage,
  type FauxRegistration,
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
import { finalizePlan } from "../src/minima/plan_finalize.ts";
import { type BigPlanSynthesis, PlanSessionStore } from "../src/minima/plan_session.ts";
import { createSpawn, isNoCandidatesRouteError } from "../src/minima/spawn.ts";
import type { Delegation, SpawnContext } from "../src/tools/task.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const CLAUDE: Model = {
  ...FAUX_MODEL,
  id: "claude-x",
  provider: "anthropic",
  api: "anthropic-messages",
};
const GPT: Model = { ...FAUX_MODEL, id: "gpt-x", provider: "openai", api: "openai-completions" };

const META: Model = { ...FAUX_MODEL, id: "meta-model" };

const synth = (over: Partial<BigPlanSynthesis> = {}): BigPlanSynthesis => ({
  title: "Ship it",
  goal: "ship",
  overview: "",
  requirements: [],
  constraints: [],
  decisions: [],
  approach: [{ action: "wire endpoint", verify: "bun test endpoint", tools: [] }],
  risks: [],
  successCriteria: [],
  openItems: [],
  ...over,
});

describe("plan_steps.candidates migration + seed round-trip", () => {
  test("fresh DB has the candidates column, NULL by default", () => {
    const db = new MinimaDb(":memory:");
    const cols = db.db.query("PRAGMA table_info(plan_steps)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("candidates");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { planId } = db.seedPlanFromSteps(runId, "t", [{ content: "step one" }]);
    expect(db.getPlanSteps(planId)[0]!.candidates).toBeNull();
  });

  test("reopening an already-migrated file DB is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-pools-"));
    const path = join(dir, "m.db");
    try {
      new MinimaDb(path).db.close();
      const again = new MinimaDb(path);
      const cols = again.db.query("PRAGMA table_info(plan_steps)").all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain("candidates");
      again.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("seedPlanFromSteps persists a step pool as JSON and keeps check_origin='user'", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { planId } = db.seedPlanFromSteps(runId, "t", [
      { content: "pooled step", verify: "bun test", candidates: ["claude-x", " gpt-x "] },
      { content: "plain step", verify: "bun run check" },
    ]);
    const steps = db.getPlanSteps(planId);
    expect(JSON.parse(steps[0]!.candidates ?? "null")).toEqual(["claude-x", "gpt-x"]);
    expect(steps[0]!.check_origin).toBe("user");
    expect(steps[1]!.candidates).toBeNull();
  });

  test("finalizePlan carries synthesized step pools into the seeded ledger", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const out = await finalizePlan(new PlanSessionStore("goal"), {
      metaModel: META,
      signal: null,
      force: false,
      transcript: "",
      outPath: "/fake/BigPlan.md",
      db,
      runId,
      write: async () => {},
      answerQuestions: async () => [],
      synthesize: async () =>
        synth({
          approach: [
            { action: "pooled", verify: "bun test", tools: [], candidates: ["claude-x"] },
            { action: "plain", verify: "bun run check", tools: [] },
          ],
        }),
      critic: async () => null,
    });
    expect(out.kind).toBe("ok");
    const plan = db.getActivePlan(runId);
    const steps = db.getPlanSteps(plan!.id);
    expect(JSON.parse(steps[0]!.candidates ?? "null")).toEqual(["claude-x"]);
    expect(steps[1]!.candidates).toBeNull();
  });
});

describe("BigPlan.md rendering", () => {
  test("a step pool renders as a models suffix line; poolless steps have none", () => {
    const store = new PlanSessionStore("goal");
    const md = store.toBigPlan(
      synth({
        approach: [
          {
            action: "pooled step",
            verify: "bun test",
            tools: ["edit"],
            candidates: ["claude-x", "gpt-x"],
          },
          { action: "plain step", verify: "bun run check", tools: [] },
        ],
      }),
    );
    expect(md).toContain("   - models: claude-x, gpt-x");
    expect(md.match(/- models:/g) ?? []).toHaveLength(1);
    expect(md).toContain("1. pooled step");
    expect(md).toContain("2. plain step");
  });
});

// ---------------------------------------------------------------- spawn enforcement

function mockService(opts: { reject?: (candidates: string[] | undefined) => boolean } = {}) {
  const candidateLists: (string[] | undefined)[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      const body = init?.body ? JSON.parse(init.body) : {};
      const candidates = body?.constraints?.candidate_models as string[] | undefined;
      candidateLists.push(candidates);
      if (opts.reject?.(candidates)) {
        return {
          status: 422,
          json: async () => ({ detail: "no candidate models satisfy the constraints" }),
        };
      }
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${candidateLists.length}`,
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
  return { fetchLike, candidateLists };
}

function leadAgent(fetchLike: ReturnType<typeof mockService>["fetchLike"]): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const config = harnessConfig({
    candidates: ["claude-x", "gpt-x"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
}

const ctx: SpawnContext = { depth: 1, parentSignal: null, priorResults: [] };

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  step_id: "s1",
  objective: "answer",
  output_format: "text",
  boundaries: "none",
  ...over,
});

describe("createSpawn per-step candidate pools", () => {
  let reg: FauxRegistration;
  let wd: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(CLAUDE);
    registerModel(GPT);
    registerModel(FAUX_MODEL);
    reg = registerFauxProvider([FAUX_MODEL]);
    wd = mkdtempSync(join(tmpdir(), "minima-pools-"));
    saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
  });

  afterEach(() => {
    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.o;
  });

  test("a valid step pool reaches the recommend wire as constraints.candidate_models", async () => {
    const { fetchLike, candidateLists } = mockService();
    const lead = leadAgent(fetchLike);
    reg.setResponses([new AssistantMessage({ content: [text("done")] })]);
    const res = await createSpawn({ parent: lead, workdir: wd })(
      delegation({ candidates: ["claude-x"] }),
      ctx,
    );
    expect(res.outcome).toBe("success");
    expect(candidateLists).toEqual([["claude-x"]]);
    expect(lead.config.candidates).toEqual(["claude-x", "gpt-x"]);
  });

  test("an unknown-model pool falls back to the parent pool", async () => {
    const { fetchLike, candidateLists } = mockService();
    const lead = leadAgent(fetchLike);
    reg.setResponses([new AssistantMessage({ content: [text("done")] })]);
    const res = await createSpawn({ parent: lead, workdir: wd })(
      delegation({ candidates: ["not-a-registered-model"] }),
      ctx,
    );
    expect(res.outcome).toBe("success");
    expect(candidateLists).toEqual([["claude-x", "gpt-x"]]);
  });

  test("a pool that is empty after trimming falls back to the parent pool", async () => {
    const { fetchLike, candidateLists } = mockService();
    const lead = leadAgent(fetchLike);
    reg.setResponses([new AssistantMessage({ content: [text("done")] })]);
    const res = await createSpawn({ parent: lead, workdir: wd })(
      delegation({ candidates: ["", "   "] }),
      ctx,
    );
    expect(res.outcome).toBe("success");
    expect(candidateLists).toEqual([["claude-x", "gpt-x"]]);
  });

  test("a 422 on the step pool retries ONCE with the parent pool", async () => {
    const { fetchLike, candidateLists } = mockService({
      reject: (candidates) => candidates?.length === 1 && candidates[0] === "gpt-x",
    });
    const lead = leadAgent(fetchLike);
    reg.setResponses([new AssistantMessage({ content: [text("done")] })]);
    const res = await createSpawn({ parent: lead, workdir: wd })(
      delegation({ candidates: ["gpt-x"] }),
      ctx,
    );
    expect(res.outcome).toBe("success");
    expect(candidateLists).toEqual([["gpt-x"], ["claude-x", "gpt-x"]]);
  });

  test("a 422 on the retry too fails the child — exactly two route attempts, no loop", async () => {
    const { fetchLike, candidateLists } = mockService({ reject: () => true });
    const lead = leadAgent(fetchLike);
    const res = await createSpawn({ parent: lead, workdir: wd })(
      delegation({ candidates: ["gpt-x"] }),
      ctx,
    );
    expect(res.outcome).toBe("failure");
    expect(candidateLists).toEqual([["gpt-x"], ["claude-x", "gpt-x"]]);
  });

  test("a 422 with NO step pool applied is a plain failure (no retry)", async () => {
    const { fetchLike, candidateLists } = mockService({ reject: () => true });
    const lead = leadAgent(fetchLike);
    const res = await createSpawn({ parent: lead, workdir: wd })(delegation(), ctx);
    expect(res.outcome).toBe("failure");
    expect(candidateLists).toHaveLength(1);
  });
});

describe("isNoCandidatesRouteError", () => {
  test("classifies 422 and no-candidates messages; rejects others", async () => {
    const { MinimaError } = await import("../src/minima/errors.ts");
    expect(isNoCandidatesRouteError(new MinimaError("bad", 422, {}))).toBe(true);
    expect(isNoCandidatesRouteError(new Error("no candidate models satisfy"))).toBe(true);
    expect(isNoCandidatesRouteError(new MinimaError("unauthorized", 401, {}))).toBe(false);
    expect(isNoCandidatesRouteError(new Error("boom"))).toBe(false);
    expect(isNoCandidatesRouteError("nope")).toBe(false);
  });
});
