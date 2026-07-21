import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AfterToolCallContext, BeforeToolCallContext } from "../src/agent/tools.ts";
import type { GateRow } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  VERIFY_CONSENT_BLOCK,
  bigPlanAfterToolCall,
  bigPlanHooks,
  headlessVerifyConsent,
} from "../src/minima/big_plan.ts";

// MP18 — verify-command consent at EXECUTION time. The TUI's todowrite permission overlay
// already gathers exact-string consent (approvedVerifies); these tests pin the enforcement
// layer underneath: BOTH runCheck sites (baseline capture in the after-hook, the done-gate
// in the before-hook) honor an injected VerifyConsent predicate keyed on the command that
// would ACTUALLY execute — so a post-approval mutation can never smuggle a new command
// through, and headless runs fail closed unless explicitly opted in.

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

function bctx(todos: unknown[], id = "tc"): BeforeToolCallContext {
  const args = { tasks: JSON.stringify(todos) };
  return {
    toolCall: { type: "toolCall", id, name: "todowrite", arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

function actx(todos: unknown[], id = "tc"): AfterToolCallContext {
  return {
    toolCall: {
      type: "toolCall",
      id,
      name: "todowrite",
      arguments: { tasks: JSON.stringify(todos) },
    },
    isError: false,
  } as unknown as AfterToolCallContext;
}

function stepGates(d: MinimaDb): GateRow[] {
  return d.db
    .query("SELECT * FROM gates WHERE kind = 'step_check' ORDER BY created_at, rowid")
    .all() as GateRow[];
}

describe("baseline capture consent (after-hook)", () => {
  test("an unconsented verify NEVER executes at baseline; baseline stays NULL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-base-"));
    try {
      const d = db();
      const leak = join(dir, "consent-leak");
      const sink = bigPlanAfterToolCall(
        { db: d, runId: "run1" },
        { verifyConsent: () => false },
      );
      await sink(actx([{ content: "S", status: "in_progress", verify: `touch ${leak}` }]));
      expect(existsSync(leak)).toBe(false);
      const step = d.db.query("SELECT baseline FROM plan_steps").get() as {
        baseline: string | null;
      };
      expect(step.baseline).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a consented verify still captures the baseline", async () => {
    const d = db();
    const sink = bigPlanAfterToolCall({ db: d, runId: "run1" }, { verifyConsent: () => true });
    await sink(actx([{ content: "S", status: "in_progress", verify: "true" }]));
    const step = d.db.query("SELECT baseline FROM plan_steps").get() as {
      baseline: string | null;
    };
    expect(step.baseline).toBe("green");
  });
});

describe("done-gate consent (before-hook)", () => {
  test("an unconsented verify fails CLOSED: block + unrunnable gate row, no execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-gate-"));
    try {
      const d = db();
      const leak = join(dir, "gate-leak");
      const hooks = bigPlanHooks({ db: d, runId: "run1" }, { verifyConsent: () => false });
      const behavior = await hooks.before(
        bctx([{ content: "S", status: "completed", verify: `touch ${leak}` }]),
      );
      expect(behavior?.block).toBe(true);
      expect(behavior?.reason).toContain(VERIFY_CONSENT_BLOCK);
      expect(existsSync(leak)).toBe(false);
      const rows = stepGates(d);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("unrunnable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("consent keys on the EXECUTION-TIME verify — a mutation cannot dodge", async () => {
    const d = db();
    const consented = new Set(["true"]);
    const hooks = bigPlanHooks(
      { db: d, runId: "run1" },
      { verifyConsent: (cmd) => consented.has(cmd) },
    );
    await hooks.after(actx([{ content: "S", status: "in_progress", verify: "true" }], "t1"));
    // The agent swaps the verify at completion time; only the OLD string was consented.
    const swapped = await hooks.before(
      bctx([{ content: "S", status: "completed", verify: "exit 0" }], "t2"),
    );
    expect(swapped?.block).toBe(true);
    expect(swapped?.reason).toContain(VERIFY_CONSENT_BLOCK);
    // Consenting the NEW string lets it run — with the baseline honestly voided by the swap.
    consented.add("exit 0");
    const allowed = await hooks.before(
      bctx([{ content: "S", status: "completed", verify: "exit 0" }], "t3"),
    );
    expect(allowed).toBeNull();
    await hooks.after(actx([{ content: "S", status: "completed", verify: "exit 0" }], "t3"));
    const verified = stepGates(d).filter((g) => g.outcome === "verified");
    expect(verified).toHaveLength(1);
    const factors = JSON.parse(verified[0]!.factors_json ?? "{}");
    expect(factors.redToGreen).toBe(false);
  });

  test("undefined consent = pre-MP18 behavior (library default: allow)", async () => {
    const d = db();
    const hooks = bigPlanHooks({ db: d, runId: "run1" });
    const behavior = await hooks.before(
      bctx([{ content: "S", status: "completed", verify: "true" }]),
    );
    expect(behavior).toBeNull();
  });
});

describe("headlessVerifyConsent", () => {
  test("deny-all unless MINIMA_TUI_ALLOW_VERIFY=1 (env-injected)", () => {
    expect(headlessVerifyConsent({} as NodeJS.ProcessEnv)("true")).toBe(false);
    expect(
      headlessVerifyConsent({ MINIMA_TUI_ALLOW_VERIFY: "1" } as unknown as NodeJS.ProcessEnv)(
        "true",
      ),
    ).toBe(true);
  });
});
