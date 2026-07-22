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
  const finalized: { planMd: string | null; autoAcceptEdits: boolean }[] = [];
  const shown: string[] = [];
  let canceled = 0;
  const deps: ExitPlanDeps = {
    ask: {
      current: async (params) => {
        asked.push(params);
        return answers[asked.length - 1] ?? null;
      },
    },
    finalize: async (planMd, autoAcceptEdits) => {
      finalized.push({ planMd, autoAcceptEdits });
      return { ok: true, message: "finalized — build mode on" };
    },
    cancel: () => {
      canceled += 1;
    },
    isActive: () => true,
    requiresPlan: () => false,
    showPlan: (md) => {
      shown.push(md);
    },
    ...over,
  };
  return { tool: exitPlanTool(deps), asked, finalized, shown, canceled: () => canceled };
}

describe("exit_plan tool (model-callable plan-mode exit)", () => {
  test("finalize choice → deps.finalize once, its message returned, no terminate", async () => {
    const h = harness(["Finalize & build"]);
    const r = await h.tool.execute("t1", { summary: "ship the endpoint" }, null, null);
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]!.autoAcceptEdits).toBe(false);
    expect(h.canceled()).toBe(0);
    expect(resultText(r)).toBe("finalized — build mode on");
    expect(r.terminate).toBeUndefined();
    expect(r.details?.choice).toBe("finalize");
    expect(r.details?.autoAcceptEdits).toBe(false);
    // The summary reaches the approval prompt; CC's ExitPlanMode option order —
    // auto-accept first, plain build second.
    expect(h.asked[0]!.question).toContain("ship the endpoint");
    expect(h.asked[0]!.options.map((o) => o.label)).toEqual([
      "Finalize & auto-accept edits",
      "Finalize & build",
      "Revise the plan",
      "Cancel plan mode",
    ]);
    expect(h.asked[0]!.allow_freetext).toBe(false);
  });

  test("auto-accept flavor → same finalize with autoAcceptEdits=true (lands accept-edits)", async () => {
    const h = harness(["Finalize & auto-accept edits"]);
    const r = await h.tool.execute("t1", {}, null, null);
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]!.autoAcceptEdits).toBe(true);
    expect(r.details?.choice).toBe("finalize");
    expect(r.details?.autoAcceptEdits).toBe(true);
    expect(r.terminate).toBeUndefined();
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

describe("MUB-179 — auto-accept landing wiring (source pin)", () => {
  test("both exitPlanFinalize paths (sessionless + store) apply the landing", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");
    const hits = src.match(/finalizeAutoAcceptLanding\(permStateRef\.current\)/g) ?? [];
    expect(hits).toHaveLength(2);
  });
});

describe("MP17 — universal exit gate (Big Plan-off plan argument)", () => {
  test("Big Plan-off: a missing plan argument is an error asking for the markdown, no overlay", async () => {
    const h = harness(["Finalize & build"], { requiresPlan: () => true });
    const r = await h.tool.execute("t1", { summary: "s" }, null, null);
    expect(r.details?.error).toBe(true);
    expect(resultText(r)).toContain("plan");
    expect(h.asked).toHaveLength(0);
    expect(h.finalized).toHaveLength(0);
  });

  test("Big Plan-off: the plan markdown is SHOWN before the ask and reaches finalize", async () => {
    const h = harness(["Finalize & build"], { requiresPlan: () => true });
    const md = "## The plan\n\n1. do the thing\n2. verify it";
    const r = await h.tool.execute("t1", { plan: md }, null, null);
    expect(h.shown).toEqual([md]);
    expect(h.asked).toHaveLength(1);
    expect(h.finalized).toEqual([{ planMd: md, autoAcceptEdits: false }]);
    expect(r.details?.choice).toBe("finalize");
  });

  test("Big Plan-on: the plan argument is ignored — finalize receives null (store path)", async () => {
    const h = harness(["Finalize & build"], { requiresPlan: () => false });
    await h.tool.execute("t1", { plan: "## ignored" }, null, null);
    expect(h.finalized).toEqual([{ planMd: null, autoAcceptEdits: false }]);
    expect(h.shown).toHaveLength(0);
  });

  test("Big Plan-off cancel still terminates with the not-approved text", async () => {
    const h = harness(["Cancel plan mode"], { requiresPlan: () => true });
    const r = await h.tool.execute("t1", { plan: "## p" }, null, null);
    expect(h.canceled()).toBe(1);
    expect(r.terminate).toBe(true);
  });
});
