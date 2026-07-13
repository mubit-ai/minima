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
