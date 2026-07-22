import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHEAP_FALLBACK_MODELS, resolveRunnableModel } from "../src/ai/model_fallback.ts";
import { registerModel, resetModelRegistry } from "../src/ai/registry.ts";
import type { Model } from "../src/ai/types.ts";
import { buildJudge } from "../src/cli/main.ts";
import { ConstJudge, LLMJudge, harnessConfig } from "../src/minima/index.ts";

const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "MINIMA_LLM_JUDGE",
];

const HAIKU: Model = {
  id: "claude-haiku-4-5",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "Claude Haiku 4.5",
  cost: { input: 1, output: 5 },
  context_window: 200_000,
  max_tokens: 8192,
};
const FLASH: Model = {
  id: "gemini-2.5-flash",
  provider: "google",
  api: "google-generative-ai",
  name: "Gemini 2.5 Flash",
  cost: { input: 0.3, output: 2.5 },
  context_window: 1_000_000,
  max_tokens: 8192,
};
const MINI: Model = {
  id: "gpt-4o-mini",
  provider: "openai",
  api: "openai-completions",
  name: "GPT-4o mini",
  cost: { input: 0.15, output: 0.6 },
  context_window: 128_000,
  max_tokens: 16_384,
};

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const v of KEY_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  resetModelRegistry();
  registerModel(HAIKU);
  registerModel(FLASH);
  registerModel(MINI);
});

afterEach(() => {
  for (const v of KEY_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  resetModelRegistry();
});

describe("resolveRunnableModel", () => {
  test("the preferred model wins when its provider key is present", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const r = resolveRunnableModel("claude-haiku-4-5");
    expect(r).not.toBeNull();
    expect(r!.model.id).toBe("claude-haiku-4-5");
    expect(r!.substituted).toBe(false);
  });

  test("only a Gemini key → falls through the ladder to gemini-2.5-flash", () => {
    process.env.GEMINI_API_KEY = "k";
    const r = resolveRunnableModel("claude-haiku-4-5");
    expect(r).not.toBeNull();
    expect(r!.model.id).toBe("gemini-2.5-flash");
    expect(r!.substituted).toBe(true);
  });

  test("only an OpenAI key → falls through to gpt-4o-mini", () => {
    process.env.OPENAI_API_KEY = "k";
    const r = resolveRunnableModel("claude-haiku-4-5");
    expect(r!.model.id).toBe("gpt-4o-mini");
    expect(r!.substituted).toBe(true);
  });

  test("no keys at all → null", () => {
    expect(resolveRunnableModel("claude-haiku-4-5")).toBeNull();
  });

  test("a preferred model missing from the registry still falls back", () => {
    process.env.GEMINI_API_KEY = "k";
    const r = resolveRunnableModel("no-such-model");
    expect(r!.model.id).toBe("gemini-2.5-flash");
    expect(r!.substituted).toBe(true);
  });

  test("the ladder ids all resolve in the seed registry shape", () => {
    for (const id of CHEAP_FALLBACK_MODELS) {
      expect(["claude-haiku-4-5", "gemini-2.5-flash", "gpt-4o-mini"]).toContain(id);
    }
  });
});

describe("buildJudge (cli wiring)", () => {
  test("only a Gemini key → LLM judge on the flash model with a substitution notice", () => {
    process.env.GEMINI_API_KEY = "k";
    const { judge, notices } = buildJudge(harnessConfig({ judgeSampleRate: 0.15 }), () => {});
    expect(judge).toBeInstanceOf(LLMJudge);
    expect(notices.some((n) => n.includes("gemini-2.5-flash") && n.includes("instead"))).toBe(
      true,
    );
  });

  test("explicit judge model with its key present → used unchanged, no substitution notice", () => {
    process.env.GEMINI_API_KEY = "k";
    const { judge, notices } = buildJudge(
      harnessConfig({ judgeModel: "gemini-2.5-flash", judgeSampleRate: 0.15 }),
      () => {},
    );
    expect(judge).toBeInstanceOf(LLMJudge);
    expect(notices.some((n) => n.includes("instead"))).toBe(false);
    expect(notices.some((n) => n.includes("(gemini-2.5-flash"))).toBe(true);
  });

  test("no keys → ConstJudge (abstain), no notices unless forced", () => {
    const off = buildJudge(harnessConfig({ judgeSampleRate: 0.15 }), () => {});
    expect(off.judge).toBeInstanceOf(ConstJudge);
    expect(off.notices).toHaveLength(0);
    process.env.MINIMA_LLM_JUDGE = "1";
    const forced = buildJudge(harnessConfig({ judgeSampleRate: 1 }), () => {});
    expect(forced.judge).toBeInstanceOf(ConstJudge);
    expect(forced.notices.some((n) => n.includes("MINIMA_LLM_JUDGE=1 ignored"))).toBe(true);
  });

  test("MINIMA_LLM_JUDGE=0 disables even with keys present", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.MINIMA_LLM_JUDGE = "0";
    const { judge, notices } = buildJudge(harnessConfig({ judgeSampleRate: 1 }), () => {});
    expect(judge).toBeInstanceOf(ConstJudge);
    expect(notices).toHaveLength(0);
  });
});
