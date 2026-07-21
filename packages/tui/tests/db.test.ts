import { describe, expect, test } from "bun:test";
import type { AgentTool } from "../src/agent/tools.ts";
import {
  AssistantMessage,
  type Model,
  Usage,
  context,
  isAssistant,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import {
  type AnthropicClientLike,
  AnthropicProvider,
  type AnthropicStreamEvent,
} from "../src/ai/providers/anthropic.ts";
import { MinimaDb, newId } from "../src/db/minima_db.ts";
import { applyRehydratedRun, rehydrateRun } from "../src/db/rehydrate.ts";
import { attachDbSink } from "../src/db/sink.ts";
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
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

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
            est_cost_low: 0.0005,
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
            {
              model_id: "big-model",
              provider: "faux",
              predicted_success: 0.95,
              est_cost_usd: 0.02,
              score: 0.02,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          selection_policy: "argmin",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike };
}

function agentWith(db: MinimaDb, runId: string, tools: AgentTool[] = []): MinimaAgent {
  const { fetchLike } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
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
    tools,
  });
  agent.db = db;
  agent.runId = runId;
  return agent;
}

function echoTool(): AgentTool {
  return {
    name: "echo",
    description: "echo the message back",
    parameters: {
      jsonSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      validate(v) {
        if (v && typeof v === "object" && "msg" in v) {
          return { ok: true, value: v as Record<string, unknown> };
        }
        return { ok: false, errors: ["msg is required"] };
      },
    },
    async execute(args) {
      return { content: [text(String((args as { msg: string }).msg))], is_error: false };
    },
  };
}

const ANTHROPIC_MODEL: Model = {
  id: "claude-test",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "Claude Test",
  cost: { input: 1, output: 5 },
  context_window: 200_000,
  max_tokens: 8192,
};

function capturingClient(): { client: AnthropicClientLike; captured: Record<string, unknown>[] } {
  const captured: Record<string, unknown>[] = [];
  return {
    captured,
    client: {
      messages: {
        stream: (opts: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent> => {
          captured.push(opts);
          async function* gen(): AsyncIterable<AnthropicStreamEvent> {
            yield { type: "message_stop" };
          }
          return gen();
        },
      },
    },
  };
}

describe("MinimaDb schema + lifecycle", () => {
  test("migrates to the latest schema with all core tables", () => {
    const db = new MinimaDb(":memory:");
    // v1 spine + v2 budgets/provenance + v3 plans + v4 file_changes + v5 verification
    // + v6 gate identity (rec_id/session_id/agent_id + closed_at/verify_cwd/note)
    // + v7 plan_steps.check_origin + v8 plan_steps.tools (A6) + v9 routing_decisions.step_id
    // + v10 checkpoints (B3) + v11 lineage-convergence re-run of the tools ALTER
    // + v12 memory ledger (memories/memory_events/memory_jobs)
    // + v13 version stamps (harness_version/tool_schema_hash) + tool_calls.result_ref
    // + v14 canonical Big Plan outcome columns
    // + v15 routing profiles (routing_profiles/profile_events)
    // + per-step candidate pools (plan_steps.candidates)
    // + v17 observer ledger (observer_verdicts/observer_events)
    // + v18 observer_verdicts.rec_id (signals-only feedback bridge) — floor, not exact:
    //   parallel unmerged stacks each append batches, so an exact count churns on
    //   every rebase.
    expect(db.schemaVersion).toBeGreaterThanOrEqual(14);
    for (const t of [
      "projects",
      "runs",
      "events",
      "routing_decisions",
      "tool_calls",
      "budgets",
      "budget_events",
      "plans",
      "plan_steps",
      "file_changes",
      "gates",
      "user_signals",
      "memories",
      "memory_events",
      "memory_jobs",
      "routing_profiles",
      "profile_events",
      "observer_verdicts",
      "observer_events",
    ]) {
      expect(db.db.query(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    db.close();
  });

  test("run lifecycle: start → name → finish; degraded is sticky", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj", "ns");
    const runId = db.startRun({
      projectKey: "proj",
      providerSessionId: "sess-1",
      gitBaseSha: "abc",
    });
    db.setRunName(runId, "fix the flaky test");
    expect(db.getRun(runId)?.display_name).toBe("fix the flaky test"); // survives reload
    db.markDegraded(runId);
    db.finishRun(runId, "done");
    expect(db.getRun(runId)?.status).toBe("degraded"); // done never masks degraded
    db.close();
  });

  test("writeDecision is idempotent on rec_id (retry updates, never duplicates)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const base = {
      recId: "rec-1",
      runId,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "memory",
      confidence: 0.8,
      thresholdUsed: 0.5,
      ranked: [{ modelId: "m", estCostUsd: 0.001 }],
      estCostUsd: 0.001,
      actualCostUsd: 0.001,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 10,
    };
    db.writeDecision(base);
    db.writeDecision({ ...base, actualCostUsd: 0.002, quality: 0.9, judged: true });
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actual_cost_usd).toBe(0.002);
    expect(rows[0]!.judged).toBe(1);
    db.close();
  });
});

