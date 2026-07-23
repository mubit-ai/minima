import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionWrite } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import type { Factors } from "../src/minima/big_plan_contract.ts";
import { whyReportFor } from "../src/minima/why.ts";

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

function decision(
  overrides: Partial<DecisionWrite> & { recId: string; runId: string },
): DecisionWrite {
  return {
    taskLabel: "t",
    chosenModel: "m",
    decisionBasis: "estimate",
    confidence: 0.5,
    thresholdUsed: 0.5,
    ranked: [],
    estCostUsd: 0.01,
    actualCostUsd: 0,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 10,
    ...overrides,
  };
}

describe("whyReportFor", () => {
  test("reports missing ledger context and missing plans", () => {
    expect(whyReportFor(null, "run1")).toBe("No plan ledger available.");
    expect(whyReportFor(db(), null)).toBe("No plan ledger available.");
    expect(whyReportFor(db(), "run1")).toBe("No plan recorded for this run.");
  });

  test("renders each step's check, tier, reason, and drift from the ledger", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos(
      "run1",
      [
        { content: "Trusted step", status: "completed", verify: "bun test trusted" },
        { content: "Agent step", status: "completed", verify: "bun test agent" },
        { content: "Pending step", status: "pending" },
      ],
      "Mixed plan",
    );
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "verified",
      confidence: "green",
      verifiedBy: "deterministic",
      factors: GREEN,
    });
    d.insertGate({
      planId,
      stepId: stepIds[1],
      outcome: "verified",
      confidence: "yellow",
      verifiedBy: "deterministic",
      factors: { ...GREEN, checkOrigin: "agent_new" },
    });
    d.insertFileChange({
      planId,
      stepId: stepIds[0],
      path: "src/on-plan.ts",
      origin: "on_plan",
    });
    d.insertFileChange({
      planId,
      stepId: stepIds[1],
      path: "src/off-plan.ts",
      origin: "off_plan",
    });
    d.insertFileChange({ planId, path: "stray.ts", origin: "off_plan" });
    d.setPlanStatus(planId, "done");

    expect(whyReportFor(d, "run1")).toBe(
      [
        "Plan verification - Mixed plan",
        "✓ step 1 🟢 trusted check passed - Trusted step",
        "  check: bun test trusted",
        "✓ step 2 🟡 self-written test - Agent step",
        "  check: bun test agent",
        "  ⚠ drift: src/off-plan.ts",
        "○ step 3 not verified - Pending step",
        "  check: (none)",
        "⚠ drift: stray.ts (unattributed)",
      ].join("\n"),
    );
  });

  test("uses the newest gate for a step and derives confidence when it is not stored yet", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "Retried step", status: "completed", verify: "bun test retry" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "failed",
      confidence: "red",
      factors: { ...GREEN, pass: false },
    });
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "verified",
      factors: { ...GREEN, redToGreen: false },
    });

    const report = whyReportFor(d, "run1");
    expect(report).toContain("✓ step 1 🟡 no red→green evidence - Retried step");
    expect(report).not.toContain("check did not pass");
  });

  test("an unchecked step renders ○ (not ✗) — completed without a check is not a failure", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "Scaffold project", status: "completed" },
    ]);
    // M4.3 verify-less flip: outcome 'unchecked', verified_by null, hasCheck false.
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "unchecked",
      factors: { ...GREEN, pass: false, redToGreen: false, hasCheck: false },
    });
    const report = whyReportFor(d, "run1");
    expect(report).toContain("○ step 1 🟡 no acceptance check - Scaffold project");
    expect(report).not.toContain("✗ step 1");
  });

  test("falls back to the recorded outcome when factors are unavailable", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "Broken check", status: "completed", verify: "bun test broken" },
    ]);
    const gateId = d.insertGate({ planId, stepId: stepIds[0], outcome: "unrunnable" });
    d.db.run("UPDATE gates SET factors_json = ? WHERE id = ?", ["{bad json", gateId]);
    expect(whyReportFor(d, "run1")).toContain("✗ step 1 🔴 check did not pass - Broken check");
  });

  test("renders an empty recorded plan", () => {
    const d = db();
    d.insertPlan({ sessionId: "run1", title: "Empty" });
    expect(whyReportFor(d, "run1")).toBe(
      "Plan verification - Empty\nNo plan steps recorded.",
    );
  });

  test("R8: cost block — stamped Σ, session total, unattributed", () => {
    const d = db();
    d.ensureProject("p");
    const runId = d.startRun({ projectKey: "p" });
    const { stepIds } = d.upsertPlanFromTodos(
      runId,
      [{ content: "Costed step", status: "completed", verify: "bun test costed" }],
      "Costed",
    );
    d.writeDecision(decision({ recId: "r1", runId, stepId: stepIds[0], actualCostUsd: 0.02 }));
    d.writeDecision(decision({ recId: "r2", runId, actualCostUsd: 0.03 })); // unstamped
    const report = whyReportFor(d, runId, 0.1);
    expect(report).toContain("Σ $0.0200 realized (stamped steps)");
    expect(report).toContain("session total $0.1000 · unattributed $0.0300");
  });

  test("R8: the cost block is omitted when every figure is 0", () => {
    const d = db();
    d.ensureProject("p");
    const runId = d.startRun({ projectKey: "p" });
    d.upsertPlanFromTodos(runId, [{ content: "Free step", status: "pending" }], "Free");
    const report = whyReportFor(d, runId);
    expect(report).not.toContain("session total");
    expect(report).not.toContain("Σ $");
  });
});

describe("the TUI wires /why", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("lists the command and gates ledger inspection behind plan verification", () => {
    expect(src).toContain('{ name: "why"');
    expect(src).toContain('case "why":');
    expect(src).toContain("whyReportFor(agent.db, agent.runId, sessionTotalUsd())");
    expect(src).toContain("agent.config.bigPlan !== true");
  });
});
