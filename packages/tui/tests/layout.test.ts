import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  TURN_CHROME,
  computeMsgHeight,
  getScrollableMessages,
  groupMessagesIntoTurns,
  markTurnStarts,
  wrappedLineCount,
} from "../src/tui/layout.ts";

const tool = (text: string): ChatMessage => ({ role: "tool", text, toolName: "t" });
const user = (text: string): ChatMessage => ({ role: "user", text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", text });
const thinking = (text: string): ChatMessage => ({ role: "thinking", text });

describe("wrappedLineCount", () => {
  test(">=1 per source line, wraps at width", () => {
    expect(wrappedLineCount("", 80)).toBe(1);
    expect(wrappedLineCount("a\nb\nc", 80)).toBe(3);
    expect(wrappedLineCount("x".repeat(160), 80)).toBe(2);
  });
  test("floors width at 20 (no divide-by-tiny)", () => {
    expect(wrappedLineCount("x".repeat(40), 5)).toBe(2); // ceil(40/20)
  });
});

describe("computeMsgHeight — conservative, mirrors messages.tsx box model", () => {
  test("multi-line tool message counts header + full body (regression: was hard-coded 1)", () => {
    const body = Array(25).fill("x").join("\n");
    expect(computeMsgHeight(tool(body), 80)).toBe(26); // 1 header + 25 body
  });

  test("tool one-liner is header + one body row", () => {
    expect(computeMsgHeight(tool("done"), 80)).toBe(2);
  });

  test("thinking: 5 chrome + body wrapped at cols-8", () => {
    // 200 chars at cols=80 => cols-8=72 => ceil(200/72)=3; +5 chrome = 8
    expect(computeMsgHeight(thinking("x".repeat(200)), 80)).toBe(8);
  });

  test("assistant: 3 chrome + 1 per '#' heading + wrapped body", () => {
    // "## A","x","## B","y" => 2 headings, 4 body lines => 3 + 2 + 4 = 9
    expect(computeMsgHeight(assistant("## A\nx\n## B\ny"), 80)).toBe(9);
  });

  test("user: counts marginBottom + header + padded body width", () => {
    // 76-char line, interior 76, padded to 78 => ceil(78/76)=2 body; +2 chrome = 4
    expect(computeMsgHeight(user("x".repeat(76)), 80)).toBe(4);
  });

  test("every role has a positive minimum even for empty text", () => {
    for (const m of [tool(""), user(""), assistant(""), thinking("")]) {
      expect(computeMsgHeight(m, 80)).toBeGreaterThanOrEqual(2);
    }
  });

  test("narrow terminal is safe (width floored at 20)", () => {
    expect(computeMsgHeight(tool("abc"), 20)).toBe(2);
  });
});

describe("markTurnStarts / groupMessagesIntoTurns agree on turn count", () => {
  const cases: ChatMessage[][] = [
    [tool("a"), user("q"), assistant("r"), user("q2")],
    [tool("a"), tool("b"), user("q"), tool("c")],
    [user("q"), assistant("r")],
    [],
  ];
  for (const msgs of cases) {
    test(`case len=${msgs.length}`, () => {
      const starts = markTurnStarts(msgs).filter(Boolean).length;
      expect(starts).toBe(groupMessagesIntoTurns(msgs).length);
    });
  }

  test("each leading orphan is its own turn", () => {
    const msgs = [tool("a"), tool("b"), user("q")];
    expect(markTurnStarts(msgs)).toEqual([true, true, true]);
    expect(groupMessagesIntoTurns(msgs)).toHaveLength(3);
  });
});

describe("getScrollableMessages", () => {
  test("empty list", () => {
    expect(getScrollableMessages([], 20, 0, 80)).toEqual({
      visible: [],
      totalHeight: 0,
      atTop: true,
      atBottom: true,
    });
  });

  test("everything fits => all visible, at top AND bottom", () => {
    const msgs = [user("q"), assistant("short")];
    const w = getScrollableMessages(msgs, 100, 0, 80);
    expect(w.visible).toHaveLength(2);
    expect(w.atBottom).toBe(true);
    expect(w.atTop).toBe(true);
  });

  test("totalHeight includes per-turn chrome", () => {
    const msgs = [user("q"), assistant("r")]; // one turn
    const w = getScrollableMessages(msgs, 100, 0, 80);
    const bare = computeMsgHeight(msgs[0]!, 80) + computeMsgHeight(msgs[1]!, 80);
    expect(w.totalHeight).toBe(bare + TURN_CHROME); // +3 for the turn box
  });

  test("offset 0 pins to the newest (includes last message, atBottom)", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => user(`q${i}`));
    const w = getScrollableMessages(msgs, 12, 0, 80);
    expect(w.atBottom).toBe(true);
    expect(w.visible.at(-1)).toBe(msgs.at(-1)!);
  });

  test("huge offset clamps to the oldest (includes first message, atTop, in-range)", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => user(`q${i}`));
    const w = getScrollableMessages(msgs, 12, 99999, 80);
    expect(w.atTop).toBe(true);
    expect(w.visible[0]).toBe(msgs[0]!);
    // never returns undefined slots
    expect(w.visible.every(Boolean)).toBe(true);
  });

  test("a single message taller than the budget is still returned whole (region clips it)", () => {
    const tall = tool(Array(30).fill("line").join("\n"));
    const w = getScrollableMessages([tall], 10, 0, 80);
    expect(w.visible).toHaveLength(1);
    expect(w.atBottom).toBe(true);
  });

  test("the fitting part of the window never estimates over budget", () => {
    // Excluding at most one straddling top message, the visible rows must fit maxHeight.
    const msgs = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? user(`q${i}`) : assistant(`answer number ${i} with some length`),
    );
    const maxHeight = 20;
    const w = getScrollableMessages(msgs, maxHeight, 0, 80);
    const starts = markTurnStarts(msgs);
    const idx = msgs.indexOf(w.visible[0]!);
    // Sum heights of visible messages after the (possibly clipped) first one.
    let rows = 0;
    for (let k = 1; k < w.visible.length; k++) {
      const j = idx + k;
      rows += computeMsgHeight(msgs[j]!, 80) + (starts[j] ? TURN_CHROME : 0);
    }
    expect(rows).toBeLessThanOrEqual(maxHeight);
  });
});
