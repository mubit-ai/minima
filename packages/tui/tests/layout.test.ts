import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  TOOL_PREVIEW_HEAD,
  TOOL_PREVIEW_TAIL,
  TURN_CHROME,
  collapseToolText,
  computeMsgHeight,
  getScrollableMessages,
  groupMessagesIntoTurns,
  markTurnStarts,
  pagerSlice,
  stripControl,
  toolDisplayText,
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

describe("collapseToolText — display-only head/tail preview", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join("\n");

  test("short output is returned unchanged (nothing worth hiding)", () => {
    const short = lines(TOOL_PREVIEW_HEAD + TOOL_PREVIEW_TAIL + 1); // hides exactly 1 => no saving
    expect(collapseToolText(short)).toBe(short);
  });

  test("long output collapses to head + marker + tail", () => {
    const total = 100;
    const out = collapseToolText(lines(total)).split("\n");
    const hidden = total - TOOL_PREVIEW_HEAD - TOOL_PREVIEW_TAIL;
    expect(out).toHaveLength(TOOL_PREVIEW_HEAD + 1 + TOOL_PREVIEW_TAIL);
    expect(out[0]).toBe("L0");
    expect(out[TOOL_PREVIEW_HEAD]).toBe(`… ${hidden} more lines`);
    expect(out.at(-1)).toBe(`L${total - 1}`); // last line (e.g. [exit 0]) always survives
  });

  test("custom head/tail honoured", () => {
    expect(collapseToolText(lines(20), 2, 2).split("\n")).toEqual([
      "L0",
      "L1",
      "… 16 more lines",
      "L18",
      "L19",
    ]);
  });

  test("toolDisplayText collapses only when collapsible is set", () => {
    const body = lines(100);
    expect(toolDisplayText({ role: "tool", text: body, collapsible: true })).toBe(
      collapseToolText(body),
    );
    expect(toolDisplayText({ role: "tool", text: body })).toBe(body);
  });

  test("computeMsgHeight mirrors the collapsed render for collapsible tools", () => {
    const body = lines(100);
    const collapsed: ChatMessage = { role: "tool", text: body, collapsible: true };
    const full: ChatMessage = { role: "tool", text: body };
    // collapsible: 1 header + (HEAD + 1 marker + TAIL) rows; full: 1 header + 100 rows.
    expect(computeMsgHeight(collapsed, 80)).toBe(1 + TOOL_PREVIEW_HEAD + 1 + TOOL_PREVIEW_TAIL);
    expect(computeMsgHeight(full, 80)).toBe(1 + 100);
  });
});

describe("stripControl — sanitizes terminal output for display", () => {
  test("removes ANSI colour/cursor escapes but keeps the text", () => {
    expect(stripControl("\x1b[31mred\x1b[0m\x1b[2Kx")).toBe("redx");
  });

  test("removes carriage returns (the overwrite/overlap cause) and DEL/C0, keeps \\n and \\t", () => {
    expect(stripControl("a\r\nb\tc\x07\x00\x7f")).toBe("a\nb\tc");
  });

  test("plain text is unchanged", () => {
    expect(stripControl("hello\nworld [exit 0]")).toBe("hello\nworld [exit 0]");
  });

  test("toolDisplayText sanitizes before collapsing", () => {
    const msg = { role: "tool" as const, text: "\x1b[32mok\x1b[0m\r\ndone", collapsible: true };
    expect(toolDisplayText(msg)).toBe("ok\ndone");
  });
});

describe("pagerSlice — Ctrl+O output pager windowing", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join("\n");

  test("never returns more than bodyRows lines (stays inside the frame)", () => {
    const v = pagerSlice(lines(100), 30, 0);
    expect(v.lines).toHaveLength(30);
    expect(v.total).toBe(100);
  });

  test("scroll 0 pins to the bottom (latest output / exit line)", () => {
    const v = pagerSlice(lines(100), 30, 0);
    expect(v.atBottom).toBe(true);
    expect(v.lines.at(-1)).toBe("L99");
    expect(v.end).toBe(100);
  });

  test("scrolling up walks toward the top and clamps at the first line", () => {
    const up = pagerSlice(lines(100), 30, 40);
    expect(up.atBottom).toBe(false);
    expect(up.lines.at(-1)).toBe("L59"); // 100 - 40 - 1

    const top = pagerSlice(lines(100), 30, 99999);
    expect(top.atTop).toBe(true);
    expect(top.start).toBe(0);
    expect(top.lines[0]).toBe("L0");
  });

  test("short output fits whole — at top AND bottom", () => {
    const v = pagerSlice(lines(5), 30, 0);
    expect(v.lines).toHaveLength(5);
    expect(v.atTop).toBe(true);
    expect(v.atBottom).toBe(true);
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
