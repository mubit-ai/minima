import { describe, expect, test } from "bun:test";
import type { Model } from "../src/ai/types.ts";
import { errText } from "../src/errtext.ts";
import { matches } from "../src/tui/model-picker.tsx";
import {
  formatRouteConfirm,
  routingInfoWarnings,
  runOptionDesc,
} from "../src/tui/routing-warnings.ts";

describe("formatRouteConfirm (route-confirm overlay copy)", () => {
  test("routed: model, basis, est cost band, filtered warnings", () => {
    const line = formatRouteConfirm({
      modelId: "gemini-2.5-flash",
      decisionBasis: "memory",
      estCostUsd: 0.002,
      estCostHigh: 0.004,
      warnings: ["no_model_meets_threshold", "thompson_pick"],
      offlineReason: null,
    });
    expect(line).toContain("gemini-2.5-flash ▸ memory");
    expect(line).toContain("est $0.002–$0.004");
    expect(line).toContain("no_model_meets_threshold");
    expect(line).not.toContain("thompson_pick"); // hidden internal signal stays hidden
  });

  test("offline: says what would run unrouted and why", () => {
    const line = formatRouteConfirm({
      modelId: "faux-a",
      decisionBasis: "offline",
      estCostUsd: null,
      estCostHigh: null,
      warnings: [],
      offlineReason: "minima is down",
    });
    expect(line).toContain("offline");
    expect(line).toContain("minima is down");
    expect(line).toContain("faux-a");
    expect(line).toContain("unrouted");
  });

  test("run-option descriptions name the basis", () => {
    const base = {
      estCostUsd: null,
      estCostHigh: null,
      warnings: [],
      offlineReason: null,
    };
    expect(
      runOptionDesc({ ...base, modelId: "m", decisionBasis: "pinned" }),
    ).toBe("run pinned m");
    expect(
      runOptionDesc({ ...base, modelId: "m", decisionBasis: "offline" }),
    ).toContain("unrouted");
    expect(runOptionDesc({ ...base, modelId: "m", decisionBasis: "memory" })).toBe("run m");
  });
});

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
      "cold_start",
      "reasoner_disabled",
      "reasoner_consulted",
      "thompson_pick",
      "exploration_pick",
      "prices_stale",
      "collapse_guard_applied",
      "escalation_suggested:thin_evidence",
      "escalation_suggested:wide_interval",
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
