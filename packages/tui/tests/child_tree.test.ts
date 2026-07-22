import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/agent/events.ts";
import {
  agentEnd,
  agentStart,
  messageEnd,
  messageStart,
  messageUpdate,
  toolExecutionEnd,
  toolExecutionStart,
  turnEnd,
  turnStart,
} from "../src/agent/events.ts";
import {
  AssistantMessage,
  Message,
  type Model,
  type StopReason,
  Usage,
  attachCost,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { type ChildEvent, createSpawn } from "../src/minima/spawn.ts";
import { type ChildRow, applyChildEvent } from "../src/tui/child_tree.tsx";

// MUB-171: the /tree accumulator must read the REAL AgentEvent union (discriminated by
// `type`; realized cost at message.usage.cost.total) — the old handler read a `kind`
// field that exists on no event, so rows sat at $0.0000 "running" forever.

const PRICED: Model = {
  id: "priced",
  provider: "faux",
  api: "faux",
  name: "Priced",
  cost: { input: 3, output: 15 },
  context_window: 200_000,
  max_tokens: 8192,
};

function assistantTurn(
  input: number,
  output: number,
  stop_reason: StopReason = "stop",
): AssistantMessage {
  const usage = new Usage({ input, output });
  attachCost(PRICED, usage);
  return new AssistantMessage({ content: [text("ok")], model: PRICED.id, usage, stop_reason });
}

const wrap = (event: AgentEvent): ChildEvent => ({
  childId: "c1",
  stepId: "step-a",
  depth: 1,
  event,
});

function reduce(events: AgentEvent[]): ChildRow {
  let row: ChildRow | undefined;
  for (const ev of events) row = applyChildEvent(row, wrap(ev));
  if (!row) throw new Error("no events reduced");
  return row;
}

describe("applyChildEvent (/tree row accumulator)", () => {
  test("accumulates realized cost across assistant message_end events, without turn_end double-count", () => {
    const a1 = assistantTurn(1000, 200, "toolUse");
    const a2 = assistantTurn(1500, 300);
    const row = reduce([
      agentStart(),
      messageStart(new Message({ role: "user", content: "go" })),
      messageEnd(new Message({ role: "user", content: "go" })),
      turnStart(),
      messageStart(null),
      messageUpdate(null),
      messageEnd(a1),
      turnEnd(a1, []),
      turnStart(),
      messageEnd(a2),
      turnEnd(a2, []),
    ]);
    // (2500 × $3 + 500 × $15) / 1e6 — the same arithmetic attachCost uses.
    expect(row.costUsd).toBeCloseTo(0.015, 12);
    expect(row.status).toBe("running");
    expect(row.stepId).toBe("step-a");
    expect(row.depth).toBe(1);
  });

  test("agent_end after a clean stop flips running → done", () => {
    const a1 = assistantTurn(100, 10);
    const row = reduce([agentStart(), turnStart(), messageEnd(a1), turnEnd(a1, []), agentEnd([a1])]);
    expect(row.status).toBe("done");
    expect(row.costUsd).toBeCloseTo(a1.usage.cost.total, 12);
  });

  test("an aborted stub (stop_reason=aborted) flips to aborted and stays there through agent_end", () => {
    const a1 = assistantTurn(100, 10, "toolUse");
    const stub = new AssistantMessage({
      content: [text("[aborted by user]")],
      model: PRICED.id,
      stop_reason: "aborted",
    });
    const row = reduce([
      agentStart(),
      turnStart(),
      messageEnd(a1),
      turnEnd(a1, []),
      turnStart(),
      messageEnd(stub),
      agentEnd([a1, stub]),
    ]);
    expect(row.status).toBe("aborted");
    expect(row.costUsd).toBeCloseTo(a1.usage.cost.total, 12);
  });

  test("a provider error (stop_reason=error) flips to failure", () => {
    const err = new AssistantMessage({
      content: [text("")],
      model: PRICED.id,
      stop_reason: "error",
      error_message: "boom",
    });
    const row = reduce([agentStart(), turnStart(), messageEnd(err), turnEnd(err, []), agentEnd([err])]);
    expect(row.status).toBe("failure");
  });

  test("tool-execution and update events leave status/cost untouched", () => {
    const a1 = assistantTurn(100, 10, "toolUse");
    const row = reduce([
      agentStart(),
      turnStart(),
      messageEnd(a1),
      toolExecutionStart("t1", "bash", { command: "ls" }),
      toolExecutionEnd("t1", { content: [text("ok")] }, false),
      messageStart(new Message({ role: "toolResult", content: "ok", tool_call_id: "t1" })),
      messageEnd(new Message({ role: "toolResult", content: "ok", tool_call_id: "t1" })),
      turnEnd(a1, []),
    ]);
    expect(row.status).toBe("running");
    expect(row.costUsd).toBeCloseTo(a1.usage.cost.total, 12);
  });
});

// End-to-end: reduce the exact ChildEvent feed createSpawn forwards and pin the row's
// final cost to the child's meter total — the number the task-tool summary reports.
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
  return async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
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
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
}

describe("applyChildEvent over a real createSpawn event feed", () => {
  test("a completed child ends done with the meter's realized cost, matching ChildResult.costUsd", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("child answer: 42")] })]);

    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: mockService() });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const lead = new MinimaAgent({
      config,
      router,
      judge: new ConstJudge(0.9),
      meter: new CostMeter(),
      tools: [],
    });

    const events: ChildEvent[] = [];
    const spawn = createSpawn({ parent: lead, onChildEvent: (e) => events.push(e) });
    const result = await spawn(
      {
        step_id: "answer",
        objective: "compute the answer",
        output_format: "one line",
        boundaries: "read-only",
        effort: "light",
      },
      { depth: 1, parentSignal: null, priorResults: [] },
    );

    let row: ChildRow | undefined;
    for (const e of events) row = applyChildEvent(row, e);
    if (!row) throw new Error("no child events observed");
    expect(row.status).toBe("done");
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.costUsd).toBeCloseTo(result.costUsd, 12);

    reg.unregister();
  });
});
