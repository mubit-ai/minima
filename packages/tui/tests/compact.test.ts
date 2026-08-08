import { describe, expect, test } from "bun:test";
import { AssistantMessage, Message, Usage, text } from "../src/ai/types.ts";
import type { HarnessConfig } from "../src/minima/config.ts";
import type { MinimaAgent } from "../src/minima/runtime.ts";
import { compactMessages, compactReport, maybeAutoCompact } from "../src/tui/compact.ts";
import { AUTO_COMPACT_PCT, contextUsage } from "../src/tui/context_meter.ts";

function msg(role: "user" | "assistant", content: string): Message {
  return new Message({ role, content });
}

function convo(n: number, size = 40): Message[] {
  return Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"x".repeat(size)}`),
  );
}

/** A reply carrying provider-reported usage — what makes a message an anchor. */
function reply(u: Partial<Pick<Usage, "input" | "output" | "cache_read">>): AssistantMessage {
  return new AssistantMessage({ content: [text("ok")], usage: new Usage(u) });
}

function fakeAgent(
  messages: Message[],
  contextWindow: number | null,
  config?: Partial<HarnessConfig>,
): MinimaAgent {
  return {
    agentState: {
      messages,
      model: contextWindow === null ? null : { context_window: contextWindow },
    },
    ...(config ? { config } : {}),
  } as unknown as MinimaAgent;
}

const agent = fakeAgent([], 100000);

describe("compactMessages trigger (KEEP_RECENT + 2)", () => {
  test("8 messages or fewer are returned unchanged (identity — nothing to compact)", () => {
    for (const n of [0, 1, 7, 8]) {
      const messages = convo(n);
      expect(compactMessages(agent, messages)).toBe(messages);
    }
  });

  test("9 messages compact to a summary + the 6 most recent", () => {
    const messages = convo(9);
    const out = compactMessages(agent, messages);
    expect(out).toHaveLength(7);
    expect(out[0]!.textContent).toContain("[Compacted 3 messages]");
    expect(out.slice(1)).toEqual(messages.slice(-6));
  });
});

describe("maybeAutoCompact threshold (80% of the context window)", () => {
  test("under 80% estimated usage: no compaction", () => {
    // 10 msgs × ~45 chars ≈ 115 tokens ≈ 11.5% of 1000.
    const messages = convo(10);
    const a = fakeAgent(messages, 1000);
    expect(maybeAutoCompact(a)).toBe(false);
    expect(a.agentState.messages).toBe(messages);
  });

  test("at/over 80% estimated usage: compacts and reports true", () => {
    // 10 msgs × ~440 chars ≈ 1101 tokens > 80% of 1000.
    const messages = convo(10, 435);
    const a = fakeAgent(messages, 1000);
    expect(maybeAutoCompact(a)).toBe(true);
    expect(a.agentState.messages).toHaveLength(7);
  });

  test("over threshold but too few messages to compact: false, unchanged", () => {
    const messages = convo(4, 2000);
    const a = fakeAgent(messages, 1000);
    expect(maybeAutoCompact(a)).toBe(false);
    expect(a.agentState.messages).toBe(messages);
  });

  test("no model context window: never compacts", () => {
    const a = fakeAgent(convo(20, 2000), null);
    expect(maybeAutoCompact(a)).toBe(false);
  });
});

describe("maybeAutoCompact reads the same basis as the footer", () => {
  test("a cached prompt that chars/4 cannot see now fires compaction", () => {
    // 11 messages of ~45 chars ≈ 116 estimated tokens — 11.6% of 1000, nowhere near the gate.
    // The reply reports a 900-token prompt the transcript never contained: the system prompt,
    // the tool schemas and the cached prefix. That is the context the next request will carry.
    const messages = [...convo(10), reply({ input: 300, cache_read: 600, output: 20 })];
    const a = fakeAgent(messages, 1000);
    expect(maybeAutoCompact(a)).toBe(true);
    expect(a.agentState.messages.length).toBeLessThan(messages.length);
  });

  test("the footer's red threshold and the trigger cannot disagree", () => {
    // What the status bar paints red is exactly what compacts: same quantity, same constant.
    for (const input of [100, 700, 799, 800, 900, 5_000]) {
      const messages = [...convo(12), reply({ input })];
      const overGate =
        (contextUsage(messages, { fallbackWindow: 1_000 }).pct ?? 0) >= AUTO_COMPACT_PCT;
      expect(maybeAutoCompact(fakeAgent(messages, 1_000))).toBe(overGate);
    }
  });

  test("MINIMA_TUI_CONTEXT_METER=0 restores the chars/4 gate", () => {
    const messages = [...convo(10), reply({ input: 300, cache_read: 600, output: 20 })];
    expect(maybeAutoCompact(fakeAgent(messages, 1000, { contextMeter: false }))).toBe(false);
    // ...and a genuinely large transcript still compacts under the old basis.
    const bulky = convo(10, 435);
    expect(maybeAutoCompact(fakeAgent(bulky, 1000, { contextMeter: false }))).toBe(true);
  });

  test("the denominator stays the ROUTED model's window, not the anchor reply's", () => {
    // Routing re-picks a model per prompt. A stale anchor from a 200k model must not stop a
    // 1k-window next request from compacting.
    const messages = [...convo(10), reply({ input: 900 })];
    expect(maybeAutoCompact(fakeAgent(messages, 200_000))).toBe(false);
    expect(maybeAutoCompact(fakeAgent(messages, 1_000))).toBe(true);
  });
});

describe("compactReport (MUB-170: the /compact line is session-derived, not canned)", () => {
  test("reports the estimated token delta, not just the constant message count", () => {
    const before = convo(20, 400);
    const after = compactMessages(agent, before);
    const report = compactReport(before, after);
    expect(report).toContain("tokens");
    expect(report).toContain("20 → 7 messages");
    expect(report).toMatch(/\d+% freed/);
  });

  test("varies with the session content", () => {
    const small = convo(9, 30);
    const large = convo(40, 900);
    const a = compactReport(small, compactMessages(agent, small));
    const b = compactReport(large, compactMessages(agent, large));
    expect(a).not.toBe(b);
  });

  test("identity result reads as nothing-to-compact", () => {
    const messages = convo(5);
    const report = compactReport(messages, compactMessages(agent, messages));
    expect(report).toContain("Nothing to compact");
    expect(report).toContain("5 messages");
  });
});

describe("compactMessages never orphans a tool_result", () => {
  function toolResult(id: string): Message {
    return new Message({
      role: "toolResult",
      content: `result ${id}`,
      tool_call_id: id,
      tool_name: "bash",
    });
  }

  /** n plain turns, then one assistant that fanned out `fan` parallel tool calls. */
  function convoEndingInToolRound(n: number, fan: number): Message[] {
    return [
      ...convo(n),
      msg("assistant", "calling tools"),
      ...Array.from({ length: fan }, (_, i) => toolResult(`call_${i}`)),
    ];
  }

  test("the kept window never STARTS with a tool result (single call)", () => {
    for (let fan = 1; fan <= 8; fan++) {
      for (let n = 9; n <= 16; n++) {
        const messages = convoEndingInToolRound(n, fan);
        const out = compactMessages(agent, messages);
        // out[0] is the summary; the replayed tail begins at out[1].
        expect(out[1]!.role).not.toBe("toolResult");
      }
    }
  });

  test("the owning assistant is kept alongside its results, not summarized away", () => {
    // 6 trailing messages = 1 assistant + 5 results: the naive slice(-6) lands mid-round.
    const messages = convoEndingInToolRound(10, 6);
    const out = compactMessages(agent, messages);
    const tail = out.slice(1);
    const firstResult = tail.findIndex((m) => m.role === "toolResult");
    expect(firstResult).toBeGreaterThan(0);
    expect(tail[firstResult - 1]!.role).toBe("assistant");
    expect(tail.filter((m) => m.role === "toolResult")).toHaveLength(6);
  });

  test("the kept window is never emptied by a long parallel fan-out", () => {
    const messages = convoEndingInToolRound(10, 20);
    const out = compactMessages(agent, messages);
    expect(out.length).toBeGreaterThan(1);
    expect(out[1]!.role).toBe("assistant");
  });

  test("no message is lost: summary count + kept tail == input", () => {
    const messages = convoEndingInToolRound(12, 4);
    const out = compactMessages(agent, messages);
    const compacted = Number(/\[Compacted (\d+) messages/.exec(out[0]!.textContent)![1]);
    expect(compacted + (out.length - 1)).toBe(messages.length);
  });
});
