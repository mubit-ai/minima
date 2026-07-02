import { describe, expect, test } from "bun:test";
import {
  type DecisionRowLike,
  optimalCostRatio,
  qualityPerDollar,
  savings,
} from "../src/db/metrics.ts";
import {
  type ChildResult,
  type Delegation,
  type SpawnFn,
  taskTool,
  topoOrder,
  validateDelegations,
} from "../src/tools/task.ts";

const okDelegation = (over: Partial<Delegation> = {}): Delegation => ({
  step_id: over.step_id ?? "s1",
  objective: "do the thing",
  output_format: "a short summary",
  boundaries: "do not touch tests/",
  ...over,
});

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((b) => ("text" in b ? b.text : "")).join("");
}

const okSpawn: SpawnFn = async (d) => ({
  step_id: d.step_id,
  childId: `${d.step_id}-c`,
  text: `done ${d.step_id}`,
  costUsd: 0.01,
  quality: 0.9,
  outcome: "success",
  workdir: "/tmp",
});

describe("validateDelegations", () => {
  test("rejects missing required contract fields with an actionable message", () => {
    const v = validateDelegations([{ step_id: "a", objective: "x" }]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("output_format");
  });
  test("rejects duplicate ids, dangling deps, and cycles", () => {
    expect(validateDelegations([okDelegation(), okDelegation()]).ok).toBe(false); // dup s1
    expect(validateDelegations([okDelegation({ step_id: "a", depends_on: ["ghost"] })]).ok).toBe(
      false,
    );
    const cyclic = [
      okDelegation({ step_id: "a", depends_on: ["b"] }),
      okDelegation({ step_id: "b", depends_on: ["a"] }),
    ];
    const v = validateDelegations(cyclic);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("cycle");
  });
  test("accepts a valid DAG and topo-orders it", () => {
    const ds = [
      okDelegation({ step_id: "c", depends_on: ["a", "b"] }),
      okDelegation({ step_id: "a" }),
      okDelegation({ step_id: "b", depends_on: ["a"] }),
    ];
    expect(validateDelegations(ds).ok).toBe(true);
    expect(topoOrder(ds)!.map((d) => d.step_id)).toEqual(["a", "b", "c"]);
  });
});

describe("taskTool", () => {
  test("executes delegations in dependency order and passes prior results", async () => {
    const seen: { id: string; priors: string[] }[] = [];
    const spawn: SpawnFn = async (d, ctx) => {
      seen.push({ id: d.step_id, priors: ctx.priorResults.map((r) => r.step_id) });
      return { ...(await okSpawn(d, ctx)) };
    };
    const tool = taskTool({ spawn });
    const res = await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          okDelegation({ step_id: "verify", depends_on: ["build"] }),
          okDelegation({ step_id: "build" }),
        ]),
      },
      null,
      null,
    );
    expect(seen.map((s) => s.id)).toEqual(["build", "verify"]);
    expect(seen[1]!.priors).toEqual(["build"]); // dependency results reach dependents
    expect(textOf(res)).toContain("2 subtask(s), 2 succeeded");
  });

  test("a failed dependency blocks dependents (partial-failure semantics)", async () => {
    const spawn: SpawnFn = async (d, ctx) =>
      d.step_id === "build"
        ? { ...(await okSpawn(d, ctx)), outcome: "failure" as const, text: "boom" }
        : okSpawn(d, ctx);
    const tool = taskTool({ spawn });
    const res = await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          okDelegation({ step_id: "build" }),
          okDelegation({ step_id: "verify", depends_on: ["build"] }),
          okDelegation({ step_id: "independent" }),
        ]),
      },
      null,
      null,
    );
    const out = textOf(res);
    expect(out).toContain("blocked: dependency build failed");
    expect(out).toContain("independent [success]"); // unrelated node still ran
    expect(out).toContain("1 succeeded");
  });

  test("malformed JSON and invalid graphs return actionable tool errors", async () => {
    const tool = taskTool({ spawn: okSpawn });
    expect(textOf(await tool.execute("1", { delegations: "not json" }, null, null))).toContain(
      "not valid JSON",
    );
    expect(
      textOf(await tool.execute("1", { delegations: JSON.stringify([{}]) }, null, null)),
    ).toContain("step_id");
  });

  test("depth cap yields an explicit refusal, not a silent miss", async () => {
    const tool = taskTool({ spawn: okSpawn, spawnDepth: 2, maxDepth: 2 });
    const res = await tool.execute(
      "1",
      { delegations: JSON.stringify([okDelegation()]) },
      null,
      null,
    );
    expect(textOf(res)).toContain("depth");
    expect(textOf(res)).toContain("directly");
  });

  test("abort stops spawning further nodes", async () => {
    const spawned: string[] = [];
    const ctrl = new AbortController();
    const spawn: SpawnFn = async (d, ctx) => {
      spawned.push(d.step_id);
      ctrl.abort(); // abort after the first child
      return okSpawn(d, ctx);
    };
    const tool = taskTool({ spawn });
    await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          okDelegation({ step_id: "a" }),
          okDelegation({ step_id: "b" }),
        ]),
      },
      ctrl.signal,
      null,
    );
    expect(spawned).toEqual(["a"]);
  });
});