describe("DecisionRecord writer (promptRouted)", () => {
  test("gate: one decision row per routed prompt, with ranked[] + all-premium anchor", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")] }),
      new AssistantMessage({ content: [text("two")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);

    await agent.promptRouted("first task");
    await agent.promptRouted("second task", { difficulty: "hard" });

    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(2); // == number of prompts
    for (const row of rows) {
      expect(String(row.rec_id)).toStartWith("rec-");
      expect(JSON.parse(String(row.ranked)).length).toBe(2);
      expect(row.all_premium_cost_usd).toBe(0.02); // max over ranked est
      expect(row.routed).toBe("server");
      expect(row.judged).toBe(1); // ConstJudge(0.9) grades every prompt
      expect(row.quality).toBe(0.9);
      expect(row.task_type).toBe("code"); // server-classified
    }
    // The routing event exists and links.
    const routingEvents = db.getRunEvents(runId).filter((e) => e.type === "routing");
    expect(routingEvents).toHaveLength(2);
    reg.unregister();
    db.close();
  });

  test("pinned run writes a synthetic local row labeled 'pinned'", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    agent.config.pinned = true;
    agent.config.candidates = ["test-faux"];

    await agent.promptRouted("pinned task");
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.rec_id)).toStartWith("local-"); // never the hosted join key
    expect(rows[0]!.routed).toBe("pinned");
    reg.unregister();
    db.close();
  });
});

describe("DbSink", () => {
  test("persists conversation events with correlated tool names (never placeholders)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    const sink = attachDbSink(agent, db, { runId });

    await agent.promptRouted("hello");
    sink.detach();

    const events = db.getRunEvents(runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types).toContain("routing");
    const assistant = events.find((e) => e.type === "assistant")!;
    expect(JSON.parse(assistant.payload).text).toBe("answer");
    expect(sink.degraded).toBe(false);
    reg.unregister();
    db.close();
  });
});

