import { describe, expect, test } from "bun:test";
import { CostMeter } from "../src/minima/meter.ts";

// F1 honest meter: KV-cache hit rate, cost-of-pass over LABELED passes only (with the
// coverage disclosure), and legacy rows degrading to honest nulls — never fabricated 0s.

function rec(
  meter: CostMeter,
  o: {
    cost: number;
    outcome: string;
    quality?: number | null;
    labeled?: boolean;
    cacheRead?: number;
    input?: number;
  },
): void {
  meter.record({
    label: "t",
    routing: null,
    actualCostUsd: o.cost,
    quality: o.quality ?? null,
    outcome: o.outcome,
    cacheReadTokens: o.cacheRead ?? 0,
    inputTokens: o.input ?? 0,
    labeled: o.labeled,
  });
}

describe("honest meter (F1)", () => {
  test("kv-cache hit rate is cache_read/(cache_read+input); null before telemetry", () => {
    const meter = new CostMeter();
    expect(meter.totals().kvCacheHitRate).toBeNull();
    rec(meter, { cost: 0.01, outcome: "success", cacheRead: 900, input: 100 });
    rec(meter, { cost: 0.01, outcome: "success", cacheRead: 0, input: 1000 });
    expect(meter.totals().kvCacheHitRate).toBeCloseTo(900 / 2000, 6);
  });

  test("cost-of-pass counts LABELED passes only; spend is total incl. overhead", () => {
    const meter = new CostMeter();
    meter.addOverhead(0.01);
    rec(meter, { cost: 0.02, outcome: "success", quality: 0.9 }); // labeled pass (judge)
    rec(meter, { cost: 0.03, outcome: "success", labeled: true }); // labeled pass (gate)
    rec(meter, { cost: 0.05, outcome: "success" }); // UNLABELED "success" — never a pass
    rec(meter, { cost: 0.04, outcome: "failure", quality: 0.1 }); // labeled failure
    const t = meter.totals();
    expect(t.labeledRows).toBe(3);
    expect(t.labeledSuccesses).toBe(2);
    expect(t.costOfPassUsd).toBeCloseTo((0.02 + 0.03 + 0.05 + 0.04 + 0.01) / 2, 8);
    expect(t.labelCoverage).toBeCloseTo(3 / 4, 6);
  });

  test("no labeled successes → cost-of-pass null, never zero or infinite", () => {
    const meter = new CostMeter();
    rec(meter, { cost: 0.05, outcome: "success" }); // unlabeled
    expect(meter.totals().costOfPassUsd).toBeNull();
  });

  test("the report discloses both metrics with coverage", () => {
    const meter = new CostMeter();
    rec(meter, {
      cost: 0.02,
      outcome: "success",
      quality: 0.9,
      cacheRead: 750,
      input: 250,
    });
    const report = meter.report();
    expect(report).toContain("kv-cache hit 75.0%");
    expect(report).toContain("cost-of-pass $0.020000 (1 labeled pass, label coverage 100%)");
    const empty = new CostMeter();
    rec(empty, { cost: 0.01, outcome: "success" });
    expect(empty.report()).toContain("cost-of-pass n/a (no labeled successes; label coverage 0%)");
  });
});

// MUB-172: web_search provider fees are real money outside every routed row — booked per
// tool_call_id (so sections can attribute them), never into actualCostUsd or feedback.
describe("tool fees (web_search provider spend)", () => {
  test("bookToolFee accumulates per tool_call_id into totals().toolFeesUsd, never actualCostUsd", () => {
    const meter = new CostMeter();
    rec(meter, { cost: 0.5, outcome: "success" });
    meter.bookToolFee("ws-1", 0.005);
    meter.bookToolFee("ws-2", 0.005);
    const t = meter.totals();
    expect(t.toolFeesUsd).toBeCloseTo(0.01, 12);
    expect(t.actualCostUsd).toBeCloseTo(0.5, 12);
    expect(meter.toolFees.get("ws-1")).toBeCloseTo(0.005, 12);
  });

  test("guards NaN / Infinity / zero / negatives / empty id", () => {
    const meter = new CostMeter();
    meter.bookToolFee("t1", Number.NaN);
    meter.bookToolFee("t1", Number.POSITIVE_INFINITY);
    meter.bookToolFee("t1", 0);
    meter.bookToolFee("t1", -0.01);
    meter.bookToolFee("", 0.01);
    expect(meter.totals().toolFeesUsd).toBe(0);
    expect(meter.toolFees.size).toBe(0);
  });

  test("report() shows tool fees + session total; cost-of-pass includes the spend", () => {
    const meter = new CostMeter();
    rec(meter, { cost: 0.5, outcome: "success", quality: 0.9 });
    expect(meter.report()).not.toContain("tool fees");
    meter.addOverhead(0.25);
    meter.bookToolFee("ws-1", 0.05);
    const report = meter.report();
    expect(report).toContain("judge overhead $0.250000");
    expect(report).toContain("tool fees $0.050000");
    expect(report).toContain("session total $0.800000");
    expect(meter.totals().costOfPassUsd).toBeCloseTo(0.8, 8);
  });
});