describe("metrics primitives (P1b)", () => {
  const row = (over: Partial<DecisionRowLike> = {}): DecisionRowLike => ({
    quality: 0.9,
    judged: 1,
    outcome: "success",
    actual_cost_usd: 0.01,
    est_cost_usd: 0.01,
    all_premium_cost_usd: 0.05,
    configured_baseline_cost_usd: null,
    decision_basis: "memory",
    threshold_used: 0.7,
    routed: "server",
    ranked: JSON.stringify([
      { modelId: "cheap", estCostUsd: 0.005, predictedSuccess: 0.75 },
      { modelId: "mid", estCostUsd: 0.01, predictedSuccess: 0.9 },
      { modelId: "big", estCostUsd: 0.05, predictedSuccess: 0.95 },
    ]),
    ...over,
  });

  test("QpD: hand-computed 3-row fixture — abstains excluded, failures included", () => {
    const rows = [
      row({ quality: 0.9, actual_cost_usd: 0.01 }), // judged success
      row({ quality: 0, outcome: "failure", actual_cost_usd: 0.02 }), // judged failure COUNTS
      row({ quality: null, judged: 0, actual_cost_usd: 0.5 }), // cadence-skip EXCLUDED
    ];
    const q = qualityPerDollar(rows);
    expect(q.judgedRows).toBe(2);
    expect(q.totalRows).toBe(3);
    // (0.9 + 0) / (0.01 + 0.02) = 30.0
    expect(q.qpd).toBeCloseTo(30.0, 5);
  });

  test("savings: dual baselines never conflated; unrouted spend reported", () => {
    const rows = [
      row({
        actual_cost_usd: 0.01,
        all_premium_cost_usd: 0.05,
        configured_baseline_cost_usd: 0.03,
      }),
      row({ routed: "pinned", actual_cost_usd: 0.2, all_premium_cost_usd: null }),
    ];
    const s = savings(rows);
    expect(s.vsAllPremiumUsd).toBeCloseTo(0.04, 8); // only the routed row
    expect(s.premiumRows).toBe(1);
    expect(s.vsBaselineUsd).toBeCloseTo(0.02, 8);
    expect(s.unroutedUsd).toBeCloseTo(0.2, 8); // pinned spend surfaced, not hidden
    expect(s.actualUsd).toBeCloseTo(0.21, 8);
  });

  test("OCR: oracle = cheapest τ-clearing candidate; prior-basis rows excluded", () => {
    const rows = [
      // τ=0.7: cheapest clearing is 'cheap' at 0.005; actual 0.01 → per-row oracle/actual 0.5
      row({ actual_cost_usd: 0.01 }),
      // prior basis → excluded from coverage (no evidence, not an oracle)
      row({ decision_basis: "prior", actual_cost_usd: 1.0 }),
    ];
    const o = optimalCostRatio(rows);
    expect(o.coveredRows).toBe(1);
    expect(o.ocr).toBeCloseTo(0.5, 5);
  });

  test("OCR: when no candidate clears τ, the full ladder is the pool (no fake oracle of 0)", () => {
    const o = optimalCostRatio([row({ threshold_used: 0.99, actual_cost_usd: 0.005 })]);
    expect(o.coveredRows).toBe(1);
    expect(o.ocr).toBe(1); // oracle (cheapest overall 0.005) / actual 0.005, capped at 1
  });
});
