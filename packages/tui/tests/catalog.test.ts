import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Model,
  findModelById,
  registerModel,
  resetModelRegistry,
  tryGetModel,
} from "../src/ai/index.ts";
import { SEED_MODELS } from "../src/cli/main.ts";
import { populateFromMinima, populateFromOpenRouter } from "../src/minima/catalog.ts";
import { DEFAULT_CANDIDATES, PREMIUM_CANDIDATES } from "../src/minima/config.ts";
import { ModelMapping } from "../src/minima/mapping.ts";
import type { ModelCard } from "../src/minima/schemas.ts";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetModelRegistry();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function card(model_id: string, provider: string, extra: Partial<ModelCard> = {}): ModelCard {
  return {
    model_id,
    provider,
    input_cost_per_mtok: 1,
    output_cost_per_mtok: 2,
    ...extra,
  };
}

describe("seed registry (July 2026 lineup)", () => {
  test("new lineup resolves and deprecated deepseek-chat is gone", () => {
    for (const m of SEED_MODELS) registerModel(m);
    expect(tryGetModel("deepseek", "deepseek-v4-flash")).toBeDefined();
    expect(tryGetModel("anthropic", "claude-fable-5")).toBeDefined();
    expect(tryGetModel("openrouter", "z-ai/glm-5.2")).toBeDefined();
    // deepseek-chat is deprecated by DeepSeek effective 2026-07-24 — keeping it would break calls.
    expect(findModelById("deepseek-chat")).toBeUndefined();
  });

  test("every default + premium candidate id is runnable from the seeds", () => {
    for (const m of SEED_MODELS) registerModel(m);
    const mapping = new ModelMapping();
    for (const id of [...DEFAULT_CANDIDATES, ...PREMIUM_CANDIDATES]) {
      expect(mapping.resolve("", id)?.id).toBe(id);
    }
  });

  test("claude-fable-5 seed declares always-on adaptive thinking", () => {
    const fable = SEED_MODELS.find((m) => m.id === "claude-fable-5")!;
    expect(fable.reasoning).toBe(true);
    expect(fable.adaptive_thinking).toBe(true);
  });
});

describe("populateFromMinima", () => {
  test("registers only models whose provider key is present (runnable-only)", async () => {
    process.env.ANTHROPIC_API_KEY = "k"; // openai key intentionally absent
    const client = {
      models: async () => ({
        models: [card("claude-x", "anthropic"), card("gpt-x", "openai")],
      }),
    };
    const added = await populateFromMinima(client);
    expect(added).toBe(1);
    expect(tryGetModel("anthropic", "claude-x")).toBeDefined();
    expect(tryGetModel("openai", "gpt-x")).toBeUndefined();
  });

  test("maps provider → api + synthesizes cost/context", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const client = {
      models: async () => ({
        models: [
          card("claude-x", "anthropic", { context_window: 200_000, max_output_tokens: 16384 }),
        ],
      }),
    };
    await populateFromMinima(client);
    const m = tryGetModel("anthropic", "claude-x")!;
    expect(m.api).toBe("anthropic-messages");
    expect(m.cost.input).toBe(1);
    expect(m.cost.output).toBe(2);
    expect(m.context_window).toBe(200_000);
    expect(m.max_tokens).toBe(16384);
  });

  test("does not clobber an already-registered (seed) model", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const seed: Model = {
      id: "claude-x",
      provider: "anthropic",
      api: "anthropic-messages",
      name: "Seed",
      cost: { input: 99, output: 99 },
      context_window: 1,
      max_tokens: 1,
    };
    registerModel(seed);
    const added = await populateFromMinima({
      models: async () => ({ models: [card("claude-x", "anthropic")] }),
    });
    expect(added).toBe(0);
    expect(tryGetModel("anthropic", "claude-x")!.cost.input).toBe(99); // untouched
  });
});

describe("populateFromOpenRouter", () => {
  test("no-op without OPENROUTER_API_KEY", async () => {
    const added = await populateFromOpenRouter(async () => {
      throw new Error("should not fetch");
    });
    expect(added).toBe(0);
  });

  test("registers models with $/Mtok pricing and openrouter base_url", async () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "anthropic/claude-3.5-sonnet",
            name: "Claude 3.5 Sonnet",
            context_length: 200_000,
            pricing: { prompt: "0.000003", completion: "0.000015" },
            top_provider: { max_completion_tokens: 8192 },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const added = await populateFromOpenRouter(fakeFetch);
    expect(added).toBe(1);
    const m = findModelById("anthropic/claude-3.5-sonnet")!;
    expect(m.provider).toBe("openrouter");
    expect(m.api).toBe("openai-completions");
    expect(m.base_url).toContain("openrouter.ai");
    // 0.000003 $/token * 1e6 = 3 $/Mtok
    expect(m.cost.input).toBeCloseTo(3, 5);
    expect(m.cost.output).toBeCloseTo(15, 5);
  });

  test("HTTP failure is a no-op", async () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    const added = await populateFromOpenRouter((async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch);
    expect(added).toBe(0);
  });
});
