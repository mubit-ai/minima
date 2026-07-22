import { describe, expect, test } from "bun:test";
import { Message } from "../src/ai/types.ts";
import type { MinimaAgent } from "../src/minima/runtime.ts";
import { compactMessages, compactReport, maybeAutoCompact } from "../src/tui/compact.ts";

function msg(role: "user" | "assistant", content: string): Message {
  return new Message({ role, content });
}

function convo(n: number, size = 40): Message[] {
  return Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"x".repeat(size)}`),
  );
}

function fakeAgent(messages: Message[], contextWindow: number | null): MinimaAgent {
  return {
    agentState: {
      messages,
      model: contextWindow === null ? null : { context_window: contextWindow },
    },
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
