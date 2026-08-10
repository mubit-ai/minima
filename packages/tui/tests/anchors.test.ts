import { describe, expect, test } from "bun:test";
import {
  type AnchorRowLike,
  type PriceRow,
  anchorBoard,
  anchorTotals,
  defaultAnchor,
  dollarCoverage,
  ledgerModels,
  normalizeModelId,
  pricesFrom,
  repriceRow,
  workhorse,
} from "../src/db/anchors.ts";
import { metricsReport } from "../src/db/metrics.ts";
import { CostMeter } from "../src/minima/meter.ts";

/**
 * Hermetic throughout: the estimator is pure over row arrays, so none of this needs a ledger, a
 * price catalog, or a network. Prices below are chosen so every expected number is hand-computable.
 */
const PRICES: ReadonlyMap<string, PriceRow> = pricesFrom([
  // input:output ratios deliberately DIFFER, or the solved tier is underdetermined by design.
  { id: "cheap", cost: { input: 1, output: 2 } },
  { id: "mid", cost: { input: 3, output: 15 } },
  { id: "premium", cost: { input: 10, output: 50 } },
  { id: "claude-sonnet-5", cost: { input: 3, output: 15 } },
]);

function row(over: Partial<AnchorRowLike> = {}): AnchorRowLike {
  return {
    chosen_model: "cheap",
    actual_cost_usd: 1.0,
    est_cost_usd: 0.01,
    threshold_used: 0.6,
    routed: "server",
    ranked: JSON.stringify([
      { modelId: "cheap", estCostUsd: 0.01, predictedSuccess: 0.7 },
      { modelId: "premium", estCostUsd: 0.05, predictedSuccess: 0.9 },
    ]),
    ...over,
  };
}

describe("anchor repricing — the direct tier", () => {
  test("prices from the two stored estimates and never consults the price table", () => {
    // No prices at all: the direct tier must still work, because both estimates came from the
    // row's own candidate set.
    const r = repriceRow(row(), "premium", new Map(), new Set());
    expect(r.tier).toBe("direct");
    // 1.00 realized x (0.05 / 0.01) = 5.00
    expect(r.anchorUsd).toBeCloseTo(5.0, 8);
    expect(r.actualUsd).toBeCloseTo(1.0, 8);
  });

  test("the unit bug cannot return: the result scales with REALIZED cost, not the estimate", () => {
    // This is the regression that started the work. `all_premium_cost_usd - actual_cost_usd`
    // subtracted a per-call estimate from a per-turn realized cost; a row whose realized cost is
    // 10x its estimate then reported a LOSS against a 5x-more-expensive anchor.
    const cheapTurn = repriceRow(row({ actual_cost_usd: 0.01 }), "premium", PRICES);
    const expensiveTurn = repriceRow(row({ actual_cost_usd: 0.1 }), "premium", PRICES);
    expect(expensiveTurn.anchorUsd).toBeCloseTo(cheapTurn.anchorUsd * 10, 8);
    // And the saving stays positive at every scale — the anchor is 5x the chosen model.
    for (const actual of [0.001, 0.01, 1, 100]) {
      const t = anchorTotals([row({ actual_cost_usd: actual })], "premium", PRICES);
      expect(t.savedUsd).toBeGreaterThan(0);
      expect(t.savedPct).toBeCloseTo(0.8, 8); // 1 - 1/5
    }
  });

  test("the anchor priced against itself reprices to exactly what was spent", () => {
    const t = anchorTotals([row()], "cheap", PRICES);
    expect(t.anchorUsd).toBeCloseTo(t.actualUsd, 10);
    expect(t.savedUsd).toBeCloseTo(0, 10);
  });
});

