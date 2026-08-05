import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Model,
  findModelById,
  registerModel,
  resetModelRegistry,
  tryGetModel,
} from "../src/ai/index.ts";
import { SEED_MODELS } from "../src/cli/main.ts";
import { supportsImageInput } from "../src/ai/provider_quirks.ts";
import { populateFromMinima, populateFromOpenRouter } from "../src/minima/catalog.ts";
import { DEFAULT_CANDIDATES, PREMIUM_CANDIDATES } from "../src/minima/config.ts";
import { ModelMapping, syncCatalog } from "../src/minima/mapping.ts";
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

  test("adaptive-shape Claude seeds declare adaptive_thinking (MUB-182)", () => {
    for (const id of ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8"]) {
      const m = SEED_MODELS.find((s) => s.id === id)!;
      expect(m.reasoning).toBe(true);
      expect(m.adaptive_thinking).toBe(true);
    }
    const sonnet46 = SEED_MODELS.find((s) => s.id === "claude-sonnet-4-6")!;
    expect(sonnet46.adaptive_thinking).toBeUndefined();
  });
});

describe("populateFromMinima — vision modality", () => {
  // Derived from capability_priors, exactly as `reasoning` is. The server emits no vision
  // prior today, so this is inert-but-forward-compatible and needs no wire-schema change.
  test("a vision prior >= 0.5 becomes image input; anything else stays text-only", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const client = {
      models: async () => ({
        models: [
          card("sees", "anthropic", { capability_priors: { vision: 0.9 } }),
          card("blind", "anthropic", { capability_priors: { vision: 0.1 } }),
          card("silent", "anthropic"),
        ],
      }),
    };
    await populateFromMinima(client);
    expect(supportsImageInput(tryGetModel("anthropic", "sees")!)).toBe(true);
    expect(supportsImageInput(tryGetModel("anthropic", "blind")!)).toBe(false);
    expect(supportsImageInput(tryGetModel("anthropic", "silent")!)).toBe(false);
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

// MUB-229. Entries below are copied from the live https://openrouter.ai/api/v1/models
// response (public, no key needed — fetched 2026-08-05), so the parse is pinned against the
// real document rather than an invented one. Until now every OpenRouter-synthesized model
// carried ZERO capability flags, which left the harness fail-open on tools and the
// openrouter off-shape entry inert.
describe("populateFromOpenRouter — capabilities derived from supported_parameters", () => {
  const REASONER = {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    context_length: 1_050_000,
    pricing: { prompt: "0.000001", completion: "0.000006" },
    top_provider: { max_completion_tokens: 128_000 },
    architecture: { input_modalities: ["file", "image", "text"] },
    supported_parameters: [
      "include_reasoning",
      "max_completion_tokens",
      "max_tokens",
      "reasoning",
      "reasoning_effort",
      "tools",
    ],
    reasoning: {
      mandatory: false,
      default_enabled: true,
      supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"],
      default_effort: "medium",
    },
  };

  const TEXT_ONLY = {
    id: "some-vendor/plain-chat",
    name: "Plain Chat",
    pricing: { prompt: "0.0000005", completion: "0.0000015" },
    architecture: { input_modalities: ["text"] },
    supported_parameters: ["max_tokens", "temperature", "tools"],
  };

  async function populate(...models: unknown[]): Promise<number> {
    process.env.OPENROUTER_API_KEY = "or-key";
    return populateFromOpenRouter((async () => ({
      ok: true,
      json: async () => ({ data: models }),
    })) as unknown as typeof fetch);
  }

  test("a model advertising `reasoning` is registered as reasoning-capable", async () => {
    await populate(REASONER);
    expect(findModelById("openai/gpt-5.6-luna")!.reasoning).toBe(true);
  });

  test("supported_efforts becomes the model's effort vocabulary", async () => {
    await populate(REASONER);
    // "none" is the off-payload, not a level; "max" is outside the harness vocabulary.
    expect(findModelById("openai/gpt-5.6-luna")!.effort_levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("input modalities become Model.input, so vision survives the trip", async () => {
    await populate(REASONER, TEXT_ONLY);
    expect(findModelById("openai/gpt-5.6-luna")!.input).toEqual(["text", "image"]);
    expect(findModelById("some-vendor/plain-chat")!.input).toEqual(["text"]);
  });

  test("a model that advertises no reasoning stays unflagged", async () => {
    await populate(TEXT_ONLY);
    const m = findModelById("some-vendor/plain-chat")!;
    expect(m.reasoning).toBeUndefined();
    expect(m.effort_levels).toBeUndefined();
    expect(m.tools_require_effort_none).toBeUndefined();
  });

  // The fail-open gap this closes: the same underlying model reached through OpenRouter used
  // to arrive with no flags at all, so the tools quirk verified on the openai host silently
  // stopped applying. Inheritance is by exact model identity out of the registry — never an
  // id pattern, never a per-provider rule.
  test("tools_require_effort_none is inherited from the same model on its own host", async () => {
    registerModel({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-completions",
      name: "GPT-5.6 Luna",
      cost: { input: 1, output: 6 },
      context_window: 1_050_000,
      max_tokens: 128_000,
      reasoning: true,
      tools_require_effort_none: true,
    });
    await populate(REASONER);
    expect(findModelById("openai/gpt-5.6-luna")!.tools_require_effort_none).toBe(true);
  });

  test("a sibling the registry has never verified inherits nothing", async () => {
    registerModel({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-completions",
      name: "GPT-5.6 Luna",
      cost: { input: 1, output: 6 },
      context_window: 1_050_000,
      max_tokens: 128_000,
      reasoning: true,
      tools_require_effort_none: true,
    });
    await populate({ ...REASONER, id: "openai/gpt-5.6-luna-pro" });
    expect(findModelById("openai/gpt-5.6-luna-pro")!.tools_require_effort_none).toBeUndefined();
  });

  // reasoning.default_enabled is true on 69 of the 338 models in the live catalog, spanning
  // anthropic, google, x-ai, qwen, moonshot and openai — it says "this model reasons unless
  // told otherwise", NOT "this host refuses tools alongside an effort". Deriving the quirk
  // from it would pin effort off on every reasoning model reached through OpenRouter.
  test("default_enabled alone never pins effort off", async () => {
    await populate({ ...REASONER, id: "anthropic/claude-sonnet-5" });
    expect(findModelById("anthropic/claude-sonnet-5")!.tools_require_effort_none).toBeUndefined();
  });
});

describe("syncCatalog preserves long-context price tiers", () => {
  test("a server price refresh does not silently drop the tier", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const seed: Model = {
      id: "tiered-x",
      provider: "anthropic",
      api: "anthropic-messages",
      name: "Tiered",
      cost: {
        input: 1.25,
        output: 10,
        cache_read: 0.125,
        long_context: { above_prompt_tokens: 200_000, input: 2.5, output: 15, cache_read: 0.25 },
      },
      context_window: 2_000_000,
      max_tokens: 8192,
    };
    registerModel(seed);

    const updated = await syncCatalog(
      { models: async () => ({ models: [card("tiered-x", "anthropic")] }) },
      new ModelMapping(),
    );
    expect(updated).toBe(1);

    const m = tryGetModel("anthropic", "tiered-x")!;
    expect(m.cost.input).toBe(1); // base rates DID refresh from the card
    // ...and the tier the wire format cannot express survived.
    expect(m.cost.long_context).toBeDefined();
    expect(m.cost.long_context!.above_prompt_tokens).toBe(200_000);
    expect(m.cost.long_context!.input).toBe(2.5);
  });

  test("a model with no tier stays untiered after a refresh", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    registerModel({
      id: "flat-x",
      provider: "anthropic",
      api: "anthropic-messages",
      name: "Flat",
      cost: { input: 1, output: 2 },
      context_window: 1000,
      max_tokens: 100,
    });
    await syncCatalog(
      { models: async () => ({ models: [card("flat-x", "anthropic")] }) },
      new ModelMapping(),
    );
    expect(tryGetModel("anthropic", "flat-x")!.cost.long_context).toBeUndefined();
  });
});
