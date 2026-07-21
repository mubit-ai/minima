import { describe, expect, test } from "bun:test";

import type { Model } from "../src/ai/types.ts";
import {
  type PlanFinalizeDeps,
  buildPlanTranscript,
  finalizePlan,
} from "../src/minima/plan_finalize.ts";
import { type BigPlanSynthesis, PlanSessionStore } from "../src/minima/plan_session.ts";

const META: Model = {
  id: "meta-model",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 1024,
};

const synth = (over: Partial<BigPlanSynthesis> = {}): BigPlanSynthesis => ({
  title: "Ship it",
  goal: "ship",
  overview: "",
  requirements: [],
  constraints: [],
  decisions: [],
  approach: [{ action: "wire endpoint", verify: "bun test endpoint", tools: [] }],
  risks: [],
  successCriteria: [],
  openItems: [],
  ...over,
});

function deps(over: Partial<PlanFinalizeDeps> = {}) {
  const written: { path: string; content: string }[] = [];
  const base: PlanFinalizeDeps = {
    metaModel: null,
    signal: null,
    force: false,
    transcript: "",
    outPath: "/fake/BigPlan.md",
    db: null,
    runId: null,
    write: async (path, content) => {
      written.push({ path, content: String(content) });
    },
    answerQuestions: async () => [],
    ...over,
  };
  return { base, written };
}