describe("anchor repricing — the solved tier", () => {
  const threeWay = JSON.stringify([
    // 1000 in / 2000 out: cheap = 1000*1e-6 + 2000*2e-6 = 0.005; mid = 0.003 + 0.03 = 0.033
    { modelId: "cheap", estCostUsd: 0.005, predictedSuccess: 0.7 },
    { modelId: "mid", estCostUsd: 0.033, predictedSuccess: 0.8 },
  ]);

  test("recovers the token vector and prices a model that was never a candidate", () => {
    const r = repriceRow(
      row({ chosen_model: "cheap", est_cost_usd: 0.005, ranked: threeWay, actual_cost_usd: 1 }),
      "premium",
      PRICES,
    );
    expect(r.tier).toBe("solved");
    // premium at 1000 in / 2000 out = 0.01 + 0.1 = 0.11; ratio 0.11/0.005 = 22
    expect(r.anchorUsd).toBeCloseTo(22, 6);
    // A solved row cannot know whether the anchor would have cleared the threshold.
    expect(r.tauCleared).toBeNull();
  });

  test("a single-candidate row is excluded and counted, never guessed", () => {
    const one = row({
      ranked: JSON.stringify([{ modelId: "cheap", estCostUsd: 0.01, predictedSuccess: 0.7 }]),
    });
    expect(repriceRow(one, "premium", PRICES).tier).toBe("excluded");
    const t = anchorTotals([one], "premium", PRICES);
    expect(t.excludedRows).toBe(1);
    expect(t.directRows + t.solvedRows).toBe(0);
    expect(t.anchorUsd).toBe(0);
    expect(t.savedPct).toBeNull();
  });

  test("a degenerate solve — every candidate on one price ratio — is excluded, not clamped", () => {
    // mid (3:15) and claude-sonnet-5 (3:15) share one input:output ratio, so the two-unknown
    // system has no unique solution. Guessing here would fabricate a token mix.
    const flat = row({
      chosen_model: "mid",
      est_cost_usd: 0.033,
      ranked: JSON.stringify([
        { modelId: "mid", estCostUsd: 0.033, predictedSuccess: 0.8 },
        { modelId: "claude-sonnet-5", estCostUsd: 0.033, predictedSuccess: 0.82 },
      ]),
    });
    expect(repriceRow(flat, "premium", PRICES).tier).toBe("excluded");
  });

  test("an anchor with no catalog price is excluded rather than priced from nothing", () => {
    expect(repriceRow(row({ ranked: threeWay }), "no-such-model", PRICES).tier).toBe("excluded");
  });

  test("estimates that no token vector can explain are refused, not fitted", () => {
    // cheap cheaper per-token than mid yet quoted HIGHER: the least-squares solution goes
    // non-physical (a negative token count), which must be an exclusion.
    const impossible = row({
      chosen_model: "mid",
      est_cost_usd: 0.001,
      ranked: JSON.stringify([
        { modelId: "cheap", estCostUsd: 0.5, predictedSuccess: 0.7 },
        { modelId: "mid", estCostUsd: 0.001, predictedSuccess: 0.8 },
      ]),
    });
    expect(repriceRow(impossible, "premium", PRICES).tier).toBe("excluded");
  });
});

describe("anchor repricing — what it refuses to do", () => {
  test("a negative saving is reported negative, never clamped to zero", () => {
    // A cheaper anchor than what actually ran: routing overspent it, and that is the honest read.
    const t = anchorTotals([row({ chosen_model: "premium", est_cost_usd: 0.05 })], "cheap", PRICES);
    expect(t.savedUsd).toBeLessThan(0);
    expect(t.savedPct).toBeLessThan(0);
    // 1.00 x (0.01/0.05) = 0.20 would have been spent; saving = 0.20 - 1.00 = -0.80
    expect(t.savedUsd).toBeCloseTo(-0.8, 8);
    expect(t.savedPct).toBeCloseTo(-4, 8);
  });

  test("unrouted rows are never part of an anchor comparison", () => {
    const rows = [row(), row({ routed: "pinned", actual_cost_usd: 99 })];
    const t = anchorTotals(rows, "premium", PRICES);
    expect(t.directRows).toBe(1);
    expect(t.excludedRows).toBe(0); // not "excluded" — never in the population at all
    expect(t.actualUsd).toBeCloseTo(1, 8);
  });

  test("a row with no usable chosen-model estimate has no ratio, so it is excluded", () => {
    const noEst = row({ chosen_model: "gone", est_cost_usd: null });
    expect(repriceRow(noEst, "premium", PRICES).tier).toBe("excluded");
    expect(repriceRow(row({ est_cost_usd: 0, chosen_model: "gone" }), "premium", PRICES).tier).toBe(
      "excluded",
    );
  });

  test("unparseable or absent ranked JSON never throws", () => {
    expect(repriceRow(row({ ranked: "{not json" }), "premium", PRICES).tier).toBe("excluded");
    expect(repriceRow(row({ ranked: null }), "premium", PRICES).tier).toBe("excluded");
    expect(repriceRow(row({ ranked: '{"a":1}' }), "premium", PRICES).tier).toBe("excluded");
  });

  test("τ-miss is counted only where the anchor's own prediction is knowable", () => {
    const clears = row({ threshold_used: 0.85 }); // premium predicts 0.9 → clears
    const misses = row({ threshold_used: 0.95 }); // premium predicts 0.9 → misses
    const t = anchorTotals([clears, misses], "premium", PRICES);
    expect(t.tauKnownRows).toBe(2);
    expect(t.tauMissRows).toBe(1);
    // A row with no threshold recorded is not a miss and not a clear.
    const noTau = anchorTotals([row({ threshold_used: null })], "premium", PRICES);
    expect(noTau.tauKnownRows).toBe(0);
    expect(noTau.tauMissRows).toBe(0);
  });
});

