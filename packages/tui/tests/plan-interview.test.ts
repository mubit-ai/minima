import { describe, expect, test } from "bun:test";
import type { Model } from "../src/ai/types.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { applyUserVerifies, finalizePlan } from "../src/minima/plan_finalize.ts";
import {
  INTERVIEW_MAX_QUESTIONS,
  type PlanInterviewDeps,
  draftHasVerifies,
  newInterviewState,
  parseBudgetAnswer,
  runPlanInterview,
} from "../src/minima/plan_interview.ts";
import {
  type BigPlanSynthesis,
  type CouncilRoundResult,
  PlanSessionStore,
} from "../src/minima/plan_session.ts";
import { type PlanTurnDeps, runPlanTurn } from "../src/minima/plan_turn.ts";
import type { RepoGate } from "../src/minima/repo_gates.ts";
import type { AskUser, QuestionParams } from "../src/tools/question.ts";

const PROJECT = "github.com/test/interview-repo";

function freshDb(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject(PROJECT);
  const runId = db.startRun({ projectKey: PROJECT });
  return { db, runId };
}

function scriptedAsk(answers: (string | null)[]): { ask: AskUser; calls: QuestionParams[] } {
  const calls: QuestionParams[] = [];
  const ask: AskUser = async (q) => {
    calls.push(q);
    return answers[calls.length - 1] ?? null;
  };
  return { ask, calls };
}

const MINED: RepoGate[] = [
  { command: "make test", kind: "test", source: "Makefile" },
  { command: "bun run check", kind: "typecheck", source: "package.json" },
];

function makeInterviewDeps(over: Partial<PlanInterviewDeps> = {}): {
  deps: PlanInterviewDeps;
  store: PlanSessionStore;
  db: MinimaDb;
  calls: QuestionParams[];
  notes: string[];
} {
  const { db } = freshDb();
  const store = new PlanSessionStore("build the widget");
  const { ask, calls } = scriptedAsk([]);
  const notes: string[] = [];
  const deps: PlanInterviewDeps = {
    enabled: true,
    askUser: ask,
    store,
    db,
    projectKey: PROJECT,
    repoDir: "/fake",
    mineGates: () => MINED,
    onNote: (t) => notes.push(t),
    ...over,
  };
  return {
    deps,
    store: (over.store as PlanSessionStore) ?? store,
    db: (over.db as MinimaDb) ?? db,
    calls,
    notes,
  };
}

