import { describe, expect, test } from "bun:test";

import type { Model } from "../src/ai/types.ts";
import {
  type PlanFinalizeDeps,
  buildPlanTranscript,
  finalizePlan,
} from "../src/minima/plan_finalize.ts";
import { type GroundTruthSynthesis, PlanSessionStore } from "../src/minima/plan_session.ts";

const META: Model = {
  id: "meta-model",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 1024,
};

const synth = (over: Partial<GroundTruthSynthesis> = {}): GroundTruthSynthesis => ({
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
    outPath: "/fake/GROUND_TRUTH.md",
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
  test("null metaModel → deterministic toGroundTruth(null) written, no audit, ok", async () => {
    const store = new PlanSessionStore("ship the endpoint");
    const { base, written } = deps();
    const out = await finalizePlan(store, base);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe("/fake/GROUND_TRUTH.md");
    expect(written[0]!.content).toBe(store.toGroundTruth(null));
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
    expect(out.message).toContain("/fake/GROUND_TRUTH.md");
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
    expect(written[0]!.content).toBe(store.toGroundTruth(null));
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
