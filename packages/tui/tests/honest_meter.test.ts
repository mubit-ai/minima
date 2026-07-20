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
