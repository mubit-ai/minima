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
import { BudgetLedger, type BudgetEvent } from "../src/minima/budget.ts";
import { LLMJudge } from "../src/minima/judge.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// Decision (a) on the onCostUsd thread: judge spend books to the session WALLET (meter
// overhead + BudgetLedger) but NEVER into feedback's actual_cost_usd — folding it in would
// inflate the routed model's observed $/call and poison the observed/rescaled cost basis.

describe("CostMeter overhead (judge spend)", () => {
  test("accumulates into totals().overheadUsd without touching row-based actuals", () => {
    const m = new CostMeter();
    m.record({ label: "p1", routing: null, actualCostUsd: 0.5, quality: null, outcome: "success" });
    m.addOverhead(0.01);
    m.addOverhead(0.02);
    const t = m.totals();
    expect(t.overheadUsd).toBeCloseTo(0.03, 12);
    expect(t.actualCostUsd).toBeCloseTo(0.5, 12); // rows only — savings math unchanged
  });

  test("rejects NaN / Infinity / zero / negatives (the hook fires 0 on judge errors)", () => {
    const m = new CostMeter();
    m.addOverhead(Number.NaN);
    m.addOverhead(Number.POSITIVE_INFINITY);
    m.addOverhead(0);
    m.addOverhead(-1);
    expect(m.totals().overheadUsd).toBe(0);
  });

  test("report() shows the overhead + session total line only when overhead was booked", () => {
    const m = new CostMeter();
    m.record({ label: "p1", routing: null, actualCostUsd: 0.5, quality: null, outcome: "success" });
    expect(m.report()).not.toContain("judge overhead");
    m.addOverhead(0.25);
    const r = m.report();
    expect(r).toContain("judge overhead $0.250000");
    expect(r).toContain("session total $0.750000");
  });
});

describe("BudgetLedger.bookSpend (reservation-less overhead)", () => {
  function ledger(opts: { limitUsd: number; mode?: "warn" | "enforce" }) {
    const db = new MinimaDb(":memory:");
    const events: BudgetEvent[] = [];
    const l = new BudgetLedger({
      db,
      scopeKey: "s",
      limitUsd: opts.limitUsd,
      mode: opts.mode ?? "warn",
      onEvent: (e) => events.push(e),
    });
    return { db, l, events };
  }

  test("books straight to spent_usd, leaves reservations alone, logs a 'book' event", () => {
    const { db, l, events } = ledger({ limitUsd: 10 });
    l.bookSpend(0.05, "judge");
    const s = l.status();
    expect(s.spentUsd).toBeCloseTo(0.05, 12);
    expect(s.reservedUsd).toBe(0);
    expect(events.some((e) => e.kind === "book" && e.amountUsd === 0.05)).toBe(true);
    const row = db.db
      .query("SELECT kind, note, amount_usd FROM budget_events WHERE kind = 'book'")
      .get() as { kind: string; note: string; amount_usd: number };
    expect(row.note).toBe("judge");
    expect(row.amount_usd).toBeCloseTo(0.05, 12);
  });

  test("crossing a threshold via bookSpend fires the graduated notice", () => {
    const { l, events } = ledger({ limitUsd: 1 });
    l.bookSpend(0.6, "judge");
    expect(events.filter((e) => e.kind === "threshold")).toHaveLength(1);
  });

  test("guards NaN / zero / negatives (no spend, no event)", () => {
    const { l, events } = ledger({ limitUsd: 1 });
    l.bookSpend(Number.NaN);
    l.bookSpend(0);
    l.bookSpend(-0.5);
    expect(l.status().spentUsd).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("never blocks, even in enforce mode past the limit — the spend already happened", () => {
    const { l } = ledger({ limitUsd: 0.01, mode: "enforce" });
    l.bookSpend(0.5, "judge");
    expect(l.status().spentUsd).toBeCloseTo(0.5, 12);
  });
});

// End-to-end pin of decision (a): with an LLMJudge wired the way cli/main.ts wires it,
// the wallet sees run + judge spend, but /v1/feedback carries ONLY the run's realized cost.
const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
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
    if (method === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, feedbackCalls };
}

describe("judge spend: wallet yes, feedback no (decision a)", () => {
  test("budget + meter overhead carry judge cost; actual_cost_usd stays run-only", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("answer")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("8")], stop_reason: "stop" }), // the judge's grade
    ]);
    const { fetchLike, feedbackCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const meter = new CostMeter();

    // Mirror cli/main.ts: late-bound hook → meter overhead + budget bookSpend.
    let bookJudgeSpend: (usd: number) => void = () => {};
    const judge = new LLMJudge(FAUX_MODEL, { onCostUsd: (usd) => bookJudgeSpend(usd) });
    const agent = new MinimaAgent({ config, router, judge, meter, tools: [] });
    agent.db = db;
    agent.runId = runId;
    agent.budget = new BudgetLedger({ db, scopeKey: "s", limitUsd: 5, mode: "warn", runId });
    bookJudgeSpend = (usd) => {
      agent.meter.addOverhead(usd);
      agent.budget?.bookSpend(usd, "judge");
    };

    await agent.promptRouted("do the thing");

    expect(feedbackCalls).toHaveLength(1);
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.quality_score).toBe(0.8); // the judge really graded (8/10)
    expect(fb.judged).toBe(true);

    const overhead = meter.totals().overheadUsd;
    expect(overhead).toBeGreaterThan(0); // judge spend landed in the wallet...
    expect(fb.actual_cost_usd).toBe(meter.rows[0]!.actualCostUsd); // ...but not in feedback
    expect(agent.budget.status().spentUsd).toBeCloseTo(
      (fb.actual_cost_usd as number) + overhead,
      12,
    );

    reg.unregister();
    db.close();
  });
});
