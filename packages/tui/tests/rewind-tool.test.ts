import { describe, expect, test } from "bun:test";

import { Agent, type AgentTool, AgentState } from "../src/agent/index.ts";
import { CONTEXT_REWIND_EVENT } from "../src/agent/context_prune.ts";
import {
  AssistantMessage,
  Message,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { attachDbSink } from "../src/db/sink.ts";
import { configFromEnv } from "../src/minima/config.ts";
import {
  type ContextRewindDeps,
  checkpointTool,
  registerContextRewindTools,
  rewindTool,
} from "../src/tools/checkpoint_rewind.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

function probeTool(): AgentTool {
  return {
    name: "probe",
    description: "a faux exploration tool",
    parameters: {
      jsonSchema: { type: "object", properties: { msg: { type: "string" } }, required: [] },
      validate(v) {
        return { ok: true, value: (v ?? {}) as Record<string, unknown> };
      },
    },
    async execute(_id, params) {
      return { content: [text(`PROBE-OUTPUT-${String(params.msg ?? "")}`)] };
    },
  };
}

function toolDeps(agent: Agent, db: MinimaDb | null, runId: string | null): ContextRewindDeps {
  return { getState: () => agent.agentState, db, getRunId: () => runId };
}

function freshDb(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  return { db, runId };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const toolResults = (msgs: Message[], name: string) =>
  msgs.filter((m) => m.role === "toolResult" && m.tool_name === name);

describe("checkpoint/rewind tool pair (AC1)", () => {
  test("rewind prunes exploration from the projection; the ledger keeps every row", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("cp1", "checkpoint", { label: "explore" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("p1", "probe", { msg: "one" }), toolCall("p2", "probe", { msg: "two" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", { report: "REPORT: config lives in src/x.ts" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done")] }),
    ]);

    const { db, runId } = freshDb();
    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, true, toolDeps(agent, db, runId));
    const sink = attachDbSink(agent, db, { runId });
    await agent.prompt("go");
    sink.detach();

    const msgs = agent.agentState.messages;
    expect(toolResults(msgs, "probe")).toHaveLength(0);
    const flat = msgs.map((m) => m.textContent).join("\n");
    expect(flat).not.toContain("PROBE-OUTPUT");
    expect(flat).toContain("REPORT: config lives in src/x.ts");

    const cp = toolResults(msgs, "checkpoint");
    expect(cp).toHaveLength(1);
    expect(cp[0]!.tool_call_id).toBe("cp1");
    const rw = toolResults(msgs, "rewind");
    expect(rw).toHaveLength(1);
    expect(rw[0]!.is_error).toBe(false);

    const anchorIdx = msgs.indexOf(cp[0]!);
    const after = msgs[anchorIdx + 1]!;
    expect(after.role).toBe("assistant");
    expect((after as AssistantMessage).toolCalls.map((c) => c.id)).toEqual(["rw1"]);

    const events = db.getRunEvents(runId);
    const markers = events.filter((e) => e.type === CONTEXT_REWIND_EVENT);
    expect(markers).toHaveLength(1);
    const probeRows = events.filter(
      (e) => e.type === "tool" && String(e.payload).includes("PROBE-OUTPUT"),
    );
    expect(probeRows).toHaveLength(2);

    const payload = JSON.parse(markers[0]!.payload) as Record<string, unknown>;
    expect(payload.anchor_tool_call_id).toBe("cp1");
    expect(payload.rewind_tool_call_id).toBe("rw1");
    expect(String(payload.report)).toContain("REPORT: config lives in src/x.ts");
    expect(typeof payload.report_chars).toBe("number");

    reg.unregister();
    db.close();
  });
});

