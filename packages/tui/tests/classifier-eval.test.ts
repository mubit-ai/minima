import { describe, expect, test } from "bun:test";
import type { UserPromptRow } from "../src/db/minima_db.ts";
import {
  type CallSpec,
  type DistinctPrompt,
  type DryRunConfig,
  buildDryRunReport,
  distinctPrompts,
  estimateRunCost,
  estimateTokens,
  formatRate,
  partitionSteerText,
  rate,
  renderDryRunReport,
  stratifyByLength,
} from "../src/minima/classifier_eval.ts";

// MUB-215 — the classifier evaluation's pure core. Every function here is total and takes plain
// arrays, so these tests construct rows directly: no ledger, no network, no spend.

/** A minimal user-prompt row (only the fields the eval core reads). */
function ev(text: string | null, over: Partial<UserPromptRow> = {}): UserPromptRow {
  return { id: "e1", run_id: "r1", ts: 1, text, ...over };
}

/** A distinct prompt of an exact character length. */
function p(chars: number, occurrences = 1): DistinctPrompt {
  return { text: "x".repeat(chars), occurrences };
}

describe("partitionSteerText", () => {
  test("routes harness-authored steer messages to excluded, real prompts to corpus", () => {
    // One row per prefix the shipped predicate keys on: stop-gate continuation, step-cap wrap,
    // doom-loop nudge, stream tripwire.
    const rows = [
      ev("fix the parser"),
      ev("⛔ You are ending the turn, but the plan is not done — 2 step(s) still need"),
      ev("⚠ You have used 40 of 50 steps"),
      ev("⚠ You have called read 12 times"),
      ev("Stream tripwire fired: you claimed done without a verify"),
      ev("add a test for the ledger"),
    ];
    const { corpus, excluded } = partitionSteerText(rows);
    expect(corpus.map((r) => r.text)).toEqual(["fix the parser", "add a test for the ledger"]);
    expect(excluded).toHaveLength(4);
  });
});

describe("distinctPrompts", () => {
  test("dedupes on exact recorded text, first-appearance order, counting occurrences", () => {
    const rows = [
      ev("fix the parser", { id: "a", ts: 1 }),
      ev("add a test", { id: "b", ts: 2 }),
      ev("fix the parser", { id: "c", ts: 3, run_id: "r2" }),
    ];
    expect(distinctPrompts(rows)).toEqual([
      { text: "fix the parser", occurrences: 2 },
      { text: "add a test", occurrences: 1 },
    ]);
  });

  test("drops rows carrying no usable prompt text", () => {
    expect(distinctPrompts([ev(null), ev(""), ev("   ")])).toEqual([]);
  });
});

describe("rate", () => {
  test("carries the numerator, the denominator and the percentage together", () => {
    // 138/305 = 45.2459…% — worked independently of the implementation.
    expect(rate(138, 305)).toEqual({ n: 138, d: 305, pct: 45.2 });
  });

  test("an empty denominator yields no percentage rather than a divide-by-zero", () => {
    expect(rate(0, 0)).toEqual({ n: 0, d: 0, pct: null });
  });
});

describe("formatRate", () => {
  test("renders the denominator inseparably from the percentage", () => {
    expect(formatRate(rate(138, 305))).toBe("138/305 (45.2%)");
  });

  test("renders an empty denominator as n/a, never as a bare 0%", () => {
    expect(formatRate(rate(0, 0))).toBe("0/0 (n/a)");
  });
});

describe("stratifyByLength", () => {
  test("buckets by character length, each share carrying the corpus denominator", () => {
    // Boundaries are lower-inclusive: 60 lands in the middle bucket, 199 too, 200 in the last.
    const prompts = [p(10), p(60), p(199), p(200)];
    expect(stratifyByLength(prompts, [60, 200])).toEqual([
      { label: "<60", minChars: 0, maxChars: 59, count: 1, share: rate(1, 4) },
      { label: "60-199", minChars: 60, maxChars: 199, count: 2, share: rate(2, 4) },
      { label: ">=200", minChars: 200, maxChars: null, count: 1, share: rate(1, 4) },
    ]);
  });

  test("counts distinct prompts, not occurrences", () => {
    // One prompt asked 40 times is one corpus entry — a repeat is not new evidence.
    const strata = stratifyByLength([p(10, 40)], [60]);
    expect(strata.map((s) => s.count)).toEqual([1, 0]);
  });

  test("an empty corpus yields every stratum at zero with no percentage", () => {
    const strata = stratifyByLength([], [60]);
    expect(strata.map((s) => s.count)).toEqual([0, 0]);
    expect(strata.every((s) => s.share.pct === null)).toBe(true);
  });

  test("total: unsorted, duplicate and non-positive boundaries still yield sane strata", () => {
    expect(stratifyByLength([p(10), p(80)], [200, 60, 60, 0, -5]).map((s) => s.label)).toEqual([
      "<60",
      "60-199",
      ">=200",
    ]);
  });
});

