import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { BudgetLedger } from "../src/minima/budget.ts";
import { CostMeter } from "../src/minima/meter.ts";
import { type CouncilRoundResult, PlanSessionStore } from "../src/minima/plan_session.ts";
import { type PlanTurnDeps, runPlanTurn } from "../src/minima/plan_turn.ts";

const roundResult = (over: Partial<CouncilRoundResult> = {}): CouncilRoundResult => ({
  draft: "",
  decisions: [],
  findings: [],
  faults: [],
  questions: [],
  facts: [],
  constraints: [],
  costUsd: 0,
  aborted: false,
  ...over,
});

interface Recorded {
  deps: PlanTurnDeps;
  notes: string[];
  plannerCalls: { text: string; system: string }[];
  asked: string[];
  roundCalls: { roundBudgetUsd?: number }[];
}

function makeDeps(over: Partial<PlanTurnDeps> = {}): Recorded {
  const notes: string[] = [];
  const plannerCalls: { text: string; system: string }[] = [];
  const asked: string[] = [];
  const roundCalls: { roundBudgetUsd?: number }[] = [];
  const deps: PlanTurnDeps = {
    runRound: async (_session, _text, o) => {
      roundCalls.push({ roundBudgetUsd: o.roundBudgetUsd });
      return roundResult();
    },
    askUser: async (q) => {
      asked.push(q.question);
      return null;
    },
    onNote: (t) => notes.push(t),
    buildSystem: (s) => `PERSONA\n\n${s.snapshotBlock()}`,
    promptPlanner: async (text, system) => {
      plannerCalls.push({ text, system });
      return null;
    },
    controllerRef: { current: null },
    convene: () => true,
    ...over,
  };
  return { deps, notes, plannerCalls, asked, roundCalls };
}

describe("runPlanTurn — whole-turn abort", () => {
  test("an abort during the round ends the turn: partial merged, planner never called", async () => {
    const r = makeDeps();
    r.deps.runRound = async () => {
      // Esc mid-council: the WHOLE-turn controller aborts, then the round resolves partial.
      r.deps.controllerRef.current?.abort();
      return roundResult({
        findings: [{ source: "researcher", summary: "partial research", severity: "info" }],
        costUsd: 0.01,
      });
    };
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(r.plannerCalls).toHaveLength(0);
    expect(store.session.rounds).toBe(1); // partial council result still merged
    expect(store.session.findings.map((f) => f.summary)).toContain("partial research");
    expect(r.notes.some((n) => n.includes("plan turn aborted"))).toBe(true);
    expect(r.deps.controllerRef.current).toBeNull(); // nulled in the finally
  });

  test("aborted:true WITH questions (abort raced synthesis) skips the overlay too", async () => {
    const r = makeDeps({
      runRound: async () =>
        roundResult({
          aborted: true,
          questions: [{ question: "Which store?", header: "storage", options: [], why: "" }],
        }),
    });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(r.asked).toHaveLength(0); // no question overlay
    expect(r.plannerCalls).toHaveLength(0); // no fresh paid planner call
    const q = store.session.openQuestions.find((x) => x.question === "Which store?");
    expect(q?.status).toBe("open"); // merged but unanswered
    expect(r.notes.some((n) => n.includes("plan turn aborted"))).toBe(true);
  });

  test("a clean round surfaces questions then reaches the planner exactly once", async () => {
    const r = makeDeps({
      runRound: async () =>
        roundResult({
          draft: "The plan.",
          decisions: [{ topic: "Storage", decision: "Use SQLite", rationale: "embedded" }],
          questions: [{ question: "Which runtime?", header: "rt", options: [], why: "deps" }],
        }),
      askUser: async () => "Bun",
    });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(r.plannerCalls).toHaveLength(1);
    expect(r.plannerCalls[0]!.text).toBe("a substantive turn");
    // The planner system prompt carries the post-merge snapshot projection.
    expect(r.plannerCalls[0]!.system).toContain(store.snapshotBlock());
    expect(r.plannerCalls[0]!.system).toContain("Storage: Use SQLite");
    const answered = store.session.openQuestions.find((q) => q.question === "Which runtime?");
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toBe("Bun");
  });

  test("convene=false skips the council and goes straight to the planner", async () => {
    const r = makeDeps({ convene: () => false });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "ok", r.deps);

    expect(r.roundCalls).toHaveLength(0);
    expect(r.plannerCalls).toHaveLength(1);
    expect(store.session.rounds).toBe(0);
  });
});