describe("rehydration (P1c)", () => {
  test("round-trip: resume restores context, cost footer, and judge cadence", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("first answer")] }),
      new AssistantMessage({ content: [text("second answer")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    const sink = attachDbSink(agent, db, { runId });
    await agent.promptRouted("task one");
    await agent.promptRouted("task two");
    sink.detach();
    db.setRunName(runId, "my run");

    // A fresh agent (new process) resumes the run.
    const agent2 = agentWith(db, db.startRun({ projectKey: "p" }));
    const r = rehydrateRun(db, runId);
    applyRehydratedRun(agent2, r);

    expect(r.run.display_name).toBe("my run"); // /name survives reload
    expect(agent2.agentState.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(agent2.agentState.messages[1]!.textContent).toBe("first answer");
    // Cost footer restored — NOT zeroed.
    expect(agent2.meter!.rows).toHaveLength(2);
    expect(agent2.meter!.totals().actualCostUsd).toBeGreaterThan(0);
    expect(r.promptsRun).toBe(2);
    reg.unregister();
    db.close();
  });

  test("round-trip: rehydrated assistant usage + stop_reason equal live values (U1.1)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [text("first answer")],
        usage: new Usage({ input: 1200, output: 300, cache_read: 50 }),
      }),
      new AssistantMessage({
        content: [text("second answer")],
        stop_reason: "length",
        usage: new Usage({ input: 2400, output: 150 }),
      }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    const sink = attachDbSink(agent, db, { runId });
    await agent.promptRouted("task one");
    await agent.promptRouted("task two");
    sink.detach();

    const live = agent.agentState.messages.filter(isAssistant);
    const restored = rehydrateRun(db, runId).messages.filter(isAssistant);
    expect(restored).toHaveLength(live.length);
    for (let i = 0; i < live.length; i++) {
      expect(restored[i]!.usage.input).toBe(live[i]!.usage.input);
      expect(restored[i]!.usage.output).toBe(live[i]!.usage.output);
      expect(restored[i]!.usage.cache_read).toBe(live[i]!.usage.cache_read);
      expect(restored[i]!.usage.cache_write).toBe(live[i]!.usage.cache_write);
      expect(restored[i]!.usage.cost.total).toBeCloseTo(live[i]!.usage.cost.total, 12);
      expect(restored[i]!.model).toBe(live[i]!.model);
      expect(restored[i]!.stop_reason).toBe(live[i]!.stop_reason);
    }
    // Sanity: real values survived, not zero-equals-zero.
    expect(restored[0]!.usage.input).toBe(1200);
    expect(restored[0]!.usage.cost.total).toBeGreaterThan(0);
    expect(restored[1]!.stop_reason).toBe("length");
    reg.unregister();
    db.close();
  });

  test("rehydrate: legacy/garbled payloads → zeroed usage and 'stop', never NaN (U1.1)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "hi" } });
    // Pre-U1 event shape: no usage/stop_reason at all.
    db.appendEvent({ runId, type: "assistant", payload: { role: "assistant", text: "legacy" } });
    // Garbled row: junk stop_reason, string tokens, non-numeric cost.
    db.appendEvent({
      runId,
      type: "assistant",
      payload: {
        role: "assistant",
        text: "odd",
        stop_reason: "weird",
        usage: { input: "3", cost_total: "nope" },
      },
    });
    const [legacy, odd] = rehydrateRun(db, runId).messages.filter(isAssistant);
    for (const v of [
      legacy!.usage.input,
      legacy!.usage.output,
      legacy!.usage.cache_read,
      legacy!.usage.cache_write,
      legacy!.usage.cost.total,
      odd!.usage.cost.total,
    ]) {
      expect(v).toBe(0);
    }
    expect(legacy!.stop_reason).toBe("stop");
    expect(odd!.usage.input).toBe(3); // numeric strings coerce
    expect(odd!.stop_reason).toBe("stop"); // unknown value falls back
    db.close();
  });

  test("sub-agent rows stay out of the lead conversation", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "lead" } });
    db.appendEvent({
      runId,
      agentId: "child-1",
      type: "assistant",
      payload: { role: "assistant", text: "child noise" },
    });
    const r = rehydrateRun(db, runId);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.textContent).toBe("lead");
    db.close();
  });

  test("resume lineage: parent_run_id recorded, rec_ids never duplicated", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const a = db.startRun({ projectKey: "p" });
    const b = db.startRun({ projectKey: "p" });
    db.setRunParent(b, a);
    expect(db.getRun(b)?.parent_run_id).toBe(a);
    // rec_id is a PK: writing the same id under another run updates, never duplicates.
    const base = {
      recId: "rec-x",
      runId: a,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "memory",
      confidence: 0.5,
      thresholdUsed: 0.5,
      ranked: [],
      estCostUsd: 0,
      actualCostUsd: 0,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 1,
    };
    db.writeDecision(base);
    db.writeDecision({ ...base, runId: b });
    expect(db.getRunDecisions(a)).toHaveLength(1);
    expect(db.getRunDecisions(b)).toHaveLength(0); // conflict-update keeps the original run
    db.close();
  });
});