describe("plan interview — inertness + skip-gates", () => {
  test("flag off ⇒ completely inert: no questions, no writes, no state change", async () => {
    const { deps, db, calls, store } = makeInterviewDeps({ enabled: false });
    const state = newInterviewState();
    await runPlanInterview(state, deps);
    expect(calls).toHaveLength(0);
    expect(state.asked).toBe(0);
    expect(store.session.userVerifies).toEqual([]);
    expect(db.getRoutingProfile(PROJECT)).toBeNull();
    expect(db.listMemories(PROJECT)).toHaveLength(0);
    expect(db.listProfileEvents(PROJECT)).toHaveLength(0);
  });

  test("verification question skips when the draft already carries authored verifies", async () => {
    const { deps, calls, store } = makeInterviewDeps();
    store.applyCouncilResult({
      draft: "1. wire it\n   - verify: `bun test wire`",
      decisions: [],
      findings: [],
      faults: [],
      questions: [],
      facts: [],
      constraints: [],
      costUsd: 0,
      aborted: false,
    });
    await runPlanInterview(newInterviewState(), deps);
    // Only the budget question fires.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toContain("Cost/quality");
    expect(store.session.userVerifies).toEqual([]);
  });

  test("verification question skips once the interview already recorded verifies", async () => {
    const { deps, calls, store } = makeInterviewDeps();
    store.addUserVerify("make test");
    await runPlanInterview(newInterviewState(), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toContain("Cost/quality");
  });

  test("budget question skips when a routing_profiles row exists (any source)", async () => {
    const { deps, db, calls } = makeInterviewDeps();
    db.upsertRoutingProfile(PROJECT, { slider: 7.5 }, "user");
    await runPlanInterview(newInterviewState(), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.question).toContain("verify");
  });

  test("hard cap: never more than 3 interview questions per plan session", async () => {
    const { db } = freshDb();
    const { ask, calls } = scriptedAsk([null, null, null, null, null, null]);
    const state = newInterviewState();
    const base = { enabled: true, askUser: ask, db, projectKey: PROJECT, repoDir: null };
    // Each pass uses a fresh empty store (both gates open) — the SESSION cap still holds.
    await runPlanInterview(state, { ...base, store: new PlanSessionStore("g1") });
    expect(state.asked).toBe(2);
    await runPlanInterview(state, { ...base, store: new PlanSessionStore("g2") });
    expect(state.asked).toBe(INTERVIEW_MAX_QUESTIONS);
    expect(calls).toHaveLength(3);
    await runPlanInterview(state, { ...base, store: new PlanSessionStore("g3") });
    expect(state.asked).toBe(INTERVIEW_MAX_QUESTIONS);
    expect(calls).toHaveLength(3);
  });
});

describe("plan interview — answers land in the right stores", () => {
  test("mined options are presented; 'use all' records every command in the store", async () => {
    const { deps, store, db } = makeInterviewDeps();
    db.upsertRoutingProfile(PROJECT, { slider: 5 }, "user"); // silence the budget question
    const { ask, calls: vCalls } = scriptedAsk(["Use all mined checks"]);
    deps.askUser = ask;
    await runPlanInterview(newInterviewState(), deps);
    expect(vCalls).toHaveLength(1);
    const labels = vCalls[0]?.options.map((o) => o.label) ?? [];
    expect(labels).toContain("make test");
    expect(labels).toContain("bun run check");
    expect(labels).toContain("No verify commands");
    expect(store.session.userVerifies).toEqual(["make test", "bun run check"]);
  });

  test("free-text verification answer becomes a custom user verify", async () => {
    const { deps, store, db } = makeInterviewDeps();
    db.upsertRoutingProfile(PROJECT, { slider: 5 }, "user");
    deps.askUser = scriptedAsk(["./scripts/e2e.sh --fast"]).ask;
    await runPlanInterview(newInterviewState(), deps);
    expect(store.session.userVerifies).toEqual(["./scripts/e2e.sh --fast"]);
  });

  test("structured budget answer ⇒ profile row + events with source 'interview', no memory", async () => {
    const { deps, db } = makeInterviewDeps();
    deps.askUser = scriptedAsk(["No verify commands", "Cost-lean"]).ask;
    let invalidated = 0;
    deps.onProfileWrite = () => {
      invalidated += 1;
    };
    await runPlanInterview(newInterviewState(), deps);
    const row = db.getRoutingProfile(PROJECT);
    expect(row?.slider).toBe(3);
    expect(row?.source).toBe("interview");
    const events = db.listProfileEvents(PROJECT);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.source === "interview")).toBe(true);
    expect(invalidated).toBe(1);
    expect(db.listMemories(PROJECT)).toHaveLength(0);
  });

  test("prose budget answer ⇒ parsed knobs AND an active preference memory", async () => {
    const { deps, db } = makeInterviewDeps();
    deps.askUser = scriptedAsk([
      "No verify commands",
      "quality-lean please, but cap $0.05 per call",
    ]).ask;
    await runPlanInterview(newInterviewState(), deps);
    const row = db.getRoutingProfile(PROJECT);
    expect(row?.slider).toBe(7.5);
    expect(row?.max_cost_per_call).toBe(0.05);
    expect(row?.source).toBe("interview");
    const memory = db.listMemories(PROJECT)[0];
    expect(memory?.kind).toBe("preference");
    expect(memory?.origin).toBe("user");
    expect(memory?.status).toBe("active");
    expect(memory?.evidence_source).toBe("human");
    expect(memory?.content).toContain("quality-lean");
  });
});