describe("finalizePlan (shared /plan finalize + exit_plan core)", () => {
  test("null metaModel → deterministic toBigPlan(null) written, no audit, ok", async () => {
    const store = new PlanSessionStore("ship the endpoint");
    const { base, written } = deps();
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe("/fake/BigPlan.md");
    expect(written[0]!.content).toBe(store.toBigPlan(null));
    expect(out.seededCount).toBe(0);
    expect(out.auditNote).toBe("");
  });

  test("audit blocker refuses without force — nothing written, message names --force", async () => {
    const store = new PlanSessionStore("g");
    const { base, written } = deps({
      metaModel: META,
      synthesize: async () => synth({ approach: [] }), // empty plan → blocker
    });
    const out = await finalizePlan(store, base);
    expect(out.kind).toBe("blocked");
    if (out.kind !== "blocked") throw new Error("unreachable");
    expect(out.message).toContain("--force");
    expect(out.message).toContain("plan mode stays ON");
    expect(written).toHaveLength(0);
  });

  test("force overrides the blocker; findings surface as the advisory auditNote", async () => {
    const store = new PlanSessionStore("g");
    const { base, written } = deps({
      metaModel: META,
      force: true,
      synthesize: async () => synth({ approach: [] }),
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(written).toHaveLength(1);
    expect(out.auditNote).toContain("🔴");
  });

  test("write failure → write-failed with the path in the message", async () => {
    const store = new PlanSessionStore("g");
    const { base } = deps({
      write: async () => {
        throw new Error("disk full");
      },
    });
    const out = await finalizePlan(store, base);
    expect(out.kind).toBe("write-failed");
    if (out.kind !== "write-failed") throw new Error("unreachable");
    expect(out.message).toContain("/fake/BigPlan.md");
    expect(out.message).toContain("disk full");
  });

  test("ledger seeding: synth steps land via db.seedPlanFromSteps; null db seeds nothing", async () => {
    const store = new PlanSessionStore("g");
    const calls: { runId: string; title: string | null }[] = [];
    const fakeDb = {
      seedPlanFromSteps: (runId: string, title: string | null, steps: { content: string }[]) => {
        calls.push({ runId, title });
        return { planId: "p", stepIds: steps.map((_, i) => `s${i}`) };
      },
    };
    const { base } = deps({
      metaModel: META,
      db: fakeDb,
      runId: "run-1",
      synthesize: async () => synth(),
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.seededCount).toBe(1);
    expect(calls).toEqual([{ runId: "run-1", title: "Ship it" }]);

    const { base: noDb } = deps({ metaModel: META, synthesize: async () => synth() });
    const out2 = await finalizePlan(new PlanSessionStore("g"), noDb);
    if (out2.kind !== "ok") throw new Error(`expected ok, got ${out2.kind}`);
    expect(out2.seededCount).toBe(0);
  });

  test("synthesis failure is SURFACED (synthFailed), never silent — no seeding happened", async () => {
    const store = new PlanSessionStore("g");
    const { base, written } = deps({
      metaModel: META,
      synthesize: async () => null,
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.synthFailed).toBe(true);
    expect(out.seededCount).toBe(0);
    expect(written[0]!.content).toBe(store.toBigPlan(null));

    // Deterministic-by-design (no metaModel) is NOT a failure; a working synth isn't either.
    const { base: noMeta } = deps();
    const out2 = await finalizePlan(new PlanSessionStore("g"), noMeta);
    if (out2.kind !== "ok") throw new Error(`expected ok, got ${out2.kind}`);
    expect(out2.synthFailed).toBe(false);
    const { base: good } = deps({ metaModel: META, synthesize: async () => synth() });
    const out3 = await finalizePlan(new PlanSessionStore("g"), good);
    if (out3.kind !== "ok") throw new Error(`expected ok, got ${out3.kind}`);
    expect(out3.synthFailed).toBe(false);
  });

  test("an aborted signal refuses finalize BEFORE writing — plan mode stays ON", async () => {
    const store = new PlanSessionStore("g");
    const controller = new AbortController();
    controller.abort();
    const { base, written } = deps({
      metaModel: META,
      signal: controller.signal,
      synthesize: async () => synth(),
    });
    const out = await finalizePlan(store, base);
    expect(out.kind).toBe("blocked");
    if (out.kind !== "blocked") throw new Error("unreachable");
    expect(out.message).toContain("Finalize aborted");
    expect(out.message).toContain("plan mode stays ON");
    expect(written).toHaveLength(0);
  });

  test("fail-open: throwing question/synthesis helpers still write the deterministic doc", async () => {
    const store = new PlanSessionStore("g");
    const { base, written } = deps({
      metaModel: META,
      answerQuestions: async () => {
        throw new Error("flaky");
      },
      synthesize: async () => {
        throw new Error("flaky");
      },
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(written[0]!.content).toBe(store.toBigPlan(null));
  });
});

describe("plan-premium finalize (two-tier models)", () => {
  const PLAN: Model = { ...META, id: "plan-model", name: "Plan" };

  test("planModel feeds question-resolution + synthesis; the critic stays on metaModel", async () => {
    const store = new PlanSessionStore("g");
    const seen: Record<string, string> = {};
    const booked: number[] = [];
    const { base } = deps({
      metaModel: META,
      planModel: PLAN,
      onMetaCostUsd: (usd) => booked.push(usd),
      answerQuestions: async (_s, o) => {
        seen.answer = o.metaModel.id;
        o.onCostUsd?.(0.01);
        return [];
      },
      synthesize: async (_s, _t, o) => {
        seen.synth = o.metaModel.id;
        o.onCostUsd?.(0.02);
        return synth();
      },
      critic: async (o) => {
        seen.critic = o.metaModel.id;
        return [];
      },
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(seen).toEqual({ answer: "plan-model", synth: "plan-model", critic: "meta-model" });
    expect(booked).toEqual([0.01, 0.02]);
  });

  test("absent planModel → all three calls on metaModel (legacy behavior)", async () => {
    const store = new PlanSessionStore("g");
    const seen: string[] = [];
    const { base } = deps({
      metaModel: META,
      answerQuestions: async (_s, o) => {
        seen.push(o.metaModel.id);
        return [];
      },
      synthesize: async (_s, _t, o) => {
        seen.push(o.metaModel.id);
        return synth();
      },
      critic: async (o) => {
        seen.push(o.metaModel.id);
        return [];
      },
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(seen).toEqual(["meta-model", "meta-model", "meta-model"]);
  });

  test("planModel without metaModel: synthesis runs on planModel, critic is skipped", async () => {
    const store = new PlanSessionStore("g");
    const seen: string[] = [];
    const { base } = deps({
      metaModel: null,
      planModel: PLAN,
      synthesize: async (_s, _t, o) => {
        seen.push(o.metaModel.id);
        return synth();
      },
      critic: async () => {
        throw new Error("critic must not run without a metaModel");
      },
    });
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(seen).toEqual(["plan-model"]);
    expect(out.criticFlags).toBeNull();
    expect(out.synthFailed).toBe(false);
  });
});

describe("buildPlanTranscript", () => {
  test("keeps user/assistant turns only, labels them User/Planner, drops empties", () => {
    const messages = [
      { role: "user", textContent: "build the thing" },
      { role: "assistant", textContent: "here is the plan" },
      { role: "toolResult", textContent: "noise" },
      { role: "assistant", textContent: "   " },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural stand-ins for Message
    const transcript = buildPlanTranscript(messages as any);
    expect(transcript).toBe("User: build the thing\n\nPlanner: here is the plan");
  });
});
