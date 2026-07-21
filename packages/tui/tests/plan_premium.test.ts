import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Model, registerModel, resetModelRegistry } from "../src/ai/index.ts";
import { harnessConfig } from "../src/minima/config.ts";
import { planModeRoutingOpts, resolvePlanModels } from "../src/minima/premium.ts";

const base: Model = {
  id: "opus-x",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "Opus X",
  cost: { input: 5, output: 25 },
  context_window: 8192,
  max_tokens: 4096,
};
const OPUS = base;
const GEMINI: Model = { ...base, id: "gemini-x", provider: "google", api: "google-generative-ai" };
const SONNET: Model = { ...base, id: "sonnet-x" };

const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  resetModelRegistry();
  registerModel(OPUS);
  registerModel(GEMINI);
  registerModel(SONNET);
  saved = {};
  for (const k of KEY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const cfg = (over: Parameters<typeof harnessConfig>[0] = {}) =>
  harnessConfig({ planPremiumModels: ["opus-x", "gemini-x"], ...over });

describe("resolvePlanModels — policy gates", () => {
  test("flag off → null (premium policy inactive)", () => {
    expect(resolvePlanModels(cfg({ planPremium: false }))).toBeNull();
  });

  test("an explicit /model pin beats the policy: null, no throw even with zero keys", () => {
    expect(resolvePlanModels(cfg({ pinned: true }))).toBeNull();
  });
});

describe("resolvePlanModels — runnable filtering", () => {
  test("both keys present → candidates in allowlist order, planModel = first runnable", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    const r = resolvePlanModels(cfg());
    expect(r?.candidates).toEqual(["opus-x", "gemini-x"]);
    expect(r?.planModel.id).toBe("opus-x");
  });

  test("only the google key → pool filtered, planModel follows", () => {
    process.env.GEMINI_API_KEY = "k";
    const r = resolvePlanModels(cfg());
    expect(r?.candidates).toEqual(["gemini-x"]);
    expect(r?.planModel.id).toBe("gemini-x");
  });

  test("an unregistered allowlist id is excluded without a throw while another is runnable", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const r = resolvePlanModels(cfg({ planPremiumModels: ["ghost-model", "opus-x"] }));
    expect(r?.candidates).toEqual(["opus-x"]);
    expect(r?.planModel.id).toBe("opus-x");
  });

  test("no runnable model → loud actionable error naming the env var and both remedies", () => {
    expect(() => resolvePlanModels(cfg())).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolvePlanModels(cfg())).toThrow(/MINIMA_PLAN_PREMIUM_MODELS/);
    expect(() => resolvePlanModels(cfg())).toThrow(/MINIMA_TUI_PLAN_PREMIUM=0/);
  });

  test("an unregistered-only allowlist reports the registry gap, not a key hint", () => {
    expect(() => resolvePlanModels(cfg({ planPremiumModels: ["ghost-model"] }))).toThrow(
      /not in the model registry/,
    );
  });
});

describe("planModeRoutingOpts — the sessionless plan-mode fallback pool", () => {
  test("premium active → the runnable hard pool plus the plan phase tag", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const opts = planModeRoutingOpts(cfg());
    expect(opts.candidates).toEqual(["opus-x"]);
    expect(opts.tags).toEqual(["phase:plan"]);
  });

  test("flag off → no pool restriction, but the phase tag still rides", () => {
    const opts = planModeRoutingOpts(cfg({ planPremium: false }));
    expect(opts.candidates).toBeUndefined();
    expect(opts.tags).toEqual(["phase:plan"]);
  });

  test("an explicit /model pin beats the policy: no pool, no throw", () => {
    const opts = planModeRoutingOpts(cfg({ pinned: true }));
    expect(opts.candidates).toBeUndefined();
  });

  test("premium active but nothing runnable → the loud actionable throw propagates", () => {
    expect(() => planModeRoutingOpts(cfg())).toThrow(/MINIMA_TUI_PLAN_PREMIUM=0/);
  });
});

describe("resolvePlanModels — MINIMA_PLAN_MODEL override", () => {
  test("runnable override is chosen as planModel and appended to the candidate pool", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const r = resolvePlanModels(cfg({ planModel: "sonnet-x" }));
    expect(r?.planModel.id).toBe("sonnet-x");
    expect(r?.candidates).toEqual(["opus-x", "sonnet-x"]);
  });

  test("an unrunnable override throws naming MINIMA_PLAN_MODEL", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    expect(() => resolvePlanModels(cfg({ planModel: "gemini-x" }))).toThrow(/MINIMA_PLAN_MODEL/);
  });
});