describe("plan interview — verify answers reach seeded steps as user-origin checks", () => {
  const META: Model = {
    id: "meta-model",
    provider: "faux",
    api: "faux",
    name: "Meta",
    cost: { input: 0, output: 0 },
    context_window: 8192,
    max_tokens: 1024,
  };
  const synth = (): BigPlanSynthesis => ({
    title: "Ship it",
    goal: "ship",
    overview: "",
    requirements: [],
    constraints: [],
    decisions: [],
    approach: [
      { action: "wire the endpoint", verify: "", tools: [] },
      { action: "ship the change", verify: "", tools: [] },
    ],
    risks: [],
    successCriteria: [],
    openItems: [],
  });

  test("store → finalizePlan → seedPlanFromSteps stamps check_origin='user'", async () => {
    const { db, runId } = freshDb();
    const store = new PlanSessionStore("ship the endpoint");
    store.addUserVerify("make test");
    store.addUserVerify("bun run check");
    const out = await finalizePlan(store, {
      metaModel: META,
      signal: null,
      force: false,
      transcript: "",
      outPath: "/fake/BigPlan.md",
      db,
      runId,
      write: async () => {},
      answerQuestions: async () => [],
      synthesize: async () => synth(),
      critic: async () => null,
    });
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.seededCount).toBe(2);
    expect(out.seededVerifies).toEqual(["make test", "make test && bun run check"]);
    expect(out.auditNote).toContain("Interview checks");
    const plan = db.getActivePlan(runId)!;
    const steps = db.getPlanSteps(plan.id);
    expect(steps.map((s) => s.verify)).toEqual(["make test", "make test && bun run check"]);
    expect(steps.every((s) => s.check_origin === "user")).toBe(true);
  });

  test("applyUserVerifies fills gaps only — authored verifies are never overwritten", () => {
    const steps = [
      { verify: "bun test authored" },
      { verify: "" },
      { verify: "" },
    ];
    const applied = applyUserVerifies(steps, ["make test", "make lint"]);
    expect(applied.attached).toEqual([2, 3]);
    expect(applied.steps.map((s) => s.verify)).toEqual([
      "bun test authored",
      "make test",
      "make test && make lint",
    ]);
    expect(applyUserVerifies(steps, []).attached).toEqual([]);
  });
});

describe("plan interview — plan_turn hook", () => {
  const roundResult = (questions: CouncilRoundResult["questions"]): CouncilRoundResult => ({
    draft: "a draft",
    decisions: [],
    findings: [],
    faults: [],
    questions,
    facts: [],
    constraints: [],
    costUsd: 0,
    aborted: false,
  });

  function makeTurnDeps(over: Partial<PlanTurnDeps> = {}) {
    const events: string[] = [];
    const deps: PlanTurnDeps = {
      runRound: async () => roundResult([]),
      askUser: async (q) => {
        events.push(`ask:${q.header}`);
        return null;
      },
      onNote: () => {},
      buildSystem: () => "SYSTEM",
      promptPlanner: async () => {
        events.push("planner");
        return null;
      },
      controllerRef: { current: null },
      convene: () => true,
      ...over,
    };
    return { deps, events };
  }

  test("a convened round runs the interview after SYNTH's questions, before the planner", async () => {
    const { deps, events } = makeTurnDeps({
      runRound: async () =>
        roundResult([
          {
            question: "Which storage?",
            header: "council",
            options: [{ label: "sqlite" }],
            why: "",
          },
        ]),
      runInterview: async () => {
        events.push("interview");
      },
    });
    await runPlanTurn(new PlanSessionStore("g"), "substantive turn", deps);
    expect(events).toEqual(["ask:council", "interview", "planner"]);
  });

  test("without the dep (flag off) the turn is unchanged — no interview step", async () => {
    const { deps, events } = makeTurnDeps();
    await runPlanTurn(new PlanSessionStore("g"), "substantive turn", deps);
    expect(events).toEqual(["planner"]);
  });

  test("a non-convened turn never runs the interview", async () => {
    const { deps, events } = makeTurnDeps({
      convene: () => false,
      runInterview: async () => {
        events.push("interview");
      },
    });
    await runPlanTurn(new PlanSessionStore("g"), "small talk", deps);
    expect(events).toEqual(["planner"]);
  });
});

describe("plan interview — parsing units", () => {
  test("draftHasVerifies matches the council step formats only", () => {
    expect(draftHasVerifies("1. do it\n   - verify: `bun test`")).toBe(true);
    expect(draftHasVerifies("verify: make test")).toBe(true);
    expect(draftHasVerifies("we should verify the assumptions somehow")).toBe(false);
    expect(draftHasVerifies("")).toBe(false);
  });

  test("parseBudgetAnswer: keywords, bare numbers, caps", () => {
    expect(parseBudgetAnswer("Cost-lean")).toEqual({ slider: 3, maxCostPerCall: null });
    expect(parseBudgetAnswer("Balanced")).toEqual({ slider: 5, maxCostPerCall: null });
    expect(parseBudgetAnswer("Quality-lean")).toEqual({ slider: 7.5, maxCostPerCall: null });
    expect(parseBudgetAnswer("slider 8 works")).toEqual({ slider: 8, maxCostPerCall: null });
    expect(parseBudgetAnswer("balanced, cap $0.10")).toEqual({
      slider: 5,
      maxCostPerCall: 0.1,
    });
    expect(parseBudgetAnswer("max 0.25 usd per call")).toEqual({
      slider: null,
      maxCostPerCall: 0.25,
    });
    expect(parseBudgetAnswer("whatever you think")).toEqual({
      slider: null,
      maxCostPerCall: null,
    });
  });
});
