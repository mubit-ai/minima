import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  COLD_START_OUTPUT_TOKENS,
  ESTIMATE_WINDOW,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  MIN_SAMPLES,
  estimateOutputTokens,
  estimateOutputTokensFor,
} from "../src/minima/output_estimate.ts";

describe("estimateOutputTokens", () => {
  test("cold start until MIN_SAMPLES realized runs exist", () => {
    expect(estimateOutputTokens([])).toBe(COLD_START_OUTPUT_TOKENS);
    expect(estimateOutputTokens(Array(MIN_SAMPLES - 1).fill(5_000))).toBe(COLD_START_OUTPUT_TOKENS);
    // The MIN_SAMPLES'th sample is what lets observed behaviour take over.
    expect(estimateOutputTokens(Array(MIN_SAMPLES).fill(5_000))).toBe(5_000);
  });

  test("zero and non-finite samples never count as evidence of a cheap turn", () => {
    // A failed rung spends nothing; treating that as a 0-token run would bias every
    // later estimate toward the floor.
    expect(estimateOutputTokens([0, 0, 0, 0])).toBe(COLD_START_OUTPUT_TOKENS);
    expect(estimateOutputTokens([Number.NaN, 900, 900, 900])).toBe(900);
  });

  test("uses the mean, not the median — cost is linear in tokens", () => {
    // Median would report 100 and under-price the pool by ~3x.
    const samples = [100, 100, 100, 100, 1_000];
    expect(estimateOutputTokens(samples)).toBe(280);
  });

  test("winsorizes the multi-turn tail: counted, but not dominant", () => {
    // Nine ~200-token runs and one 24-turn blowup. The raw mean (2_180) is dragged by a
    // single run; winsorizing at p90 caps that run's contribution while still counting it
    // above every other sample.
    const samples = [200, 200, 200, 200, 200, 200, 200, 200, 200, 20_000];
    const raw = samples.reduce((a, b) => a + b, 0) / samples.length;
    const est = estimateOutputTokens(samples);
    expect(raw).toBe(2_180);
    expect(est).toBe(200);
    expect(est).toBeLessThan(raw);
  });

  test("clamps both directions", () => {
    expect(estimateOutputTokens([1, 1, 1, 1])).toBe(MIN_OUTPUT_TOKENS);
    expect(estimateOutputTokens(Array(5).fill(10_000_000))).toBe(MAX_OUTPUT_TOKENS);
  });
});

describe("estimateOutputTokensFor (ledger-backed)", () => {
  // rec_id must be unique per row: writeDecision upserts on it, so a repeated id silently
  // rewrites an existing decision instead of adding one.
  function seed(db: MinimaDb, runId: string, rows: { n: number; type: string }[]) {
    rows.forEach((r, i) => {
      db.writeDecision({
        recId: `rec-${runId}-${r.type}-${i}`,
        runId,
        taskLabel: "t",
        taskType: r.type,
        chosenModel: "m",
        decisionBasis: "prior",
        confidence: 0,
        thresholdUsed: 0.7,
        ranked: [],
        estCostUsd: 0.001,
        actualCostUsd: 0.001,
        outputTokens: r.n,
        inputTokens: 4_000,
        quality: null,
        judged: false,
        outcome: "success",
        turns: 1,
        latencyMs: 10,
      });
    });
  }

  test("prefers same-task-type history, falls back to the project's overall shape", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    seed(db, runId, [
      ...Array(4).fill({ n: 3_000, type: "code" }),
      ...Array(4).fill({ n: 300, type: "qa" }),
    ]);

    expect(estimateOutputTokensFor(db, "p", "code")).toBe(3_000);
    expect(estimateOutputTokensFor(db, "p", "qa")).toBe(300);
    // Unknown type -> project-wide mean over both cohorts.
    expect(estimateOutputTokensFor(db, "p", null)).toBe(1_650);
    db.close();
  });

  test("a thin task-type cohort falls back rather than estimating off 1 sample", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    seed(db, runId, [{ n: 9_000, type: "creative" }, ...Array(4).fill({ n: 500, type: "code" })]);
    // One `creative` row is below MIN_SAMPLES, so the project-wide estimate applies
    // instead of extrapolating from a single run.
    expect(estimateOutputTokensFor(db, "p", "creative")).toBe(estimateOutputTokensFor(db, "p"));
    db.close();
  });

  test("scoped to the project — another repo's turn shape never leaks in", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("mine");
    db.ensureProject("theirs");
    const mine = db.startRun({ projectKey: "mine" });
    const theirs = db.startRun({ projectKey: "theirs" });
    seed(db, mine, Array(4).fill({ n: 400, type: "code" }));
    seed(db, theirs, Array(4).fill({ n: 20_000, type: "code" }));

    expect(estimateOutputTokensFor(db, "mine", "code")).toBe(400);
    expect(estimateOutputTokensFor(db, "theirs", "code")).toBe(20_000);
    db.close();
  });

  test("cold start on an empty ledger, and fail-open on a broken one", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    db.startRun({ projectKey: "p" });
    expect(estimateOutputTokensFor(db, "p", "code")).toBe(COLD_START_OUTPUT_TOKENS);
    db.close();

    const broken = {
      recentOutputTokens(): number[] {
        throw new Error("ledger unavailable");
      },
    };
    // An estimate is an optimization; a ledger failure must never fail the turn.
    expect(estimateOutputTokensFor(broken, "p", "code")).toBe(COLD_START_OUTPUT_TOKENS);
  });

  test("reads at most ESTIMATE_WINDOW rows, newest first", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    // Older runs are large; the newest ESTIMATE_WINDOW are small. A window that ignored
    // recency (or read everything) would report the stale large figure.
    seed(db, runId, [
      ...Array(10).fill({ n: 50_000, type: "code" }),
      ...Array(ESTIMATE_WINDOW).fill({ n: 600, type: "code" }),
    ]);
    expect(db.recentOutputTokens("p", ESTIMATE_WINDOW, "code")).toHaveLength(ESTIMATE_WINDOW);
    expect(estimateOutputTokensFor(db, "p", "code")).toBe(600);
    db.close();
  });
});

describe("realized token retention", () => {
  test("writeDecision round-trips run-total usage", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const base = {
      recId: "rec-1",
      runId,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "prior",
      confidence: 0,
      thresholdUsed: 0.7,
      ranked: [],
      estCostUsd: 0.001,
      actualCostUsd: 0.001,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 10,
    };
    db.writeDecision(base);
    const before = db.getRunDecisions(runId)[0]!;
    expect(before.output_tokens).toBeNull();

    // Usage lands with the outcome, i.e. on the ON CONFLICT update — not the insert.
    db.writeDecision({ ...base, inputTokens: 12_345, outputTokens: 6_789, turns: 4 });
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_tokens).toBe(12_345);
    expect(rows[0]!.output_tokens).toBe(6_789);
    db.close();
  });
});
