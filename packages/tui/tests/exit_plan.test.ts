import { describe, expect, test } from "bun:test";

import type { ToolResult } from "../src/agent/tools.ts";
import { type ExitPlanDeps, exitPlanTool } from "../src/tools/exit_plan.ts";
import type { QuestionParams } from "../src/tools/question.ts";

function resultText(r: ToolResult): string {
  return r.content
    .map((b) => ("text" in b ? String(b.text) : ""))
    .join("")
    .trim();
}

/** Scripted overlay: answers[i] resolves the i-th ask; records every question shown. */
function harness(answers: (string | null)[], over: Partial<ExitPlanDeps> = {}) {
  const asked: QuestionParams[] = [];
  const finalized: boolean[] = [];
  let canceled = 0;
  const deps: ExitPlanDeps = {
    ask: {
      current: async (params) => {
        asked.push(params);
        return answers[asked.length - 1] ?? null;
      },
    },
    finalize: async () => {
      finalized.push(true);
      return { ok: true, message: "finalized — build mode on" };
    },
    cancel: () => {
      canceled += 1;
    },
    isActive: () => true,
    ...over,
  };
  return { tool: exitPlanTool(deps), asked, finalized, canceled: () => canceled };
}

describe("exit_plan tool (model-callable plan-mode exit)", () => {
  test("finalize choice → deps.finalize once, its message returned, no terminate", async () => {
    const h = harness(["Finalize & build"]);
    const r = await h.tool.execute("t1", { summary: "ship the endpoint" }, null, null);
    expect(h.finalized).toHaveLength(1);
    expect(h.canceled()).toBe(0);
    expect(resultText(r)).toBe("finalized — build mode on");
    expect(r.terminate).toBeUndefined();
    expect(r.details?.choice).toBe("finalize");
    // The summary reaches the approval prompt.
    expect(h.asked[0]!.question).toContain("ship the endpoint");
    expect(h.asked[0]!.options.map((o) => o.label)).toEqual([
      "Finalize & build",
      "Revise the plan",
      "Cancel plan mode",
    ]);
    expect(h.asked[0]!.allow_freetext).toBe(false);
  });

  test("finalize refused (audit blocker) → refusal message back, plan mode stays", async () => {
    const h = harness(["Finalize & build"], {
      finalize: async () => ({ ok: false, message: "blocked: fix it or --force" }),
    });
    const r = await h.tool.execute("t1", {}, null, null);
    expect(resultText(r)).toBe("blocked: fix it or --force");
    expect(r.details?.ok).toBe(false);
    expect(r.terminate).toBeUndefined();
  });

  test("revise → second free-text ask; note embedded with stay-in-plan instruction", async () => {
    const h = harness(["Revise the plan", "tighten step 2"]);
    const r = await h.tool.execute("t1", {}, null, null);
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]!.allow_freetext).toBe(true);
    expect(resultText(r)).toContain("tighten step 2");
    expect(resultText(r)).toContain("Stay in plan mode");
    expect(resultText(r)).toContain("call exit_plan again");
    expect(h.finalized).toHaveLength(0);
    expect(h.canceled()).toBe(0);
  });

  test("revise dismissed without a note → keep-planning text, nothing invoked", async () => {
    const h = harness(["Revise the plan", null]);
    const r = await h.tool.execute("t1", {}, null, null);
    expect(resultText(r)).toContain("keep planning");
    expect(h.finalized).toHaveLength(0);
  });

  test("cancel → deps.cancel, NOT-approved text, terminate=true", async () => {
    const h = harness(["Cancel plan mode"]);
    const r = await h.tool.execute("t1", {}, null, null);
    expect(h.canceled()).toBe(1);
    expect(h.finalized).toHaveLength(0);
    expect(resultText(r)).toContain("NOT approved");
    expect(resultText(r)).toContain("Do not implement");
    expect(r.terminate).toBe(true);
  });

  test("Q1 dismissed (Esc) → stay-in-plan text, no deps called", async () => {
    const h = harness([null]);
    const r = await h.tool.execute("t1", {}, null, null);
    expect(resultText(r)).toContain("Stay in plan mode");
    expect(h.finalized).toHaveLength(0);
    expect(h.canceled()).toBe(0);
    expect(r.terminate).toBeUndefined();
  });

  test("headless (null ask) → continue-planning text, never throws", async () => {
    const h = harness([], { ask: { current: null } });
    const r = await h.tool.execute("t1", {}, null, null);
    expect(resultText(r)).toContain("Continue planning");
    expect(h.asked).toHaveLength(0);
  });

  test("inactive session → 'not active' without asking (double-call guard)", async () => {
    const h = harness(["Finalize & build"], { isActive: () => false });
    const r = await h.tool.execute("t1", {}, null, null);
    expect(resultText(r)).toContain("not active");
    expect(h.asked).toHaveLength(0);
    expect(h.finalized).toHaveLength(0);
  });

  test("pre-aborted signal → error result, no overlay", async () => {
    const h = harness(["Finalize & build"]);
    const controller = new AbortController();
    controller.abort();
    const r = await h.tool.execute("t1", {}, controller.signal, null);
    expect(r.details?.error).toBeDefined();
    expect(h.asked).toHaveLength(0);
  });

  test("parameters validate: absent/garbled input still yields a summary string", () => {
    expect(h0().tool.parameters.validate(undefined).ok).toBe(true);
    expect(h0().tool.parameters.validate({ summary: 42 }).ok).toBe(true);
    expect(h0().tool.parameters.validate([]).ok).toBe(false);
    function h0() {
      return harness([]);
    }
  });
});