describe("runPlanTurn — council budget + metering", () => {
  test("council spend books into the ledger: reserve+reconcile pair, spent_usd grows", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const budget = new BudgetLedger({ db, scopeKey: "plan-scope", limitUsd: 1.0, mode: "warn" });
    const r = makeDeps({
      budget,
      roundBudgetUsd: 0.25,
      runRound: async (_s, _t, o) => {
        r.roundCalls.push({ roundBudgetUsd: o.roundBudgetUsd });
        return roundResult({ costUsd: 0.05 });
      },
    });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    const s = budget.status();
    expect(s.spentUsd).toBeCloseTo(0.05, 8);
    expect(s.reservedUsd).toBeCloseTo(0, 8);
    // The dormant round soft cap is now live: the round saw min(config cap, remaining).
    expect(r.roundCalls[r.roundCalls.length - 1]!.roundBudgetUsd).toBeCloseTo(0.25, 8);
    const events = db.db
      .query("SELECT kind, note, amount_usd FROM budget_events WHERE scope_key = ? ORDER BY ts")
      .all("plan-scope") as { kind: string; note: string | null; amount_usd: number }[];
    const reserve = events.find((e) => e.kind === "reserve");
    const reconcile = events.find((e) => e.kind === "reconcile");
    expect(reserve?.note).toBe("plan council r1");
    expect(reserve?.amount_usd).toBeCloseTo(0.25, 8);
    expect(reconcile?.note).toBe("plan council r1");
    expect(reconcile?.amount_usd).toBeCloseTo(0.05, 8);
    db.close();
  });

  test("enforce mode + exhausted budget skips the council entirely", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const budget = new BudgetLedger({ db, scopeKey: "s", limitUsd: 0.05, mode: "enforce" });
    const res = budget.reserve(0.05);
    if (res.ok) budget.reconcile(res.id, 0.05); // spend to the limit
    expect(budget.exhausted()).toBe(true);

    const r = makeDeps({ budget, roundBudgetUsd: 0.25 });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(r.roundCalls).toHaveLength(0); // council never convened
    expect(r.notes.some((n) => n.includes("budget exhausted"))).toBe(true);
    // The planner still runs — its own enforce gate refuses consistently downstream.
    expect(r.plannerCalls).toHaveLength(1);
    db.close();
  });

  test("the lead meter gets one row per round, visible to /cost", async () => {
    const meter = new CostMeter();
    const r = makeDeps({
      meter,
      runRound: async () => roundResult({ costUsd: 0.07 }),
    });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0]!.label).toBe("plan council r1");
    expect(meter.rows[0]!.actualCostUsd).toBeCloseTo(0.07, 8);
    expect(meter.rows[0]!.model).toBe("(offline)"); // off-routing meta spend
    expect(meter.rows[0]!.outcome).toBe("success");
    expect(meter.rows[0]!.quality).toBeNull(); // never fabricated
  });

  test("an aborted round still reconciles realized spend and meters it as aborted", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const budget = new BudgetLedger({ db, scopeKey: "s2", limitUsd: 1.0, mode: "warn" });
    const meter = new CostMeter();
    const r = makeDeps({
      budget,
      meter,
      roundBudgetUsd: 0.25,
      runRound: async () => roundResult({ aborted: true, costUsd: 0.03 }),
    });
    const store = new PlanSessionStore("goal");
    await runPlanTurn(store, "a substantive turn", r.deps);

    expect(budget.status().spentUsd).toBeCloseTo(0.03, 8); // realized spend is real
    expect(budget.status().reservedUsd).toBeCloseTo(0, 8);
    expect(meter.rows[0]!.outcome).toBe("aborted");
    expect(r.plannerCalls).toHaveLength(0);
    db.close();
  });
});

