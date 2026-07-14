import { describe, expect, test } from "bun:test";
import type { PlanStepRow } from "../src/db/minima_db.ts";
import {
  type LintStep,
  formatFindings,
  hasBlockers,
  lintPlan,
  stepsFromRows,
  synthAuditFindings,
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
    for (const v of [
      "true",
      ":",
      "exit 0",
      "echo done",
      "echo building && exit 0",
      "printf ok",
      // A trailing comment must not disguise a noop past the blocker.
      "true # placeholder",
      "exit 0 # done",
      ": # noop",
      "echo x; echo y",
    ]) {
      const findings = lintPlan([step({ verify: v })]);
      expect(findings.some((f) => f.rule === "non-gating-verify" && f.severity === "blocker")).toBe(
        true,
      );
    }
  });

  test("a real check with a trailing comment is NOT flagged as non-gating", () => {
    const findings = lintPlan([step({ verify: "bun test tests/x.test.ts # smoke" })]);
    expect(findings.some((f) => f.rule === "non-gating-verify")).toBe(false);
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
    // A one- or two-word action can't name a check (doc rule #5 lower bound).
    expect(rules([step({ content: "Add tests" })], "warn")).toContain("vague-action");
    // A concrete multi-word action does not.
    expect(rules([step({ content: "Add a red→green test for the parser" })])).not.toContain(
      "vague-action",
    );
    // A short vague-verb step that NAMES a concrete object (a file/identifier) is checkable, so it
    // is exempt — the rule targets "a vague verb with no object", not any short soft-verb phrase.
    expect(rules([step({ content: "fix null deref auth.ts" })])).not.toContain("vague-action");
    expect(rules([step({ content: "update src/config.ts default port" })])).not.toContain(
      "vague-action",
    );
    // Upper bound: a vague verb only fires at <= 4 words; a longer phrase is not flagged.
    expect(rules([step({ content: "refactor the entire authentication subsystem now" })])).not.toContain(
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
    // The no-allowlist info nudge is suppressed on a non-gating step (already blocked for a fake
    // check — piling a redundant info on top would be noise).
    expect(findings.some((f) => f.rule === "no-allowlist")).toBe(false);
  });
});

describe("synthAuditFindings (the /plan finalize gate)", () => {
  test("a null approach (synthesis produced nothing) yields no findings", () => {
    expect(synthAuditFindings(null)).toEqual([]);
    expect(synthAuditFindings(undefined)).toEqual([]);
  });

  test("an empty approach is an empty-plan blocker (a step-less plan must refuse finalize)", () => {
    const findings = synthAuditFindings([]);
    expect(findings.some((f) => f.rule === "empty-plan" && f.severity === "blocker")).toBe(true);
    expect(hasBlockers(findings)).toBe(true);
  });

  test("a fabricated verify in the approach blocks", () => {
    const findings = synthAuditFindings([{ action: "Do the thing", verify: "true", tools: [] }]);
    expect(hasBlockers(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "non-gating-verify")).toBe(true);
  });

  test("a typo'd council tool name reaches the unknown-tool blocker", () => {
    const findings = synthAuditFindings([
      { action: "Edit the router", verify: "bun test tests/router.test.ts", tools: ["edt", "bash"] },
    ]);
    expect(findings.some((f) => f.rule === "unknown-tool" && f.severity === "blocker")).toBe(true);
    expect(hasBlockers(findings)).toBe(true);
  });

  test("a well-formed approach passes the gate cleanly", () => {
    const findings = synthAuditFindings([
      { action: "Wire the router to the recommend endpoint", verify: "bun test x", tools: ["edit"] },
    ]);
    expect(hasBlockers(findings)).toBe(false);
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
