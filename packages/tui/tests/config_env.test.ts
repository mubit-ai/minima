import { describe, expect, test } from "bun:test";

import { configFromEnv, harnessConfig } from "../src/minima/config.ts";

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
  test("ground truth is ON by default; MINIMA_TUI_GROUND_TRUTH=0 opts out", () => {
    withEnv({ MINIMA_TUI_GROUND_TRUTH: undefined, MINIMA_LLM_JUDGE: undefined }, () => {
      expect(configFromEnv().groundTruth).toBe(true);
    });
    withEnv({ MINIMA_TUI_GROUND_TRUTH: "0" }, () => {
      expect(configFromEnv().groundTruth).toBe(false);
    });
    withEnv({ MINIMA_TUI_GROUND_TRUTH: "1" }, () => {
      expect(configFromEnv().groundTruth).toBe(true);
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
