/**
 * Long-context price tiers. Gemini 2.5 Pro doubles EVERY rate above a 200k-token prompt;
 * a flat price on a 2M-context model undercharges by half on exactly the calls that cost
 * the most, and that number is the realized actual_cost_usd fed to /v1/feedback.
 */

import { describe, expect, test } from "bun:test";
import { Usage, type Model } from "../src/ai/types.ts";
import { costFor, ratesFor } from "../src/ai/usage.ts";

const PRO: Model = {
  id: "gemini-2.5-pro",
  provider: "google",
  api: "google-generative-ai",
  name: "Gemini 2.5 Pro",
  cost: {
    input: 1.25,
    output: 10.0,
    cache_read: 0.125,
    long_context: { above_prompt_tokens: 200_000, input: 2.5, output: 15.0, cache_read: 0.25 },
  },
  context_window: 2_000_000,
  max_tokens: 8192,
};

/** A model with no tier — must behave exactly as before. */
const FLAT: Model = { ...PRO, id: "flat", cost: { input: 1.25, output: 10.0, cache_read: 0.125 } };

function usage(input: number, output: number, cacheRead = 0): Usage {
  const u = new Usage();
  u.input = input;
  u.output = output;
  u.cache_read = cacheRead;
  return u;
}

describe("ratesFor", () => {
  test("at or below the threshold the base rates apply (Google prices '<= 200k' low)", () => {
    expect(ratesFor(PRO.cost, 0).input).toBe(1.25);
    expect(ratesFor(PRO.cost, 199_999).input).toBe(1.25);
    expect(ratesFor(PRO.cost, 200_000).input).toBe(1.25); // boundary is exclusive
  });

  test("one token past the threshold every rate switches", () => {
    const r = ratesFor(PRO.cost, 200_001);
    expect(r.input).toBe(2.5);
    expect(r.output).toBe(15.0);
    expect(r.cache_read).toBe(0.25);
  });

  test("a model with no tier always bills at its base rates", () => {
    expect(ratesFor(FLAT.cost, 5_000_000).input).toBe(1.25);
  });
});

describe("costFor with a long-context tier", () => {
  test("a short prompt bills at the base rates", () => {
    const c = costFor(PRO, usage(100_000, 1_000));
    expect(c.total).toBeCloseTo((100_000 * 1.25 + 1_000 * 10.0) / 1e6, 10);
  });

  test("a long prompt bills output at the tier rate too, not just input", () => {
    const c = costFor(PRO, usage(300_000, 1_000));
    expect(c.total).toBeCloseTo((300_000 * 2.5 + 1_000 * 15.0) / 1e6, 10);
    // The whole point: the old flat model undercharged this call by ~half.
    expect(c.total).toBeGreaterThan((300_000 * 1.25 + 1_000 * 10.0) / 1e6 * 1.9);
  });

  test("cached tokens count toward the prompt that selects the tier", () => {
    // 50k uncached + 250k cached = a 300k prompt, even though usage.input reads 50k.
    const c = costFor(PRO, usage(50_000, 1_000, 250_000));
    expect(c.total).toBeCloseTo((50_000 * 2.5 + 1_000 * 15.0 + 250_000 * 0.25) / 1e6, 10);
  });

  test("a heavily cached long prompt is NOT mistaken for a short one", () => {
    const heavilyCached = costFor(PRO, usage(1_000, 500, 250_000));
    const rates = ratesFor(PRO.cost, 251_000);
    expect(rates.input).toBe(2.5);
    expect(heavilyCached.cache_read).toBeCloseTo((250_000 * 0.25) / 1e6, 10);
  });

  test("an untiered model is byte-identical to the old flat behavior", () => {
    const c = costFor(FLAT, usage(300_000, 1_000, 10_000));
    expect(c.total).toBeCloseTo(
      (300_000 * 1.25 + 1_000 * 10.0 + 10_000 * 0.125) / 1e6,
      10,
    );
  });
});
