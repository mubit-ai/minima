import { describe, expect, test } from "bun:test";
import type { PlanStepRow } from "../src/db/minima_db.ts";
import {
  type LintStep,
  formatFindings,
  hasBlockers,
  lintPlan,
  stepsFromRows,
} from "../src/minima/plan_lint.ts";

// A6 — static plan lint / poka-yoke audit. Encodes docs/characteristics_of_a_good_plan.md.

const step = (over: Partial<LintStep> = {}): LintStep => ({
  content: "Wire the router to the recommend endpoint",
  verify: "bun test tests/router.test.ts",
  tools: ["edit", "bash"],
  ...over,
});

/** Extract the rules present at a given severity. */
const rules = (steps: LintStep[], sev?: string): string[] =>
  lintPlan(steps)
    .filter((f) => !sev || f.severity === sev)
    .map((f) => f.rule);

describe("lintPlan", () => {
  test("a well-formed plan is clean", () => {
    expect(lintPlan([step()])).toEqual([]);
  });

  test("empty plan is a blocker", () => {
    const findings = lintPlan([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("empty-plan");
    expect(findings[0]!.severity).toBe("blocker");
  });

  test("a step with no verify warns (decompose)", () => {
    expect(rules([step({ verify: "" })], "warn")).toContain("no-verify");
    expect(hasBlockers(lintPlan([step({ verify: "" })]))).toBe(false);
  });

  test("an always-passing verify is a blocker (fabricated check)", () => {
    for (const v of ["true", ":", "exit 0", "echo done", "echo building && exit 0", "printf ok"]) {
      const findings = lintPlan([step({ verify: v })]);
      expect(findings.some((f) => f.rule === "non-gating-verify" && f.severity === "blocker")).toBe(
        true,
      );
    }
  });

  test("a real check chained after a noop is NOT flagged as non-gating", () => {
    const findings = lintPlan([step({ verify: "echo building && bun test tests/x.test.ts" })]);
    expect(findings.some((f) => f.rule === "non-gating-verify")).toBe(false);
  });

  test("a duplicated verify across steps warns", () => {
    const findings = lintPlan([
      step({ content: "Step one here", verify: "make test" }),
      step({ content: "Step two here", verify: "make test" }),
    ]);
    expect(findings.filter((f) => f.rule === "duplicate-verify")).toHaveLength(2);
  });

  test("a vague action warns", () => {
    expect(rules([step({ content: "Refactor" })], "warn")).toContain("vague-action");
    expect(rules([step({ content: "cleanup the code" })], "warn")).toContain("vague-action");
    // A concrete multi-word action does not.
    expect(rules([step({ content: "Add a red→green test for the parser" })])).not.toContain(
      "vague-action",
    );
  });

  test("an unknown tool name in the allowlist is a blocker (typo would wedge runtime)", () => {
    const findings = lintPlan([step({ tools: ["edit", "notatool"] })]);
    const f = findings.find((x) => x.rule === "unknown-tool");
    expect(f?.severity).toBe("blocker");
    expect(f?.message).toContain("notatool");
  });

  test("a checkable writing step with no allowlist is an info nudge (not a block)", () => {
    const findings = lintPlan([step({ tools: [] })]);
    expect(findings.some((f) => f.rule === "no-allowlist" && f.severity === "info")).toBe(true);
    expect(hasBlockers(findings)).toBe(false);
  });

  test("findings are ordered most-severe-first", () => {
    const findings = lintPlan([
      step({ content: "Do", verify: "true", tools: [] }), // vague + non-gating + (verify noop so no no-allowlist)
    ]);
    // blocker (non-gating) precedes the warn (vague).
    expect(findings[0]!.severity).toBe("blocker");
    expect(hasBlockers(findings)).toBe(true);
  });
});

describe("stepsFromRows", () => {
  test("parses the persisted tools JSON column", () => {
    const rows = [
      {
        content: "Edit router",
        verify: "bun test x",
        tools: '["edit","bash"]',
      } as unknown as PlanStepRow,
      { content: "Scaffold", verify: null, tools: null } as unknown as PlanStepRow,
    ];
    const steps = stepsFromRows(rows);
    expect(steps[0]!.tools).toEqual(["edit", "bash"]);
    expect(steps[1]!.tools).toEqual([]);
    expect(steps[1]!.verify).toBe("");
  });
});

describe("formatFindings", () => {
  test("clean plan renders the clean line", () => {
    expect(formatFindings([])).toContain("no issues");
  });
  test("counts by severity", () => {
    const out = formatFindings(lintPlan([step({ verify: "true", tools: ["x"] })]));
    expect(out).toContain("blocker");
  });
});
