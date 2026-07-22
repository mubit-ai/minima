import { describe, expect, test } from "bun:test";
import type { Model } from "../src/ai/types.ts";
import { errText } from "../src/errtext.ts";
import { matches } from "../src/tui/model-picker.tsx";
import { compactRoutingNote, routingInfoWarnings } from "../src/tui/routing-warnings.ts";

describe("errText", () => {
  test("returns an Error's message without the class-name prefix (no 'Error: Error:')", () => {
    expect(errText(new Error("boom"))).toBe("boom");
    class MinimaError extends Error {}
    expect(errText(new MinimaError("no Mubit API key configured"))).toBe(
      "no Mubit API key configured",
    );
  });
  test("falls back to String() for non-Error throws", () => {
    expect(errText("plain string")).toBe("plain string");
    expect(errText({ code: 1 })).toBe("[object Object]");
  });
  test("prepending 'Error: ' no longer doubles", () => {
    expect(`Error: ${errText(new Error("x"))}`).toBe("Error: x");
  });
});

describe("routingInfoWarnings", () => {
  test("hides purely-internal diagnostics", () => {
    for (const w of [
      "reasoner_disabled",
      "reasoner_consulted",
      "thompson_pick",
      "exploration_pick",
      "prices_stale",
      "collapse_guard_applied",
    ]) {
      expect(routingInfoWarnings([w])).toEqual([]);
    }
  });
  test("surfaces informational (non-hidden) warnings", () => {
    expect(routingInfoWarnings(["no_model_meets_threshold"])).toEqual(["no_model_meets_threshold"]);
    expect(routingInfoWarnings(["no_model_within_cost_budget"])).toEqual([
      "no_model_within_cost_budget",
    ]);
  });
  test("empty in → empty out", () => {
    expect(routingInfoWarnings([])).toEqual([]);
  });
  test("cold_start collapses to ONE compact line, however many variants arrive", () => {
    expect(routingInfoWarnings(["cold_start", "cold_start_no_memory"])).toEqual([
      "cold start — no prior outcomes for this task yet",
    ]);
  });
  test("escalation_suggested:* collapses to ONE compact thin-evidence line", () => {
    expect(
      routingInfoWarnings(["escalation_suggested:thin_evidence", "escalation_suggested:tied"]),
    ).toEqual(["thin evidence for this pick — worth verifying"]);
  });
  test("cold start + escalation together are still a single compact line", () => {
    expect(
      routingInfoWarnings(["cold_start", "escalation_suggested:wide_interval", "cold_start"]),
    ).toEqual(["cold start · thin evidence — pick based on priors"]);
  });
  test("the compact note rides alongside pass-through warnings, deduplicated", () => {
    expect(
      routingInfoWarnings([
        "cold_start",
        "no_model_meets_threshold",
        "no_model_meets_threshold",
      ]),
    ).toEqual(["cold start — no prior outcomes for this task yet", "no_model_meets_threshold"]);
  });
  test("compactRoutingNote returns null when neither family is present", () => {
    expect(compactRoutingNote(["no_model_meets_threshold"])).toBeNull();
    expect(compactRoutingNote([])).toBeNull();
  });
});

describe("model picker filter", () => {
  const m = (id: string, provider: string, name: string): Model => ({
    id,
    provider,
    api: "openai-completions",
    name,
    cost: { input: 0, output: 0 },
    context_window: 1000,
    max_tokens: 100,
  });
  test("empty filter matches everything", () => {
    expect(matches(m("gpt-4o", "openai", "GPT-4o"), "")).toBe(true);
  });
  test("matches on name, provider, or id (case-insensitive)", () => {
    const claude = m("claude-opus-4-8", "anthropic", "Claude Opus 4.8");
    expect(matches(claude, "opus")).toBe(true);
    expect(matches(claude, "anthropic")).toBe(true);
    expect(matches(claude, "OPUS")).toBe(true);
    expect(matches(claude, "gemini")).toBe(false);
  });
  test("space-separated tokens are AND", () => {
    const or = m("anthropic/claude-3.5-sonnet", "openrouter", "Claude 3.5 Sonnet");
    expect(matches(or, "openrouter sonnet")).toBe(true);
    expect(matches(or, "openrouter gpt")).toBe(false);
  });
});