describe("model-id hygiene", () => {
  test("a provider prefix is stripped only when the remainder is a model we know", () => {
    const known = new Set(["claude-sonnet-5", "moonshotai/kimi-k2.6"]);
    expect(normalizeModelId("anthropic/claude-sonnet-5", known)).toBe("claude-sonnet-5");
    expect(normalizeModelId("claude-sonnet-5", known)).toBe("claude-sonnet-5");
    // Ids that legitimately carry a slash must survive intact, or the catalog lookup misses.
    expect(normalizeModelId("moonshotai/kimi-k2.6", known)).toBe("moonshotai/kimi-k2.6");
    // An unverifiable merge is not performed.
    expect(normalizeModelId("someone/unknown-model", known)).toBe("someone/unknown-model");
  });

  test("both spellings of one model aggregate as ONE bar, not two", () => {
    const sonnetOnly = JSON.stringify([
      { modelId: "claude-sonnet-5", estCostUsd: 0.03, predictedSuccess: 0.9 },
      { modelId: "cheap", estCostUsd: 0.01, predictedSuccess: 0.7 },
    ]);
    const rows = [
      row({ chosen_model: "claude-sonnet-5", est_cost_usd: 0.03, ranked: sonnetOnly }),
      row({ chosen_model: "anthropic/claude-sonnet-5", est_cost_usd: 0.03, ranked: sonnetOnly }),
    ];
    const ids = ledgerModels(rows, new Set(PRICES.keys()));
    expect(ids).toEqual(["cheap", "claude-sonnet-5"]);
    expect(ids.filter((id) => id.includes("sonnet")).length).toBe(1);
    const board = anchorBoard(rows, PRICES);
    const sonnet = board.models.find((m) => m.modelId === "claude-sonnet-5")!;
    // Both rows land on ONE entry, and the prefixed row is direct-tier rather than unpriced.
    expect(sonnet.directRows).toBe(2);
    expect(sonnet.excludedRows).toBe(0);
    expect(workhorse(rows, new Set(PRICES.keys()))).toBe("claude-sonnet-5");
  });

  test("a candidate's prefixed id also normalizes, so the anchor is found directly", () => {
    const prefixed = row({
      ranked: JSON.stringify([
        { modelId: "cheap", estCostUsd: 0.01, predictedSuccess: 0.7 },
        { modelId: "anthropic/claude-sonnet-5", estCostUsd: 0.03, predictedSuccess: 0.9 },
      ]),
    });
    expect(repriceRow(prefixed, "claude-sonnet-5", PRICES).tier).toBe("direct");
  });

  test("a $0-realized row counts toward rows priced but not toward dollar coverage", () => {
    // Real ledgers have these (gpt-5.6-luna: 5 routed rows, $0.00). The anchor multiplies actual,
    // so a free row contributes exactly nothing while still looking like coverage.
    const rows = [row({ actual_cost_usd: 1 }), row({ actual_cost_usd: 0 })];
    const board = anchorBoard(rows, PRICES);
    const t = anchorTotals(rows, "premium", PRICES);
    expect(t.directRows).toBe(2);
    expect(t.actualUsd).toBeCloseTo(1, 8);
    expect(dollarCoverage(t, board.realizedUsd)).toBeCloseTo(1, 8);
    // Row coverage would say 2/2 = 100% on a population where half the rows say nothing.
    expect(t.directRows / board.serverRows).toBe(1);
  });
});

