import { describe, expect, test } from "bun:test";
import type { Model } from "../src/ai/types.ts";
import { effortIndicator, permsSummary } from "../src/tui/status.tsx";

const model = (over: Partial<Model> = {}): Model => ({
  id: "gpt-5.6-luna",
  provider: "openai",
  api: "openai-completions",
  name: "GPT-5.6 Luna",
  cost: { input: 1, output: 6 },
  context_window: 1_050_000,
  max_tokens: 128_000,
  reasoning: true,
  ...over,
});

// MUB-229. The indicator reads the SAME effectiveEffort the provider builds its payload
// from, so these cases are the wire's cases — the bar cannot drift from it by construction.
describe("effortIndicator (the reason segment)", () => {
  test("an honoured level renders as itself, with no arrow", () => {
    expect(effortIndicator("high", model(), true)).toMatchObject({
      label: "high",
      show: true,
    });
  });

  test("a clamped level shows requested→effective, which is the whole point", () => {
    expect(effortIndicator("xhigh", model(), true).label).toBe("xhigh→high");
    expect(effortIndicator("minimal", model(), true).label).toBe("minimal→low");
  });

  test("the tools pin is shown as a divergence too, not as the level the user picked", () => {
    const pinned = model({ tools_require_effort_none: true });
    expect(effortIndicator("high", pinned, true).label).toBe("high→none");
    // Tool-less, the same model keeps the level: the API refuses only the combination.
    expect(effortIndicator("high", pinned, false).label).toBe("high");
  });

  // The lie in the other direction: nothing is sent, so the model applies its OWN default —
  // which is not "off", and must not be rendered as off.
  test("sending nothing renders as `default`, never as `off`", () => {
    expect(effortIndicator("high", model({ reasoning: undefined }), true).label).toBe(
      "high→default",
    );
    expect(effortIndicator("off", model(), true)).toMatchObject({ label: "default", show: false });
  });

  test("a model that declares it cannot reason renders `off`", () => {
    expect(effortIndicator("high", model({ reasoning: false }), true).label).toBe("high→off");
  });

  // Thinking off is the shipped default; the segment stays hidden unless the harness is
  // overriding something, which is the only case worth a permanent cell in the row.
  test("visibility: hidden at rest, shown when a level is set or the harness overrides", () => {
    expect(effortIndicator("off", model(), true).show).toBe(false);
    expect(effortIndicator("medium", model(), true).show).toBe(true);
    const pinned = model({ tools_require_effort_none: true });
    expect(effortIndicator("off", pinned, true)).toMatchObject({ label: "none", show: true });
  });

  test("with no model resolved yet, the bar reports only what was requested", () => {
    expect(effortIndicator("high", null, true)).toMatchObject({ label: "high", show: true });
    expect(effortIndicator("off", null, true).show).toBe(false);
  });

  test("anthropic keeps xhigh — the bar follows the host vocabulary, not a global rule", () => {
    const claude = model({ provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" });
    expect(effortIndicator("xhigh", claude, true).label).toBe("xhigh");
  });

  // The google provider sends thinkingConfig and never an effort, so claiming the level was
  // honoured there would be the same class of lie this ticket removes.
  test("google reports the model's own default rather than the level", () => {
    const gemini = model({ provider: "google", api: "google-generative-ai", id: "gemini-3.6-flash" });
    expect(effortIndicator("high", gemini, true).label).toBe("high→default");
  });
});

describe("permsSummary (mode-aware perms footer)", () => {
  test("states what the ACTIVE mode does with w/e/b", () => {
    expect(permsSummary("build", [], []).effective).toBe("w/e/b: ask");
    expect(permsSummary("acceptEdits", [], []).effective).toBe("w/e: auto (cwd) · b: ask");
    expect(permsSummary("bypass", [], []).effective).toBe("w/e/b: auto");
    expect(permsSummary("plan", [], []).effective).toBe("PLAN (deny)");
  });

  test("grants list: whole tools, bash families, and the supersede rule", () => {
    expect(permsSummary("build", [], []).grants).toBeNull();
    expect(permsSummary("build", ["write"], []).grants).toBe("--x write");
    expect(permsSummary("build", [], ["git", "pip"]).grants).toBe("--x bash[git,pip]");
    expect(permsSummary("build", ["write"], ["pip"]).grants).toBe("--x write, bash[pip]");
    // A whole-tool bash grant supersedes its family list — never both.
    expect(permsSummary("build", ["bash"], ["pip"]).grants).toBe("--x bash");
  });

  test("grants render regardless of mode (the effective segment stays separate)", () => {
    const s = permsSummary("acceptEdits", [], ["pip"]);
    expect(s.effective).toBe("w/e: auto (cwd) · b: ask");
    expect(s.grants).toBe("--x bash[pip]");
  });
});
