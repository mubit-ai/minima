import { describe, expect, test } from "bun:test";

import { headlessVerifyConsent } from "../src/minima/big_plan.ts";
import { configFromEnv, harnessConfig, optInFlag } from "../src/minima/config.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("label-source configuration (Phase 0b)", () => {
  test("Big Plan is ON by default; MINIMA_TUI_BIG_PLAN=0 opts out", () => {
    withEnv({ MINIMA_TUI_BIG_PLAN: undefined, MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().bigPlan).toBe(true);
    });
    withEnv({ MINIMA_TUI_BIG_PLAN: "0" }, () => {
      expect(configFromEnv().bigPlan).toBe(false);
    });
    withEnv({ MINIMA_TUI_BIG_PLAN: "1" }, () => {
      expect(configFromEnv().bigPlan).toBe(true);
    });
  });

  test("judge sampling defaults to 15% of eligible turns", () => {
    expect(harnessConfig().judgeSampleRate).toBeCloseTo(0.15);
    withEnv({ MINIMA_JUDGE_SAMPLE: undefined, MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().judgeSampleRate).toBeCloseTo(0.15);
    });
  });

  test("MINIMA_JUDGE_SAMPLE overrides the rate; out-of-range values are ignored", () => {
    withEnv({ MINIMA_JUDGE_SAMPLE: "0.5", MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().judgeSampleRate).toBeCloseTo(0.5);
    });
    withEnv({ MINIMA_JUDGE_SAMPLE: "0", MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().judgeSampleRate).toBe(0);
    });
    withEnv({ MINIMA_JUDGE_SAMPLE: "7", MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().judgeSampleRate).toBeCloseTo(0.15);
    });
  });

  test("MINIMA_LLM_JUDGE=1 keeps legacy full grading (rate 1) unless a sample is set", () => {
    withEnv({ MINIMA_LLM_JUDGE: "1", MINIMA_JUDGE_SAMPLE: undefined }, () => {
      expect(configFromEnv().judgeSampleRate).toBe(1);
    });
    withEnv({ MINIMA_LLM_JUDGE: "1", MINIMA_JUDGE_SAMPLE: "0.3" }, () => {
      expect(configFromEnv().judgeSampleRate).toBeCloseTo(0.3);
    });
  });
});

describe("plan-premium configuration", () => {
  const CLEAR = {
    MINIMA_TUI_PLAN_PREMIUM: undefined,
    MINIMA_PLAN_PREMIUM_MODELS: undefined,
    MINIMA_PLAN_MODEL: undefined,
    MINIMA_PLAN_ROUND_BUDGET_USD: undefined,
  };

  test("plan-premium is ON by default; MINIMA_TUI_PLAN_PREMIUM=0 opts out", () => {
    withEnv(CLEAR, () => {
      expect(configFromEnv().planPremium).toBe(true);
    });
    withEnv({ ...CLEAR, MINIMA_TUI_PLAN_PREMIUM: "0" }, () => {
      expect(configFromEnv().planPremium).toBe(false);
    });
  });

  test("MINIMA_PLAN_PREMIUM_MODELS parses, trims, and dedupes; empty keeps the default", () => {
    withEnv({ ...CLEAR, MINIMA_PLAN_PREMIUM_MODELS: "a, b,,a" }, () => {
      expect(configFromEnv().planPremiumModels).toEqual(["a", "b"]);
    });
    withEnv({ ...CLEAR, MINIMA_PLAN_PREMIUM_MODELS: "" }, () => {
      expect(configFromEnv().planPremiumModels).toEqual(harnessConfig().planPremiumModels);
    });
  });

  test("MINIMA_PLAN_MODEL sets the plan-shaping override; unset stays null", () => {
    withEnv({ ...CLEAR, MINIMA_PLAN_MODEL: "claude-opus-4-8" }, () => {
      expect(configFromEnv().planModel).toBe("claude-opus-4-8");
    });
    withEnv(CLEAR, () => {
      expect(configFromEnv().planModel).toBeNull();
    });
  });

  test("round budget: premium bumps the default to 1.00; an explicit env always wins", () => {
    withEnv(CLEAR, () => {
      expect(configFromEnv().planRoundBudgetUsd).toBeCloseTo(1.0);
    });
    withEnv({ ...CLEAR, MINIMA_PLAN_ROUND_BUDGET_USD: "0.5" }, () => {
      expect(configFromEnv().planRoundBudgetUsd).toBeCloseTo(0.5);
    });
    withEnv({ ...CLEAR, MINIMA_TUI_PLAN_PREMIUM: "0" }, () => {
      expect(configFromEnv().planRoundBudgetUsd).toBeCloseTo(0.25);
    });
    // Invalid budget env → treated as unset, so the premium bump still applies.
    withEnv({ ...CLEAR, MINIMA_PLAN_ROUND_BUDGET_USD: "nope" }, () => {
      expect(configFromEnv().planRoundBudgetUsd).toBeCloseTo(1.0);
    });
  });
});

describe("experimental umbrella (MINIMA_TUI_EXPERIMENTAL)", () => {
  const CLEAR = {
    MINIMA_TUI_EXPERIMENTAL: undefined,
    MINIMA_AUTO_EFFORT: undefined,
  };

  test("off by default; opt-in features stay off", () => {
    withEnv(CLEAR, () => {
      const config = configFromEnv();
      expect(config.experimental).toBe(false);
      expect(config.autoEffort).toBe(false);
    });
  });

  test("MINIMA_TUI_EXPERIMENTAL=1 turns unset opt-in features on", () => {
    withEnv({ ...CLEAR, MINIMA_TUI_EXPERIMENTAL: "1" }, () => {
      const config = configFromEnv();
      expect(config.experimental).toBe(true);
      expect(config.autoEffort).toBe(true);
    });
  });

  test("an explicit per-flag =0 wins over the umbrella", () => {
    withEnv({ MINIMA_TUI_EXPERIMENTAL: "1", MINIMA_AUTO_EFFORT: "0" }, () => {
      expect(configFromEnv().autoEffort).toBe(false);
    });
  });

  test("an explicit per-flag =1 works without the umbrella", () => {
    withEnv({ ...CLEAR, MINIMA_AUTO_EFFORT: "1" }, () => {
      expect(configFromEnv().autoEffort).toBe(true);
    });
  });

  test("the umbrella never grants headless verify consent", () => {
    expect(
      headlessVerifyConsent({ MINIMA_TUI_EXPERIMENTAL: "1" } as unknown as NodeJS.ProcessEnv)(
        "true",
      ),
    ).toBe(false);
    withEnv({ MINIMA_TUI_EXPERIMENTAL: "1", MINIMA_TUI_ALLOW_VERIFY: undefined }, () => {
      expect(headlessVerifyConsent()("true")).toBe(false);
    });
  });

  test("optInFlag semantics", () => {
    expect(optInFlag("1", false)).toBe(true);
    expect(optInFlag("1", true)).toBe(true);
    expect(optInFlag("0", false)).toBe(false);
    expect(optInFlag("0", true)).toBe(false);
    expect(optInFlag(undefined, false)).toBe(false);
    expect(optInFlag(undefined, true)).toBe(true);
  });
});
