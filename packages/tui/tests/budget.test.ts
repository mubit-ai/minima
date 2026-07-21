import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { type BudgetEvent, BudgetLedger, reserveAmount } from "../src/minima/budget.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1000, output: 2000 }, // pricey so realized cost is non-trivial
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${Math.random().toString(16).slice(2, 8)}`,
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            est_cost_high: 0.002,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return fetchLike;
}

function budgetAgent(db: MinimaDb, limitUsd: number, mode: "warn" | "enforce"): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: mockService() });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  const runId = db.startRun({ projectKey: "p" });
  agent.db = db;
  agent.runId = runId;
  agent.budget = new BudgetLedger({
    db,
    scopeKey: `session:${runId}`,
    limitUsd,
    mode,
    runId,
  });
  return agent;
}

describe("reserveAmount", () => {
  test("pads the p75 band; pads harder with no band", () => {
    expect(reserveAmount(0.001, 0.002)).toBeCloseTo(0.003, 8); // high * 1.5
    expect(reserveAmount(0.001, null)).toBeCloseTo(0.003, 8); // est * 3
  });
});

describe("BudgetLedger (DB-backed)", () => {
  test("reserve/reconcile bookkeeping + status math", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const b = new BudgetLedger({ db, scopeKey: "s1", limitUsd: 1.0 });
    const r = b.reserve(0.3);
    expect(r.ok).toBe(true);
    let s = b.status();
    expect(s.reservedUsd).toBeCloseTo(0.3, 8);
    expect(s.remainingUsd).toBeCloseTo(0.7, 8);
    b.reconcile((r as { ok: true; id: string }).id, 0.1);
    s = b.status();
    expect(s.reservedUsd).toBeCloseTo(0, 8);
    expect(s.spentUsd).toBeCloseTo(0.1, 8);
    expect(s.remainingUsd).toBeCloseTo(0.9, 8);
    db.close();
  });

  test("thresholds fire once each, in order, with actionable notes", () => {
    const db = new MinimaDb(":memory:");
    const events: BudgetEvent[] = [];
    const b = new BudgetLedger({
      db,
      scopeKey: "s2",
      limitUsd: 1.0,
      onEvent: (e) => events.push(e),
    });
    const spend = (usd: number) => {
      const r = b.reserve(usd) as { ok: true; id: string };
      b.reconcile(r.id, usd);
    };
    spend(0.55); // crosses 50
    spend(0.2); // crosses 75
    spend(0.2); // crosses 90
    spend(0.1); // crosses 100
    spend(0.05); // NO re-fire
    const thresholds = events.filter((e) => e.kind === "threshold").map((e) => e.note);
    expect(thresholds).toHaveLength(4);
    expect(thresholds[0]).toContain("50%");
    expect(thresholds[3]).toContain("exhausted");
    db.close();
  });

  test("enforce mode denies a reserve that would overshoot; warn mode grants it", () => {
    const db = new MinimaDb(":memory:");
    const strict = new BudgetLedger({ db, scopeKey: "s3", limitUsd: 0.1, mode: "enforce" });
    const denied = strict.reserve(0.5);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("exceed");
    const lax = new BudgetLedger({ db, scopeKey: "s4", limitUsd: 0.1, mode: "warn" });
    expect(lax.reserve(0.5).ok).toBe(true); // warn never blocks
    db.close();
  });

  test("gate: two ledgers over ONE shared scope never jointly overshoot (enforce)", () => {
    const db = new MinimaDb(":memory:");
    const a = new BudgetLedger({ db, scopeKey: "shared", limitUsd: 1.0, mode: "enforce" });
    const b = new BudgetLedger({ db, scopeKey: "shared", limitUsd: 1.0, mode: "enforce" });
    const ra = a.reserve(0.6);
    expect(ra.ok).toBe(true);
    const rb = b.reserve(0.6); // 0.6 + 0.6 > 1.0 — must be denied by the guarded UPDATE
    expect(rb.ok).toBe(false);
    const s = a.status();
    expect(s.reservedUsd).toBeCloseTo(0.6, 8); // never 1.2
    db.close();
  });

  test("maxCostPerCall: remaining in warn/enforce; undefined when shadow or spent out", () => {
    const db = new MinimaDb(":memory:");
    const warn = new BudgetLedger({ db, scopeKey: "m1", limitUsd: 0.01, mode: "warn" });
    expect(warn.maxCostPerCall()).toBeCloseTo(0.01, 8);
    const r = warn.reserve(0.02) as { ok: true; id: string };
    warn.reconcile(r.id, 0.02); // spent past the limit
    // Exhausted in warn = UNCAPPED, not 0: warn never blocks, and a $0 cap would make
    // every subsequent route infeasible (the F1 death spiral this file guards against).
    expect(warn.maxCostPerCall()).toBeUndefined();
    const shadow = new BudgetLedger({ db, scopeKey: "m2", limitUsd: 0.01, mode: "shadow" });
    expect(shadow.maxCostPerCall()).toBeUndefined(); // shadow never changes routing
    const enforce = new BudgetLedger({ db, scopeKey: "m3", limitUsd: 0.01, mode: "enforce" });
    expect(enforce.maxCostPerCall()).toBeCloseTo(0.01, 8);
    db.close();
  });

  test("budget_events audit trail is written", () => {
    const db = new MinimaDb(":memory:");
    const b = new BudgetLedger({ db, scopeKey: "s5", limitUsd: 1.0 });
    const r = b.reserve(0.2) as { ok: true; id: string };
    b.reconcile(r.id, 0.15);
    const kinds = db.db
      .query("SELECT kind FROM budget_events WHERE scope_key = 's5' ORDER BY ts")
      .all() as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toEqual(["reserve", "reconcile"]);
    db.close();
  });
});

describe("MinimaAgent budget wiring", () => {
  test("routed run reserves then reconciles realized spend into the scope", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = budgetAgent(db, 5, "warn");
    await agent.promptRouted("do something");

    const s = agent.budget!.status();
    expect(s.reservedUsd).toBeCloseTo(0, 8); // reservation swapped for actual
    expect(s.spentUsd).toBeGreaterThan(0); // realized cost booked
    expect(s.spentUsd).toBeCloseTo(agent.meter!.totals().actualCostUsd, 8);
    reg.unregister();
    db.close();
  });

  test("gate: enforce mode refuses a new run once exhausted — before any provider spend", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("first")] }),
      new AssistantMessage({ content: [text("never sent")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    // The first reserve ($0.003 = est_high*1.5) FITS under $0.004, but the realized spend
    // (10 in + 10 out tokens at 1000/2000 $/Mtok = $0.03) blows through the cap.
    const first = new AssistantMessage({ content: [text("first")] });
    first.usage.input = 10;
    first.usage.output = 10;
    reg.setResponses([first, new AssistantMessage({ content: [text("never sent")] })]);
    const agent = budgetAgent(db, 0.004, "enforce");
    await agent.promptRouted("first"); // spends past the cap (reserve granted at start)
    expect(agent.budget!.exhausted()).toBe(true);

    await expect(agent.promptRouted("second")).rejects.toThrow(/budget exhausted/);
    expect(reg.state.pendingResponseCount).toBe(1); // second response never consumed
    reg.unregister();
    db.close();
  });

  test("warn mode never blocks — runs continue past the limit", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")] }),
      new AssistantMessage({ content: [text("two")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = budgetAgent(db, 0.000001, "warn");
    await agent.promptRouted("first");
    await agent.promptRouted("second"); // no throw
    expect(agent.agentState.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    reg.unregister();
    db.close();
  });
});