describe("MP15 — conditional convening + keeper mini-update", () => {
  const seededStore = (): PlanSessionStore => {
    const store = new PlanSessionStore("goal");
    store.applyCouncilResult(roundResult({ draft: "Standing plan prose." }));
    return store;
  };

  test("default convene: a substantive FOLLOW-UP turn skips the council (planner only)", async () => {
    const r = makeDeps();
    (r.deps as { convene?: unknown }).convene = undefined;
    const store = seededStore();
    await runPlanTurn(store, "what does the second step imply for the migration tests?", r.deps);
    expect(r.roundCalls).toHaveLength(0);
    expect(r.plannerCalls).toHaveLength(1);
  });

  test("default convene: the FIRST substantive turn still convenes", async () => {
    const r = makeDeps();
    (r.deps as { convene?: unknown }).convene = undefined;
    const store = new PlanSessionStore("");
    await runPlanTurn(store, "please design the storage layer for the cache", r.deps);
    expect(r.roundCalls).toHaveLength(1);
  });

  test("non-council turn runs the keeper mini-update AFTER the planner and applies it", async () => {
    const order: string[] = [];
    const r = makeDeps({
      convene: () => false,
      promptPlanner: async () => {
        order.push("planner");
        return null;
      },
      runMiniUpdate: async () => {
        order.push("mini");
        return {
          update: { draft: "Freshened draft.", decisions: [], questions: [] },
          costUsd: 0.002,
        };
      },
    });
    const store = seededStore();
    await runPlanTurn(store, "short follow up", r.deps);
    expect(order).toEqual(["planner", "mini"]);
    expect(store.session.draft).toBe("Freshened draft.");
    expect(store.session.rounds).toBe(1);
  });

  test("mini-update books reserve+reconcile labelled 'plan keeper update' + one meter row", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const budget = new BudgetLedger({ db, scopeKey: "sess-mini", limitUsd: 1, mode: "warn" });
    const meter = new CostMeter();
    const r = makeDeps({
      convene: () => false,
      budget,
      meter,
      runMiniUpdate: async () => ({
        update: { draft: "D.", decisions: [], questions: [] },
        costUsd: 0.004,
      }),
    });
    await runPlanTurn(seededStore(), "short follow up", r.deps);
    expect(budget.status().spentUsd).toBeCloseTo(0.004, 6);
    const rows = meter.rows.filter((m) => m.label === "plan keeper update");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualCostUsd).toBeCloseTo(0.004, 6);
    db.close();
  });

  test("mini-update failure is fail-open and silent: draft unchanged, no error note", async () => {
    const r = makeDeps({
      convene: () => false,
      runMiniUpdate: async () => {
        throw new Error("meta model down");
      },
    });
    const store = seededStore();
    await runPlanTurn(store, "short follow up", r.deps);
    expect(store.session.draft).toBe("Standing plan prose.");
    expect(r.notes).toHaveLength(0);
    expect(r.plannerCalls).toHaveLength(1);
  });

  test("mini-update skipped when the turn aborted and when enforce-budget is exhausted", async () => {
    let miniCalls = 0;
    const mini = async () => {
      miniCalls += 1;
      return { update: null, costUsd: 0 };
    };
    const r1 = makeDeps({ convene: () => false, runMiniUpdate: mini });
    r1.deps.promptPlanner = async () => {
      r1.deps.controllerRef.current?.abort();
      return null;
    };
    await runPlanTurn(seededStore(), "short follow up", r1.deps);
    expect(miniCalls).toBe(0);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const budget = new BudgetLedger({ db, scopeKey: "sess-exh", limitUsd: 0.001, mode: "enforce" });
    const res = budget.reserve(0.001);
    if (res.ok) budget.reconcile(res.id, 0.002);
    const r2 = makeDeps({ convene: () => false, budget, runMiniUpdate: mini });
    await runPlanTurn(seededStore(), "short follow up", r2.deps);
    expect(miniCalls).toBe(0);
    db.close();
  });
});
