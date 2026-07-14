import { describe, expect, test } from "bun:test";
import type { BeforeToolCallContext } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { groundTruthHooks } from "../src/minima/ground_truth.ts";
import {
  ALWAYS_ALLOWED,
  GATED_TOOLS,
  KNOWN_TOOLS,
  parseStepTools,
  stepAllowlistDecision,
} from "../src/minima/tool_permissions.ts";

// A6 — per-step tool allowlist (task permissions). Pure decisions + the dispatcher enforcement
// folded into groundTruthHooks.before for non-todowrite calls.

describe("parseStepTools", () => {
  test("null / empty / '[]' are unrestricted (null)", () => {
    expect(parseStepTools(null)).toBeNull();
    expect(parseStepTools(undefined)).toBeNull();
    expect(parseStepTools("")).toBeNull();
    expect(parseStepTools("[]")).toBeNull();
    expect(parseStepTools("not json")).toBeNull();
    expect(parseStepTools('{"a":1}')).toBeNull(); // not an array
  });

  test("normalizes to trimmed lowercase names", () => {
    expect(parseStepTools('["Edit", " BASH ", "read"]')).toEqual(["edit", "bash", "read"]);
    expect(parseStepTools('["edit", 3, "", "bash"]')).toEqual(["edit", "bash"]);
  });
});

describe("stepAllowlistDecision", () => {
  test("unrestricted allowlist allows anything", () => {
    expect(stepAllowlistDecision("bash", null).block).toBe(false);
    expect(stepAllowlistDecision("bash", []).block).toBe(false);
  });

  test("a listed tool is allowed (case-insensitive)", () => {
    expect(stepAllowlistDecision("edit", ["edit", "bash"]).block).toBe(false);
    expect(stepAllowlistDecision("EDIT", ["edit"]).block).toBe(false);
  });

  test("always-allowed tools are never blocked even off-list", () => {
    for (const t of ["todowrite", "question", "read", "ls", "glob", "grep"]) {
      expect(stepAllowlistDecision(t, ["edit"]).block).toBe(false);
    }
  });

  test("a mutating tool off the list is blocked with a helpful reason", () => {
    const d = stepAllowlistDecision("write", ["edit", "bash"], "Write the docs");
    expect(d.block).toBe(true);
    expect(d.reason).toContain("write");
    expect(d.reason).toContain("edit, bash");
    expect(d.reason).toContain("Write the docs");
  });

  test("ALWAYS_ALLOWED and GATED_TOOLS partition KNOWN_TOOLS", () => {
    for (const t of ALWAYS_ALLOWED) expect(KNOWN_TOOLS.has(t)).toBe(true);
    for (const t of GATED_TOOLS) expect(ALWAYS_ALLOWED.has(t)).toBe(false);
    expect(ALWAYS_ALLOWED.size + GATED_TOOLS.size).toBe(KNOWN_TOOLS.size);
    // The mutating/expensive tools must be gated, not always-allowed.
    for (const t of ["write", "edit", "apply_patch", "bash", "task"]) {
      expect(GATED_TOOLS.has(t)).toBe(true);
    }
  });
});

// --- dispatcher enforcement through groundTruthHooks.before ---------------------------------

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

/** A before-hook context for an arbitrary (non-todowrite) tool call. */
function toolCtx(name: string): BeforeToolCallContext {
  const args = {};
  return {
    toolCall: { type: "toolCall", id: "t1", name, arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

/** Seed an active plan with one in-progress step carrying `tools`. */
function seedInProgress(d: MinimaDb, tools: string[] | null): void {
  const { stepIds } = d.seedPlanFromSteps("run1", "T", [
    { content: "Edit the router", verify: "bun test x", tools },
  ]);
  d.setStepStatus(stepIds[0]!, "in_progress");
}

describe("groundTruthHooks allowlist enforcement", () => {
  test("blocks a mutating tool not on the in-progress step's allowlist", async () => {
    const d = db();
    seedInProgress(d, ["edit"]);
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    const decision = await before(toolCtx("write"));
    expect(decision).not.toBeNull();
    expect(decision!.block).toBe(true);
    expect(decision!.reason).toContain("write");
  });

  test("allows a listed tool and always-allowed read tools", async () => {
    const d = db();
    seedInProgress(d, ["edit"]);
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    expect(await before(toolCtx("edit"))).toBeNull();
    expect(await before(toolCtx("read"))).toBeNull();
    expect(await before(toolCtx("grep"))).toBeNull();
  });

  test("an unrestricted step (no tools) allows anything", async () => {
    const d = db();
    seedInProgress(d, null);
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    expect(await before(toolCtx("bash"))).toBeNull();
  });

  test("no active plan / no in-progress step is allow (fail-open)", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    expect(await before(toolCtx("bash"))).toBeNull(); // no plan at all
  });

  test("enforcement OFF: the allowlist is advisory only", async () => {
    const d = db();
    seedInProgress(d, ["edit"]);
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: false });
    expect(await before(toolCtx("write"))).toBeNull();
  });

  test("an active plan with no in-progress step (all pending) is allow (fail-open)", async () => {
    const d = db();
    // A restrictive allowlist that is NOT in progress must not bite — this exercises the
    // getInProgressStep status filter (a broken filter would read the pending step's ["edit"] list
    // and wrongly block write). The allowlist must be restrictive or the test passes trivially.
    d.seedPlanFromSteps("run1", "T", [{ content: "Edit the router", verify: "bun test x", tools: ["edit"] }]);
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    expect(await before(toolCtx("write"))).toBeNull();
  });

  test("enforces the in-progress step's allowlist as the plan advances (idx > 0)", async () => {
    const d = db();
    const { stepIds } = d.seedPlanFromSteps("run1", "T", [
      { content: "First step edits", verify: "bun test a", tools: ["edit"] },
      { content: "Second step runs", verify: "bun test b", tools: ["bash"] },
    ]);
    d.setStepStatus(stepIds[0]!, "completed");
    d.setStepStatus(stepIds[1]!, "in_progress");
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { enforceAllowlist: true });
    // The allowlist read must follow the plan to step 1 (["bash"]), not linger on the completed
    // step 0 (["edit"]): write is on neither list, bash is on step 1's.
    const blocked = await before(toolCtx("write"));
    expect(blocked?.block).toBe(true);
    expect(await before(toolCtx("bash"))).toBeNull();
    // And a tool that only step 0 allowed is now blocked (proves we are not reading step 0's list).
    expect((await before(toolCtx("edit")))?.block).toBe(true);
  });
});