describe("resume tool_use round-trip (MUB-175)", () => {
  test("tool_use ids + tool_call_id survive sink → rehydrate and serialize valid wire", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [text("calling"), toolCall("call-1", "echo", { msg: "ping" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId, [echoTool()]);
    const sink = attachDbSink(agent, db, { runId });
    await agent.promptRouted("use the tool");
    sink.detach();

    const r = rehydrateRun(db, runId);
    expect(r.messages.map((m) => m.role)).toEqual(
      agent.agentState.messages.map((m) => m.role), // user, assistant, toolResult, assistant
    );
    const asst = r.messages.filter(isAssistant).find((m) => m.toolCalls.length > 0);
    expect(asst).toBeDefined();
    expect(asst!.toolCalls).toEqual([
      { type: "toolCall", id: "call-1", name: "echo", arguments: { msg: "ping" } },
    ]);
    expect(asst!.textContent).toBe("calling");
    const result = r.messages.find((m) => m.role === "toolResult");
    expect(result?.tool_call_id).toBe("call-1");
    expect(result?.tool_name).toBe("echo");

    // The resume-400 itself: the reconstructed conversation must serialize with every
    // tool_result carrying its tool_use_id (undefined here was the live 400).
    const { client, captured } = capturingClient();
    const provider = new AnthropicProvider(client);
    for await (const _ of provider.stream(ANTHROPIC_MODEL, context({ messages: r.messages }))) {
    }
    const wire = captured[0]!.messages as {
      role: string;
      content: { type: string; id?: string; tool_use_id?: string }[];
    }[];
    const toolUses = wire.flatMap((m) => m.content.filter((b) => b.type === "tool_use"));
    const toolResults = wire.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.id).toBe("call-1");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.tool_use_id).toBe("call-1");
    reg.unregister();
    db.close();
  });

  test("rehydrate prunes orphans both directions (aborted/errored turns)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "go" } });
    // Aborted mid-tool: the tool_use was persisted, its result never was.
    db.appendEvent({
      runId,
      type: "assistant",
      payload: {
        role: "assistant",
        text: "on it",
        tool_calls: [{ id: "c-orphan", name: "bash", arguments: { cmd: "ls" } }],
      },
    });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "again" } });
    // Dangling result: its owning assistant tool_use is gone.
    db.appendEvent({
      runId,
      type: "tool",
      payload: { role: "toolResult", text: "stale", tool_name: "bash", tool_call_id: "c-gone" },
    });
    db.appendEvent({ runId, type: "assistant", payload: { role: "assistant", text: "done" } });

    const r = rehydrateRun(db, runId);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const [first, second] = r.messages.filter(isAssistant);
    expect(first!.toolCalls).toHaveLength(0); // orphan tool_use pruned
    expect(first!.textContent).toBe("on it"); // its text survives
    expect(second!.textContent).toBe("done");
    db.close();
  });

  test("an all-tool_use assistant with no results is dropped; answered pairs are kept", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "go" } });
    // Two calls, only one answered before the abort.
    db.appendEvent({
      runId,
      type: "assistant",
      payload: {
        role: "assistant",
        text: "",
        tool_calls: [
          { id: "c1", name: "bash", arguments: {} },
          { id: "c2", name: "read", arguments: {} },
        ],
      },
    });
    db.appendEvent({
      runId,
      type: "tool",
      payload: { role: "toolResult", text: "out", tool_name: "bash", tool_call_id: "c1" },
    });
    // A later turn aborted before ANY result: pure tool_use assistant, nothing to keep.
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "more" } });
    db.appendEvent({
      runId,
      type: "assistant",
      payload: {
        role: "assistant",
        text: "",
        tool_calls: [{ id: "c3", name: "bash", arguments: {} }],
      },
    });

    const r = rehydrateRun(db, runId);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    const asst = r.messages.filter(isAssistant)[0]!;
    expect(asst.toolCalls.map((c) => c.id)).toEqual(["c1"]); // c2 pruned, c1 kept
    expect(r.messages[2]!.tool_call_id).toBe("c1");
    db.close();
  });
});

