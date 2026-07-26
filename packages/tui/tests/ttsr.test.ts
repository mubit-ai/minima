/**
 * W4.2 / MUB-204 — TTSR stream tripwire rules (abort → inject → retry).
 *
 * Hermetic: a scripted StreamFnLike (per-attempt deltas + result, records call count and
 * per-attempt teardown) drives the loop with no provider, no server, no DB. Rules are injected
 * via AgentOptions.ttsr = compileTtsr([...]) so the loop-level behavior is exercised directly.
 */

import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentTool, type StreamFnLike } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  Usage,
  isAssistant,
  text,
  textDelta,
  toolCall,
} from "../src/ai/index.ts";
import { Message } from "../src/ai/types.ts";
import { classifyRungOutput } from "../src/minima/replay_guard.ts";
import type { MinimaAgent } from "../src/minima/runtime.ts";
import { TTSR_REMINDER_PREFIX, compileTtsr, isTtsrReminder } from "../src/minima/ttsr.ts";
import { compactMessages } from "../src/tui/compact.ts";

const MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

interface Attempt {
  deltas: string[];
  result: AssistantMessage;
}
interface StreamRec {
  calls: number;
  returned: boolean[];
  signals: (AbortSignal | undefined)[];
}

/** A stateful scripted stream: each call shifts the next attempt, streams its text deltas one at
 * a time, then reports done; result() returns the attempt's final message. return() records the
 * teardown of that attempt's iterator (the tripwire abort path). */
function scriptedStreamFn(attempts: Attempt[], rec: StreamRec): StreamFnLike {
  return (_model, _ctx, opts) => {
    const idx = rec.calls;
    rec.calls += 1;
    rec.returned.push(false);
    rec.signals.push(opts?.signal);
    const attempt = attempts[idx] ?? attempts[attempts.length - 1]!;
    let i = 0;
    const iter = {
      async next(): Promise<IteratorResult<unknown>> {
        if (i < attempt.deltas.length) {
          const d = attempt.deltas[i]!;
          i += 1;
          return { done: false, value: textDelta(d, 0) };
        }
        return { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<unknown>> {
        rec.returned[idx] = true;
        return { done: true, value: undefined };
      },
    };
    return {
      result: async () => attempt.result,
      [Symbol.asyncIterator]: () => iter,
    };
  };
}

function asst(t: string, usage?: Usage): AssistantMessage {
  return new AssistantMessage({ content: [text(t)], model: "faux", usage });
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    return undefined;
  });
  return events;
}

