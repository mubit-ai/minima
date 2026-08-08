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
import { PROVIDERS } from "../src/ai/provider_catalog.ts";
import { SEED_MODELS } from "../src/cli/main.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { DEFAULT_CANDIDATES, PREMIUM_CANDIDATES } from "../src/minima/config.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { COLD_START_OUTPUT_TOKENS, estimateOutputTokens } from "../src/minima/output_estimate.ts";

describe("default candidate pool", () => {
  const seeded = new Set(SEED_MODELS.map((m) => m.id));

  // The trap this pins: an id absent from the seed registry does not error — ModelMapping
  // resolves it to undefined and runtime.ts's provider-key filter drops it. The pool silently
  // shrinks, and the ladder loses a rung with nothing in the logs to say so.
  test("every candidate resolves in the seed registry", () => {
    const missing = DEFAULT_CANDIDATES.filter((id) => !seeded.has(id));
    expect(missing).toEqual([]);
  });

  test("every premium candidate resolves in the seed registry", () => {
    const missing = PREMIUM_CANDIDATES.filter((id) => !seeded.has(id));
    expect(missing).toEqual([]);
  });

  test("no duplicate ids", () => {
    expect([...new Set(DEFAULT_CANDIDATES)]).toEqual(DEFAULT_CANDIDATES);
  });

  // The server caps candidate selection at 8 unless widened, and runtime.ts widens to at most
  // 16 — a longer pool would be truncated server-side by capability prior, silently discarding
  // the cheap rungs this pool exists to provide.
  test("pool fits the request cap the harness can widen to", () => {
    expect(DEFAULT_CANDIDATES.length).toBeLessThanOrEqual(16);
  });

  // Per-provider frontier rule: the runnable pool is DEFAULT_CANDIDATES intersected with the
  // user's provider keys, so every provider represented must be able to stand alone. A pool
  // that leaned on one provider for its cheap end would collapse for anyone lacking that key.
  test("each represented provider contributes a runnable ladder, not a single price point", () => {
    const known = new Set(PROVIDERS.map((p) => p.name));
    const byProvider = new Map<string, string[]>();
    for (const id of DEFAULT_CANDIDATES) {
      const model = SEED_MODELS.find((m) => m.id === id)!;
      expect(known).toContain(model.provider);
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), id]);
    }
    // Three keyless-by-default providers (anthropic/google/openai) must each carry >1 rung so
    // a single-key user still has somewhere to move as the slider rises.
    for (const provider of ["anthropic", "google", "openai"]) {
      expect(byProvider.get(provider)?.length ?? 0).toBeGreaterThan(1);
    }
    // Within a provider, two models at the same price are redundant: the dearer prior wins
    // every time and the other can never be selected.
    for (const [, ids] of byProvider) {
      const costs = ids.map((id) => {
        const c = SEED_MODELS.find((m) => m.id === id)!.cost;
        return c.input * 4_000 + c.output * 800;
      });
      expect([...new Set(costs)].length).toBe(costs.length);
    }
  });
});

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

/** Mock service capturing each recommend request's TaskInput. */
function service() {
  const tasks: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      const body = init?.body ? JSON.parse(init.body) : {};
      tasks.push(body.task);
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${tasks.length}`,
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            est_cost_usd: 0.001,
            predicted_success: 0.9,
          },
          ranked: [],
          decision_basis: "prior",
          confidence: 0,
          threshold_used: 0.735,
          warnings: [],
        }),
      };
    }
    return { status: 200, json: async () => ({ accepted: true }) };
  };
  return { tasks, fetchLike };
}

describe("expected_output_tokens on the wire", () => {
  test("cold start, then the estimate follows realized usage", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX);
    const reg = registerFauxProvider([FAUX]);
    // ~4000 chars -> ~1000 synthesized output tokens per run, well clear of the 700 cold start.
    reg.setResponses(
      Array.from({ length: 4 }, () => new AssistantMessage({ content: [text("x".repeat(4_000))] })),
    );

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { tasks, fetchLike } = service();
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
      judgeSampleRate: 0,
    });
    const agent = new MinimaAgent({
      config,
      router: new MinimaRouter({
        client: new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike }),
        config,
        mapping: new ModelMapping(),
      }),
      judge: new ConstJudge(0.9),
      meter: new CostMeter(),
    });
    agent.db = db;
    agent.runId = runId;

    for (let i = 0; i < 4; i++) await agent.promptRouted(`task ${i}`);

    // Every request carries the field — the server's difficulty-scaled constant is never
    // what prices the candidates any more.
    for (const t of tasks) expect(t.expected_output_tokens).toBeGreaterThan(0);
    // The first MIN_SAMPLES(3) requests have too little history to beat the cold start.
    expect(tasks[0]!.expected_output_tokens).toBe(COLD_START_OUTPUT_TOKENS);
    expect(tasks[1]!.expected_output_tokens).toBe(COLD_START_OUTPUT_TOKENS);
    expect(tasks[2]!.expected_output_tokens).toBe(COLD_START_OUTPUT_TOKENS);

    // The 4th is priced off what the first three actually spent. The ledger is read after
    // all four ran, so drop the newest row — it did not exist when request 4 was priced.
    const realized = db.recentOutputTokens("p", 20);
    expect(realized.length).toBe(4);
    expect(tasks[3]!.expected_output_tokens).toBe(estimateOutputTokens(realized.slice(1)));
    expect(tasks[3]!.expected_output_tokens).not.toBe(COLD_START_OUTPUT_TOKENS);

    // Realized usage is retained, which is what makes the estimate self-correcting.
    // (input stays 0 here: the faux provider synthesizes only output tokens.)
    for (const row of db.getRunDecisions(runId)) {
      expect(Number(row.output_tokens)).toBeGreaterThan(0);
      expect(row.input_tokens).not.toBeNull();
    }
    reg.unregister();
    db.close();
  });

  test("no persistence spine -> field omitted, server fallback applies unchanged", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX);
    const reg = registerFauxProvider([FAUX]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const { tasks, fetchLike } = service();
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
      judgeSampleRate: 0,
    });
    const agent = new MinimaAgent({
      config,
      router: new MinimaRouter({
        client: new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike }),
        config,
        mapping: new ModelMapping(),
      }),
      judge: new ConstJudge(0.9),
    });

    await agent.promptRouted("no db here");
    expect(tasks[0]!.expected_output_tokens).toBeUndefined();
    reg.unregister();
  });
});