describe("estimateTokens", () => {
  test("estimates four characters per token, rounding up", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateRunCost", () => {
  function spec(over: Partial<CallSpec> = {}): CallSpec {
    return {
      label: "panel",
      callsPerPrompt: 1,
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      outputTokensPerCall: 50,
      ...over,
    };
  }

  test("prices input from the prompts and output from the declared per-call budget", () => {
    // 2 prompts x 400 chars = 200 input tokens; 2 calls x 50 = 100 output tokens.
    // 200/1e6 * $3 = $0.0006, 100/1e6 * $15 = $0.0015, total $0.0021 — worked by hand.
    const est = estimateRunCost([p(400), p(400)], [spec()]);
    expect(est.totalCalls).toBe(2);
    expect(est.totalInputTokens).toBe(200);
    expect(est.totalOutputTokens).toBe(100);
    expect(est.totalUsd).toBe(0.0021);
  });

  test("sums across a provider-diverse panel and reports each leg separately", () => {
    const est = estimateRunCost(
      [p(400)],
      [spec({ label: "a" }), spec({ label: "b", callsPerPrompt: 3 })],
    );
    expect(est.totalCalls).toBe(4);
    expect(est.lines.map((l) => l.label)).toEqual(["a", "b"]);
    expect(est.lines[1]?.calls).toBe(3);
  });

  test("prices every distinct prompt once, however often it was asked", () => {
    const once = estimateRunCost([p(400, 1)], [spec()]);
    const forty = estimateRunCost([p(400, 40)], [spec()]);
    expect(forty.totalUsd).toBe(once.totalUsd);
  });

  test("total: an empty corpus costs nothing and issues no calls", () => {
    const est = estimateRunCost([], [spec()]);
    expect(est.totalCalls).toBe(0);
    expect(est.totalUsd).toBe(0);
  });
});

describe("buildDryRunReport", () => {
  const cfg: DryRunConfig = {
    scope: "whole ledger",
    lengthBoundaries: [60],
    specs: [
      {
        label: "reference panel",
        callsPerPrompt: 1,
        inputUsdPerMTok: 3,
        outputUsdPerMTok: 15,
        outputTokensPerCall: 50,
      },
    ],
  };

  test("reports the corpus, the steer exclusion and the unusable rows, each with its denominator", () => {
    const rows = [
      ev("fix the parser"),
      ev("fix the parser", { id: "e2", ts: 2 }), // a repeat: one corpus entry, two occurrences
      ev("⚠ You have used 40 of 50 steps", { id: "e3", ts: 3 }),
      ev(null, { id: "e4", ts: 4 }),
    ];
    const r = buildDryRunReport(rows, cfg);
    expect(r.rawUserRows).toBe(4);
    expect(r.corpusDistinct).toBe(1);
    expect(r.corpusOccurrences).toBe(2);
    expect(r.steerRows).toEqual(rate(1, 4));
    expect(r.steerDistinct).toEqual(rate(1, 2)); // 1 steer text among 2 distinct texts
    expect(r.unusableRows).toEqual(rate(1, 4));
  });

  test("the corpus and the steer set partition the distinct texts exactly", () => {
    const rows = [
      ev("a"),
      ev("b", { id: "e2" }),
      ev("⚠ You have called read 12 times", { id: "e3" }),
    ];
    const r = buildDryRunReport(rows, cfg);
    expect(r.corpusDistinct + r.steerDistinct.n).toBe(r.steerDistinct.d);
  });

  test("costs the corpus, never the excluded steer text", () => {
    const prompt = "x".repeat(400);
    const withSteer = buildDryRunReport(
      [ev(prompt), ev(`⚠ You have used ${"y".repeat(400)}`, { id: "e2" })],
      cfg,
    );
    const withoutSteer = buildDryRunReport([ev(prompt)], cfg);
    expect(withSteer.cost.totalUsd).toBe(withoutSteer.cost.totalUsd);
  });

  test("total: no rows at all yields a zero report with no percentages", () => {
    const r = buildDryRunReport([], cfg);
    expect(r.rawUserRows).toBe(0);
    expect(r.corpusDistinct).toBe(0);
    expect(r.steerRows.pct).toBeNull();
    expect(r.cost.totalCalls).toBe(0);
  });
});

describe("renderDryRunReport", () => {
  const cfg: DryRunConfig = { scope: "whole ledger", lengthBoundaries: [60], specs: [] };

  test("prints every rate with its denominator and states that nothing was spent", () => {
    const out = renderDryRunReport(buildDryRunReport([ev("fix the parser"), ev(null)], cfg));
    expect(out).toContain("1/2"); // the unusable-row rate, denominator attached
    expect(out).toContain("$0.00");
    expect(out).toMatch(/no billable call/i);
  });

  test("never prints a bare percentage when there is no denominator", () => {
    const out = renderDryRunReport(buildDryRunReport([], cfg));
    expect(out).toContain("n/a");
    expect(out).not.toMatch(/\bNaN\b/);
  });

  test("prints the price basis, so the estimate can be re-derived from the output", () => {
    const out = renderDryRunReport(
      buildDryRunReport([ev("x".repeat(400))], {
        scope: "whole ledger",
        lengthBoundaries: [60],
        specs: [
          {
            label: "panel",
            callsPerPrompt: 1,
            inputUsdPerMTok: 3,
            outputUsdPerMTok: 15,
            outputTokensPerCall: 50,
          },
        ],
      }),
    );
    expect(out).toContain("$3/$15 per Mtok");
  });
});