describe("named runs (B1)", () => {
  const touch = (db: MinimaDb, runId: string, updated: number) =>
    db.db.run("UPDATE runs SET updated = ? WHERE run_id = ?", [updated, runId]);

  test("exact display_name beats a run-id prefix match", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const idOwner = db.startRun({ projectKey: "p" });
    const named = db.startRun({ projectKey: "p" });
    // Name one run EXACTLY like the other run's id prefix — the name must win.
    const collidingName = idOwner.slice(0, 8);
    db.setRunName(named, collidingName);
    expect(db.findRunByName("p", collidingName)?.run_id).toBe(named);
    db.close();
  });

  test("duplicate names: most-recent updated wins", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const a = db.startRun({ projectKey: "p" });
    const b = db.startRun({ projectKey: "p" });
    db.setRunName(a, "demo");
    db.setRunName(b, "demo");
    touch(db, a, 1000);
    touch(db, b, 2000);
    expect(db.findRunByName("p", "demo")?.run_id).toBe(b);
    touch(db, a, 3000);
    expect(db.findRunByName("p", "demo")?.run_id).toBe(a);
    db.close();
  });

  test("case-insensitive name fallback (exact case still wins first)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const lower = db.startRun({ projectKey: "p" });
    const exact = db.startRun({ projectKey: "p" });
    db.setRunName(lower, "demo run");
    db.setRunName(exact, "Demo Run");
    touch(db, lower, 5000); // more recent — but exact-case match outranks recency across stages
    touch(db, exact, 1000);
    expect(db.findRunByName("p", "Demo Run")?.run_id).toBe(exact);
    expect(db.findRunByName("p", "DEMO RUN")?.run_id).toBe(lower); // ci stage: recency wins
    db.close();
  });

  test("exact run_id and ≥4-char prefix resolve; short prefixes don't", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    expect(db.findRunByName("p", runId)?.run_id).toBe(runId);
    expect(db.findRunByName("p", runId.slice(0, 8))?.run_id).toBe(runId);
    expect(db.findRunByName("p", runId.slice(0, 3))).toBeNull(); // < 4 chars: too ambiguous
    db.close();
  });

  test("scoped to project_key", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p1");
    db.ensureProject("p2");
    const runId = db.startRun({ projectKey: "p1" });
    db.setRunName(runId, "demo");
    expect(db.findRunByName("p2", "demo")).toBeNull();
    expect(db.findRunByName("p1", "demo")?.run_id).toBe(runId);
    db.close();
  });

  test("no match → null; searchRuns lists recency-ordered near matches", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const a = db.startRun({ projectKey: "p" });
    const b = db.startRun({ projectKey: "p" });
    db.setRunName(a, "fix the parser");
    db.setRunName(b, "parser cleanup");
    touch(db, a, 1000);
    touch(db, b, 2000);
    expect(db.findRunByName("p", "nonexistent")).toBeNull();
    const near = db.searchRuns("p", "parser");
    expect(near.map((r) => r.run_id)).toEqual([b, a]);
    // LIKE metacharacters in the query are literal, not wildcards.
    expect(db.searchRuns("p", "%")).toHaveLength(0);
    db.close();
  });

  test("rename → resume round-trip: findRunByName + rehydrate + lineage", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const original = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, original);
    const sink = attachDbSink(agent, db, { runId: original });
    await agent.promptRouted("do the thing");
    sink.detach();
    db.setRunName(original, "was: first-name");
    db.setRunName(original, "demo"); // /rename overwrites
    expect(db.getRun(original)?.display_name).toBe("demo");

    // Fresh process: --resume demo → resolve, rehydrate, record lineage.
    const found = db.findRunByName("p", "demo");
    expect(found?.run_id).toBe(original);
    const newRun = db.startRun({ projectKey: "p" });
    const agent2 = agentWith(db, newRun);
    const r = rehydrateRun(db, found!.run_id);
    applyRehydratedRun(agent2, r);
    db.setRunParent(newRun, found!.run_id);
    expect(agent2.agentState.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(db.getRun(newRun)?.parent_run_id).toBe(original);
    reg.unregister();
    db.close();
  });
});

describe("identity", () => {
  test("run_id is DB-owned; provider session id is a plain column", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p", providerSessionId: "prompt-cache-key" });
    expect(runId).not.toBe("prompt-cache-key");
    expect(db.getRun(runId)?.provider_session_id).toBe("prompt-cache-key");
    expect(newId()).not.toBe(newId());
    db.close();
  });
});