describe("rewind guard rails (AC3)", () => {
  test("guard: rewind with no checkpoint errors, writes no marker, prunes nothing", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", { report: "x" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const { db, runId } = freshDb();
    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, true, toolDeps(agent, db, runId));
    const sink = attachDbSink(agent, db, { runId });
    await agent.prompt("go");
    sink.detach();

    const rw = toolResults(agent.agentState.messages, "rewind");
    expect(rw).toHaveLength(1);
    expect(rw[0]!.is_error).toBe(true);
    expect(rw[0]!.textContent).toContain("no active checkpoint");
    expect(db.getRunEvents(runId).filter((e) => e.type === CONTEXT_REWIND_EVENT)).toHaveLength(0);
    expect(agent.agentState.messages[0]!.textContent).toBe("go");

    reg.unregister();
    db.close();
  });

  test("guard: checkpoint batched with rewind in one turn has not committed yet", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [
          toolCall("cp1", "checkpoint", {}),
          toolCall("rw1", "rewind", { report: "too soon" }),
        ],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const { db, runId } = freshDb();
    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, true, toolDeps(agent, db, runId));
    const sink = attachDbSink(agent, db, { runId });
    await agent.prompt("go");
    sink.detach();

    const cp = toolResults(agent.agentState.messages, "checkpoint");
    expect(cp).toHaveLength(1);
    expect(cp[0]!.is_error).toBe(false);
    const rw = toolResults(agent.agentState.messages, "rewind");
    expect(rw).toHaveLength(1);
    expect(rw[0]!.is_error).toBe(true);
    expect(rw[0]!.textContent).toContain("not committed");
    expect(db.getRunEvents(runId).filter((e) => e.type === CONTEXT_REWIND_EVENT)).toHaveLength(0);

    reg.unregister();
    db.close();
  });

  test("guard: a rewound checkpoint is consumed — the second rewind demands a fresh one", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("cp1", "checkpoint", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("p1", "probe", { msg: "one" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", { report: "first report" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("rw2", "rewind", { report: "second report" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const { db, runId } = freshDb();
    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, true, toolDeps(agent, db, runId));
    const sink = attachDbSink(agent, db, { runId });
    await agent.prompt("go");
    sink.detach();

    const rw = toolResults(agent.agentState.messages, "rewind");
    expect(rw).toHaveLength(2);
    expect(rw[0]!.is_error).toBe(false);
    expect(rw[1]!.is_error).toBe(true);
    expect(rw[1]!.textContent).toContain("consumed");
    expect(db.getRunEvents(runId).filter((e) => e.type === CONTEXT_REWIND_EVENT)).toHaveLength(1);

    reg.unregister();
    db.close();
  });

  test("guard: empty report is rejected before any prune", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("cp1", "checkpoint", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", { report: "   " })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const { db, runId } = freshDb();
    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, true, toolDeps(agent, db, runId));
    const sink = attachDbSink(agent, db, { runId });
    await agent.prompt("go");
    sink.detach();

    const rw = toolResults(agent.agentState.messages, "rewind");
    expect(rw).toHaveLength(1);
    expect(rw[0]!.is_error).toBe(true);
    expect(rw[0]!.textContent).toContain("report");
    expect(db.getRunEvents(runId).filter((e) => e.type === CONTEXT_REWIND_EVENT)).toHaveLength(0);
    expect(findRewindAnchorStillLive(agent)).toBe(true);

    reg.unregister();
    db.close();
  });

  test("guard: compaction wiping the anchor names compaction as the likely cause", async () => {
    const state = new AgentState();
    state.messages = [
      new Message({
        role: "user",
        content: "[Compacted 12 messages]\nTool(checkpoint): Checkpoint set",
      }),
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", { report: "x" })],
        model: "m",
        stop_reason: "toolUse",
      }),
    ];
    const tool = rewindTool({ getState: () => state, db: null, getRunId: () => null });
    await expect(tool.execute("rw1", { report: "x" }, null, null)).rejects.toThrow(/compaction/);
    expect(state.pendingContextRewind).toBeNull();
  });

  test("guard: huge report is bounded to 16k head+tail in the echo and the marker", async () => {
    const { db, runId } = freshDb();
    const state = new AgentState();
    state.messages = [
      new Message({ role: "user", content: "go" }),
      new AssistantMessage({
        content: [toolCall("cp1", "checkpoint", {})],
        model: "m",
        stop_reason: "toolUse",
      }),
      new Message({
        role: "toolResult",
        content: "Checkpoint set",
        tool_call_id: "cp1",
        tool_name: "checkpoint",
      }),
      new AssistantMessage({
        content: [toolCall("rw1", "rewind", {})],
        model: "m",
        stop_reason: "toolUse",
      }),
    ];
    const report = `${"A".repeat(10_000)}MID${"B".repeat(10_000)}`;
    const tool = rewindTool({ getState: () => state, db, getRunId: () => runId });
    const res = await tool.execute("rw1", { report }, null, null);

    const echoed = res.content.map((b) => ("text" in b ? b.text : "")).join("");
    expect(echoed).toContain("chars omitted");
    expect(echoed.length).toBeLessThan(17_000);

    const markers = db.getRunEvents(runId).filter((e) => e.type === CONTEXT_REWIND_EVENT);
    expect(markers).toHaveLength(1);
    const payload = JSON.parse(markers[0]!.payload) as Record<string, unknown>;
    expect(String(payload.report).length).toBeLessThanOrEqual(16_000);
    expect(payload.report_chars).toBe(report.length);

    expect(state.pendingContextRewind).toEqual({
      anchorToolCallId: "cp1",
      rewindToolCallId: "rw1",
    });
    db.close();
  });

  test("guard: with the flag off the dispatcher rejects the unregistered tool", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("c1", "checkpoint", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const agent = new Agent({ model: reg.getModel(), tools: [probeTool()] });
    registerContextRewindTools(agent.agentState.tools, false, toolDeps(agent, null, null));
    await agent.prompt("go");

    const cp = toolResults(agent.agentState.messages, "checkpoint");
    expect(cp).toHaveLength(1);
    expect(cp[0]!.is_error).toBe(true);
    expect(cp[0]!.textContent).toContain("Unknown tool: checkpoint");

    reg.unregister();
  });
});

function findRewindAnchorStillLive(agent: Agent): boolean {
  const cp = toolResults(agent.agentState.messages, "checkpoint");
  return cp.length === 1 && !cp[0]!.is_error;
}

describe("MINIMA_TUI_REWIND flag (AC4)", () => {
  test("flag: contextRewind defaults ON; =0 opts out; =1 stays on", () => {
    withEnv({ MINIMA_TUI_REWIND: undefined }, () => {
      expect(configFromEnv().contextRewind).toBe(true);
    });
    withEnv({ MINIMA_TUI_REWIND: "0" }, () => {
      expect(configFromEnv().contextRewind).toBe(false);
    });
    withEnv({ MINIMA_TUI_REWIND: "1" }, () => {
      expect(configFromEnv().contextRewind).toBe(true);
    });
  });

  test("flag: registration helper leaves the roster unchanged when off", () => {
    const deps: ContextRewindDeps = {
      getState: () => new AgentState(),
      db: null,
      getRunId: () => null,
    };
    const off: AgentTool[] = [probeTool()];
    registerContextRewindTools(off, false, deps);
    expect(off.map((t) => t.name)).toEqual(["probe"]);

    const on: AgentTool[] = [probeTool()];
    registerContextRewindTools(on, true, deps);
    expect(on.map((t) => t.name)).toEqual(["probe", "checkpoint", "rewind"]);
    expect(checkpointTool(deps).name).toBe("checkpoint");
    expect(rewindTool(deps).name).toBe("rewind");
  });
});