describe("TTSR abort → inject → retry", () => {
  test("AC1 mid-stream match aborts, injects the reminder, retry completes clean", async () => {
    const attempts: Attempt[] = [
      { deltas: ["about to run rm -rf / to reset"], result: asst("SHOULD BE DISCARDED") },
      { deltas: ["a safe, clean answer"], result: asst("a safe, clean answer") },
    ];
    const rec: StreamRec = { calls: 0, returned: [], signals: [] };
    const agent = new Agent({
      model: MODEL,
      streamFn: scriptedStreamFn(attempts, rec),
      ttsr: compileTtsr([{ id: "root", pattern: /rm -rf \//, reminder: "no destructive root deletes" }]),
    });
    const events = collect(agent);
    await agent.prompt("go");

    expect(rec.calls).toBe(2); // attempt-1 aborted, attempt-2 is the retry
    expect(rec.returned[0]).toBe(true); // attempt-1 provider iterator torn down

    const committed = agent.agentState.messages;
    const assistants = committed.filter(isAssistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("a safe, clean answer"); // the clean retry, not the partial

    const reminderIdx = committed.findIndex(
      (m) => m.role === "user" && isTtsrReminder(m.textContent),
    );
    const assistantIdx = committed.findIndex((m) => m.role === "assistant");
    expect(reminderIdx).toBeGreaterThanOrEqual(0);
    expect(reminderIdx).toBeLessThan(assistantIdx); // reminder precedes the final assistant
    expect(committed[reminderIdx]!.textContent).toContain("no destructive root deletes");

    // Exactly one discard (message_end with a null message) — the aborted partial.
    const discards = events.filter((e) => e.type === "message_end" && e.message === null);
    expect(discards).toHaveLength(1);
  });

  test("AC2 armed-but-non-matching is byte-identical to flag-off (differential)", async () => {
    const run = async (armed: boolean) => {
      const attempts: Attempt[] = [
        { deltas: ["a", " perfectly", " ordinary", " answer"], result: asst("a perfectly ordinary answer") },
      ];
      const rec: StreamRec = { calls: 0, returned: [], signals: [] };
      const agent = new Agent({
        model: MODEL,
        streamFn: scriptedStreamFn(attempts, rec),
        ...(armed
          ? { ttsr: compileTtsr([{ id: "never", pattern: /THIS_NEVER_APPEARS/, reminder: "x" }]) }
          : {}),
      });
      const events = collect(agent);
      await agent.prompt("go");
      return {
        rec,
        types: events.map((e) => e.type),
        committed: agent.agentState.messages.map((m) => `${m.role}:${m.textContent}`),
        events,
      };
    };

    const armed = await run(true);
    const off = await run(false);
    expect(armed.rec.calls).toBe(1); // no retry
    expect(armed.types).toEqual(off.types); // identical event sequence
    expect(armed.committed).toEqual(off.committed); // identical committed messages
    expect(armed.events.some((e) => e.type === "message_end" && e.message === null)).toBe(false);
  });

  test("AC4 the discarded partial's usage is never booked (no double-count)", async () => {
    const attempts: Attempt[] = [
      { deltas: ["rm -rf / now"], result: asst("discarded", new Usage({ output: 999 })) },
      { deltas: ["safe reply"], result: asst("safe reply", new Usage({ output: 42 })) },
    ];
    const rec: StreamRec = { calls: 0, returned: [], signals: [] };
    const agent = new Agent({
      model: MODEL,
      streamFn: scriptedStreamFn(attempts, rec),
      ttsr: compileTtsr([{ id: "root", pattern: /rm -rf \//, reminder: "no" }]),
    });
    await agent.prompt("go");

    const assistants = agent.agentState.messages.filter(isAssistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.usage.output).toBe(42); // only the retry booked; 999 never entered
  });

  test("AC5 per-rule cap bounds retries and the turn terminates", async () => {
    // retryCap 1 → fires once → 2 streams, ttsrRetries 1
    {
      const attempts: Attempt[] = [
        { deltas: ["TRIP"], result: asst("x") },
        { deltas: ["TRIP again, but the cap is reached"], result: asst("done") },
      ];
      const rec: StreamRec = { calls: 0, returned: [], signals: [] };
      const agent = new Agent({
        model: MODEL,
        streamFn: scriptedStreamFn(attempts, rec),
        ttsr: compileTtsr([{ id: "r", pattern: /TRIP/, reminder: "stop", retryCap: 1 }]),
      });
      await agent.prompt("go");
      expect(rec.calls).toBe(2);
      expect(agent.agentState.ttsrRetries).toBe(1);
      expect(agent.agentState.messages.filter(isAssistant)).toHaveLength(1);
    }
    // retryCap 2 → fires twice → 3 streams
    {
      const attempts: Attempt[] = [
        { deltas: ["TRIP"], result: asst("x") },
        { deltas: ["TRIP"], result: asst("y") },
        { deltas: ["TRIP, but the cap is reached"], result: asst("done") },
      ];
      const rec: StreamRec = { calls: 0, returned: [], signals: [] };
      const agent = new Agent({
        model: MODEL,
        streamFn: scriptedStreamFn(attempts, rec),
        ttsr: compileTtsr([{ id: "r", pattern: /TRIP/, reminder: "stop", retryCap: 2 }]),
      });
      await agent.prompt("go");
      expect(rec.calls).toBe(3);
      expect(agent.agentState.ttsrRetries).toBe(2);
    }
  });

  test("AC6 an effectful rung is never replayed (replay-guard non-interference)", async () => {
    // (a) classifyRungOutput is unchanged — a toolResult in the window is still effectful.
    const tr = new Message({ role: "toolResult", tool_call_id: "c1", tool_name: "t", content: [text("r")] });
    const asstText = new AssistantMessage({ content: [text("hi")] });
    const asstEmpty = new AssistantMessage({ content: [], stop_reason: "error" });
    expect(classifyRungOutput([asstText, tr], 0)).toBe("effectful");
    expect(classifyRungOutput([asstText], 0)).toBe("text_only");
    expect(classifyRungOutput([asstEmpty], 0)).toBe("clean");

    // (b) attempt-1 streams tripwire text THEN would emit a tool-call block; the trip fires on
    // the text, so result() is never drained and the tool never dispatches on the aborted rung.
    let executed = 0;
    const tool: AgentTool = {
      name: "danger",
      description: "d",
      parameters: {
        jsonSchema: { type: "object", properties: {} },
        validate: (v) => ({ ok: true, value: (v ?? {}) as Record<string, unknown> }),
      },
      async execute() {
        executed += 1;
        return { content: [text("ran")] };
      },
    };
    const attempts: Attempt[] = [
      {
        deltas: ["I will just rm -rf / to clean up first"],
        result: new AssistantMessage({ content: [toolCall("c1", "danger", {})], stop_reason: "toolUse" }),
      },
      {
        deltas: ["running the tool safely now"],
        result: new AssistantMessage({ content: [toolCall("c2", "danger", {})], stop_reason: "toolUse" }),
      },
      { deltas: ["final answer"], result: asst("final answer") },
    ];
    const rec: StreamRec = { calls: 0, returned: [], signals: [] };
    const agent = new Agent({
      model: MODEL,
      tools: [tool],
      streamFn: scriptedStreamFn(attempts, rec),
      ttsr: compileTtsr([{ id: "root", pattern: /rm -rf \//, reminder: "no root deletes" }]),
    });
    await agent.prompt("go");

    expect(executed).toBe(1); // once, after the clean retry — never on the aborted attempt
    expect(agent.agentState.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  test("AC7 an injected reminder survives compaction verbatim", () => {
    const longReminder = `${TTSR_REMINDER_PREFIX} ${"do not delete the root filesystem; ".repeat(10)}`;
    expect(longReminder.length).toBeGreaterThan(200);
    const messages: Message[] = [
      new Message({ role: "user", content: "start" }),
      new Message({ role: "user", content: longReminder }), // lands in the old (compacted) window
      ...Array.from({ length: 10 }, (_, i) =>
        new Message({ role: i % 2 === 0 ? "assistant" : "user", content: `turn ${i}` }),
      ),
    ];
    const out = compactMessages({} as unknown as MinimaAgent, messages);

    const joined = out.map((m) => m.textContent).join("\n");
    expect(joined).toContain(longReminder); // verbatim, not 200-char truncated into the summary

    const preserved = out.find((m) => isTtsrReminder(m.textContent));
    expect(preserved).toBeDefined();
    expect(preserved!.textContent).toBe(longReminder); // its own active-context message
  });

  test("a trigger straddling two deltas still fires", async () => {
    const attempts: Attempt[] = [
      { deltas: ["rm -rf", " /"], result: asst("discarded") },
      { deltas: ["clean"], result: asst("clean") },
    ];
    const rec: StreamRec = { calls: 0, returned: [], signals: [] };
    const agent = new Agent({
      model: MODEL,
      streamFn: scriptedStreamFn(attempts, rec),
      ttsr: compileTtsr([{ id: "root", pattern: /rm -rf \//, reminder: "no" }]),
    });
    await agent.prompt("go");
    expect(rec.calls).toBe(2);
    expect(agent.agentState.messages.filter(isAssistant)[0]!.textContent).toBe("clean");
  });
});