describe("the board", () => {
  const rows = [
    row({ chosen_model: "cheap" }),
    row({ chosen_model: "cheap" }),
    row({ chosen_model: "premium", est_cost_usd: 0.05, actual_cost_usd: 4 }),
    row({ routed: "offline", chosen_model: "mid", actual_cost_usd: 7 }),
  ];

  test("one entry per ROUTED model, most expensive anchor first", () => {
    const board = anchorBoard(rows, PRICES);
    // `mid` was chosen only on an offline row, so it gets no bar — a bar for a model the router
    // never considered would be pure inference.
    expect(board.models.map((m) => m.modelId)).toEqual(["premium", "cheap"]);
    expect(board.models[0]!.anchorUsd).toBeGreaterThan(board.models[1]!.anchorUsd);
  });

  test("the reference line is realized spend over the routed population only", () => {
    const board = anchorBoard(rows, PRICES);
    expect(board.realizedUsd).toBeCloseTo(1 + 1 + 4, 8); // the offline $7 is not in it
    expect(board.serverRows).toBe(3);
  });

  test("the workhorse is computed over the population the anchors can price", () => {
    // Counted over ALL rows this would still be `cheap` here, but the rule is what matters: on a
    // real ledger claude-haiku-4-5 is 107 chosen / 48 routed, so the answer flips with the
    // denominator, and the label would then name a model priced by almost none of its own rows.
    expect(workhorse(rows, new Set(PRICES.keys()))).toBe("cheap");
    const pinnedHeavy = [
      row({ chosen_model: "cheap" }),
      row({ routed: "pinned", chosen_model: "mid" }),
      row({ routed: "pinned", chosen_model: "mid" }),
      row({ routed: "pinned", chosen_model: "mid" }),
    ];
    expect(workhorse(pinnedHeavy, new Set(PRICES.keys()))).toBe("cheap");
  });

  test("the default anchor prefers the premium Anthropic model when the ledger has it", () => {
    const withOpus = [row({ chosen_model: "cheap" }), row({ chosen_model: "claude-opus-4-8" })];
    expect(defaultAnchor(anchorBoard(withOpus))).toBe("claude-opus-4-8");
    // Otherwise the most expensive anchor this ledger can actually price.
    expect(defaultAnchor(anchorBoard(rows, PRICES))).toBe("premium");
    expect(defaultAnchor(anchorBoard([], PRICES))).toBeNull();
  });

  test("an empty ledger reports no board rather than a zero-dollar comparison", () => {
    const board = anchorBoard([], PRICES);
    expect(board.models).toEqual([]);
    expect(board.realizedUsd).toBe(0);
    expect(board.workhorse).toBeNull();
  });
});

describe("one number, one screen", () => {
  const rows = [
    {
      quality: 0.9,
      judged: 1,
      outcome: "success",
      chosen_model: "cheap",
      actual_cost_usd: 1,
      est_cost_usd: 0.01,
      all_premium_cost_usd: 0.05,
      configured_baseline_cost_usd: null,
      decision_basis: "observed",
      threshold_used: 0.6,
      routed: "server",
      ranked: JSON.stringify([
        { modelId: "cheap", estCostUsd: 0.01, predictedSuccess: 0.7 },
        { modelId: "claude-opus-4-8", estCostUsd: 0.05, predictedSuccess: 0.9 },
      ]),
    },
  ];

  test("metricsReport prints the repriced anchor, and never the old subtraction", () => {
    const out = metricsReport(rows);
    expect(out).toContain("vs claude-opus-4-8");
    // 1.00 x (0.05/0.01) = 5.00, so the saving is $4.00 — not the -$0.95 the old code printed.
    expect(out).toContain("saved $4.0000");
    expect(out).not.toContain("all-premium");
    expect(out).not.toContain("optimal-cost-ratio");
    expect(out).toContain("1 direct / 0 solved");
  });

  test("metricsReport discloses judged coverage in dollars", () => {
    expect(metricsReport(rows)).toContain("of spend");
  });

  test("the meter claims no savings, so the /cost screen states one number once", () => {
    // `meter.report()` is appended to the SAME /cost output immediately above metricsReport. It
    // used to print `baseline $0.000000 (0 rows) | savings 0.0% ($-X)` — the negative of session
    // spend, labeled savings, next to "savings 0.0%".
    const meter = new CostMeter();
    meter.record({
      label: "t",
      routing: null,
      actualCostUsd: 0.5,
      quality: 0.9,
      outcome: "success",
    });
    const report = meter.report();
    expect(report).not.toContain("savings");
    expect(report).not.toContain("baseline");
    expect(report).not.toContain("save$");
    expect(report).not.toContain("$-");
    // What it does still report is everything a live session can honestly know.
    expect(report).toContain("total actual");
    expect(report).toContain("success");
  });
});
