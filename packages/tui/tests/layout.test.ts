import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  MAX_TOOL_LINES,
  SCROLLBACK_SAFETY_ROWS,
  clampToolText,
  computeMsgHeight,
  getScrollableMessages,
  markdownBodyHeight,
  streamTailBudget,
  tailToFit,
  wrappedLineCount,
} from "../src/tui/layout.ts";

const asst = (text: string): ChatMessage => ({ role: "assistant", text });
const user = (text: string): ChatMessage => ({ role: "user", text });
const tool = (text: string, toolName = "bash"): ChatMessage => ({ role: "tool", text, toolName });
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
  test("counts wide chars (CJK) as 2 display columns, not UTF-16 length", () => {
    // "你" has String.length 1 but display width 2. 15 chars = 30 cols → 2 rows at width 20
    // (a naive length-based count would say 1 row and under-reserve → overflow).
    expect(wrappedLineCount("你".repeat(15), 20)).toBe(2);
    expect(wrappedLineCount("你".repeat(25), 20)).toBe(3); // 50 cols / 20
  });
  test("word-wraps like Ink (not char-wrap): unpacked words take extra rows", () => {
    // Three 11-col words at width 20 can't pack (11 + 1 + 11 = 23 > 20) → 3 rows. A char-based
    // ceil(35/20) would say 2 and under-reserve — the exact undercount that garbled the render.
    const line = `${"A".repeat(11)} ${"B".repeat(11)} ${"C".repeat(11)}`;
    expect(wrappedLineCount(line, 20)).toBe(3);
  });
});

describe("markdownBodyHeight — mirrors MarkdownRenderer expansion", () => {
  test("a heading costs a marginTop row plus its wrapped text", () => {
    expect(markdownBodyHeight("# Title", 80)).toBe(2); // 1 marginTop + 1 text
  });
  test("a plain paragraph wraps at the full interior width", () => {
    // three 11-col words at interior 24 pack two per row (11 + 1 + 11 = 23 <= 24) → 2 rows
    const p = `${"A".repeat(11)} ${"B".repeat(11)} ${"C".repeat(11)}`;
    expect(markdownBodyHeight(p, 24)).toBe(2);
  });
  test("a list item wraps at the narrower interior-4 (marginLeft 2 + bullet 2)", () => {
    // same three words as a "- " list item → width 20 → they no longer pack → 3 rows
    const li = `- ${"A".repeat(11)} ${"B".repeat(11)} ${"C".repeat(11)}`;
    expect(markdownBodyHeight(li, 24)).toBe(3);
  });
  test("is >= the flat wrapped count (headings/lists only ADD rows) — the streaming invariant", () => {
    // Regression: the streaming reservation used a flat wrappedLineCount and under-reserved
    // headings, fusing "◆ assistant" with stale streamed text. Both paths now use this helper.
    const md = "## Places\n1. Chin Chin\n2. Amorino\n- a bullet line here";
    expect(markdownBodyHeight(md, 80)).toBeGreaterThanOrEqual(wrappedLineCount(md, 76));
  });
});

describe("streamTailBudget — keeps the live region below the terminal height", () => {
  test("reserved + streaming preview never exceeds rows - safety (Ink's scrollback-wipe guard)", () => {
    // If the live frame height reaches `rows`, Ink emits clearTerminal (CSI 3J) and wipes the
    // terminal scrollback — destroying the <Static> transcript. The budget must keep the whole
    // live frame strictly below `rows`; a breach here would re-introduce that data loss.
    for (let rows = 24; rows <= 60; rows += 4) {
      for (let reserved = 8; reserved <= 22; reserved += 2) {
        expect(reserved + streamTailBudget(rows, reserved)).toBeLessThanOrEqual(
          rows - SCROLLBACK_SAFETY_ROWS,
        );
      }
    }
  });
  test("never negative; a cramped terminal drops the preview rather than overflow", () => {
    expect(streamTailBudget(20, 25)).toBe(0);
    expect(streamTailBudget(10, 10)).toBe(0);
  });
  test("allots the remaining rows on a roomy terminal", () => {
    expect(streamTailBudget(40, 16)).toBe(40 - 16 - SCROLLBACK_SAFETY_ROWS); // 22
  });
});

describe("computeMsgHeight — mirrors MessageRow, conservative (>= actual)", () => {
  test("a short assistant line = marginTop + header + 1 body row", () => {
    expect(computeMsgHeight(asst("hello"), 80)).toBe(3); // 1 + 1 + markdownBodyHeight("hello")=1
  });
  test("a short user line = marginTop + header + 1 body row", () => {
    expect(computeMsgHeight(user("hi"), 80)).toBe(3);
  });
  test("a markdown heading adds its marginTop row (>= the flat wrapped count)", () => {
    const h = computeMsgHeight(asst("# Title\nbody text here"), 80);
    expect(h).toBeGreaterThanOrEqual(2 + wrappedLineCount("# Title\nbody text here", 80));
  });
  test("a huge tool body is bounded by the MAX_TOOL_LINES clamp (+ chrome + hint)", () => {
    const body = Array(200).fill("x").join("\n");
    // header(1) + marginTop(1) + clamped rows (<= MAX_TOOL_LINES) + "+N more" hint(1)
    expect(computeMsgHeight({ role: "tool", text: body }, 80)).toBeLessThanOrEqual(
      2 + MAX_TOOL_LINES + 1,
    );
  });
  test("the irreducible chrome floor per role (empty body still renders header + margin)", () => {
    // A clipped boundary message can never shrink below this — the fullscreen clip must account for
    // it or a sub-floor slot overflows the viewport (the scroll garble). thinking is 5 (border adds 2).
    expect(computeMsgHeight(user(""), 80)).toBe(3); // marginTop + "▸ you" + 1 body
    expect(computeMsgHeight(tool(""), 80)).toBe(3); // marginTop + "⚙ …:" + 1 body
    expect(computeMsgHeight(asst(""), 80)).toBe(3); // marginTop + "◆ assistant" + 1 body
    expect(computeMsgHeight(thinking(""), 80)).toBe(5); // marginTop + border(2) + header + 1 body
  });
});

describe("getScrollableMessages — windows the transcript for the fullscreen viewport", () => {
  test("empty transcript is at both top and bottom", () => {
    const w = getScrollableMessages([], 10, 0, 80);
    expect(w.visible).toEqual([]);
    expect(w.atTop).toBe(true);
    expect(w.atBottom).toBe(true);
  });
  test("offset 0 pins to the newest content; the newest message is shown whole", () => {
    const msgs = [asst("A"), asst("B"), asst("C")];
    const w = getScrollableMessages(msgs, 5, 0, 80);
    expect(w.totalHeight).toBe(9);
    expect(w.atBottom).toBe(true);
    expect(w.atTop).toBe(false);
    expect(w.visible.at(-1)?.text).toBe("C"); // newest untrimmed at the bottom
  });
  test("a large offset clamps to the top; the oldest message is shown whole", () => {
    const msgs = [asst("A"), asst("B"), asst("C")];
    const w = getScrollableMessages(msgs, 5, 9999, 80);
    expect(w.atTop).toBe(true);
    expect(w.atBottom).toBe(false);
    expect(w.visible[0]?.text).toBe("A"); // oldest untrimmed at the top
  });
  test("a message taller than the viewport is fold-clipped so the window never overflows", () => {
    // The garble class: a single child taller than the overflow:hidden flex-end box. Trimming the
    // fold keeps the rendered window <= maxHeight, so nothing overflows.
    const tall = asst(Array.from({ length: 40 }, (_, i) => String(i + 1)).join("\n"));
    const w = getScrollableMessages([tall], 12, 0, 80);
    const rendered = w.visible.reduce((n, m) => n + computeMsgHeight(m, 80), 0);
    expect(rendered).toBeLessThanOrEqual(12);
    expect(w.atBottom).toBe(true);
  });

  // A mixed transcript hitting every clip trap: a 1-line bash tool (the chrome-floor / "helloash"
  // collision), a tool with one very long WRAPPED url line (source-line vs rendered-row over-trim),
  // markdown headings + lists, a thinking block (floor 5), short user lines, and one assistant taller
  // than the whole viewport (clipped on both folds).
  const mixed: ChatMessage[] = [
    user("hi"),
    tool("hello"),
    tool(`[1] Result title\nhttps://example.com/${"segment/".repeat(30)}end`, "web_search"),
    asst("# Heading\nsome body text here\n- a bullet item\n- another bullet\nmore trailing text"),
    thinking("reasoning about the problem\na second line of thoughts"),
    user("do it again"),
    asst(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")),
  ];

  test("scroll-sweep: the visible stack never exceeds the viewport at ANY offset (the scroll garble)", () => {
    // This is the core regression. Ink decimates/fuses lines the instant the flex-end viewport's
    // content exceeds its height; before the height-targeted clip, boundary messages re-added chrome
    // that pushed the stack over `maxHeight` at many offsets. Sweep every offset (past the clamp) and
    // assert the rendered stack fits AND no single child alone exceeds the box.
    for (const cols of [40, 80]) {
      const maxHeight = 12;
      const total = getScrollableMessages(mixed, maxHeight, 0, cols).totalHeight;
      const maxOffset = Math.max(0, total - maxHeight);
      for (let off = 0; off <= maxOffset + 5; off++) {
        const w = getScrollableMessages(mixed, maxHeight, off, cols);
        const sum = w.visible.reduce((n, m) => n + computeMsgHeight(m, cols), 0);
        expect(sum).toBeLessThanOrEqual(maxHeight);
        for (const m of w.visible) {
          expect(computeMsgHeight(m, cols)).toBeLessThanOrEqual(maxHeight);
        }
      }
    }
  });

  test("scrolling is monotonic — offset 0 pins the newest, max offset pins the oldest", () => {
    const maxHeight = 12;
    const total = getScrollableMessages(mixed, maxHeight, 0, 80).totalHeight;
    const maxOffset = Math.max(0, total - maxHeight);
    expect(getScrollableMessages(mixed, maxHeight, 0, 80).atBottom).toBe(true);
    expect(getScrollableMessages(mixed, maxHeight, maxOffset, 80).atTop).toBe(true);
    // The oldest message ("hi") is only reachable when scrolled to the top.
    const top = getScrollableMessages(mixed, maxHeight, maxOffset, 80);
    expect(top.visible[0]?.role).toBe("user");
  });
});

describe("clampToolText — bounds huge tool output", () => {
  test("short text is unchanged, nothing hidden", () => {
    const { text, hiddenLines } = clampToolText("a\nb\nc", 80);
    expect(text).toBe("a\nb\nc");
    expect(hiddenLines).toBe(0);
  });
  test("clips beyond MAX_TOOL_LINES and reports the remainder", () => {
    const body = Array(MAX_TOOL_LINES + 12)
      .fill("x")
      .join("\n");
    const { text, hiddenLines } = clampToolText(body, 80);
    expect(text.split("\n").length).toBe(MAX_TOOL_LINES);
    expect(hiddenLines).toBe(12);
  });
  test("clamps by RENDERED rows, not source lines (a long line wraps to many rows)", () => {
    // Each source line is 50 cols wide → wraps to 2 rows at interior 36 (cols 40). 20 lines = 40
    // rendered rows; the 30-row budget keeps 15 lines (30 rows), hiding 5. A source-line clamp
    // would have kept all 20 — this is the bug that let a web result box dwarf the chat region.
    const body = Array(20).fill("x".repeat(50)).join("\n");
    const { text, hiddenLines } = clampToolText(body, 40);
    expect(text.split("\n").length).toBe(15);
    expect(hiddenLines).toBe(5);
  });
  test("always keeps the first line even if it alone exceeds the budget", () => {
    // One 1100-col word wraps to ceil(1100/36) = 31 rows at cols 40 (> the 30-row budget). The
    // first line must still be shown whole (its true tall height is reported honestly), so only
    // the following line is hidden.
    const huge = "x".repeat(1100);
    const { text, hiddenLines } = clampToolText(`${huge}\ntail`, 40);
    expect(text.split("\n")[0]).toBe(huge);
    expect(hiddenLines).toBe(1); // the "tail" line
  });
});

describe("tailToFit budget enforcement", () => {
  test("multi-line text keeps only the newest lines that fit", () => {
    const text = Array(20).fill("line of text").join("\n");
    const out = tailToFit(text, 80, 5);
    expect(out.split("\n").length).toBe(5);
    expect(markdownBodyHeight(out, 80)).toBeLessThanOrEqual(5);
  });
  test("a single huge streamed paragraph is hard-sliced to the row budget", () => {
    // One source line until the model emits "\n": 3000 chars at interior 100 would render
    // ~30 rows. The live region must NEVER exceed its budget (fullscreen garble / inline
    // scrollback-wipe class), so the tail is sliced even though it is the final line.
    const para = "word ".repeat(600).trim();
    const out = tailToFit(para, 100, 10);
    expect(markdownBodyHeight(out, 100)).toBeLessThanOrEqual(10);
    expect(out.length).toBeGreaterThan(0);
    expect(para.endsWith(out)).toBe(true); // it is the TAIL of the stream
  });
  test("budget 1 with a long line still fits one row", () => {
    const out = tailToFit("x".repeat(500), 50, 1);
    expect(markdownBodyHeight(out, 50)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- U2 (MUB-140)

import {
  TOC_MIN_COLS,
  clipPanelLines,
  offsetForMessage,
  tocPanelGeometry,
} from "../src/tui/layout.ts";

describe("offsetForMessage (U2 jump)", () => {
  const many: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
    text: `message ${i}\nline two\nline three`,
  }));

  test("round-trip: the window at the returned offset starts with message k, unclipped", () => {
    const cols = 80;
    const maxHeight = 10;
    for (const k of [0, 3, 6]) {
      const off = offsetForMessage(many, k, maxHeight, cols);
      const win = getScrollableMessages(many, maxHeight, off, cols);
      expect(win.visible[0]!.text).toBe(many[k]!.text); // whole message at the top — no clip
    }
  });

  test("k inside the last page → 0 (pinned-to-newest semantics)", () => {
    expect(offsetForMessage(many, many.length - 1, 10, 80)).toBe(0);
  });

  test("clamps: k=0 lands at maxOffset (top); short transcripts always 0", () => {
    const cols = 80;
    const maxHeight = 10;
    const total = many.reduce((n, m) => n + computeMsgHeight(m, cols), 0);
    expect(offsetForMessage(many, 0, maxHeight, cols)).toBe(total - maxHeight);
    expect(offsetForMessage(many.slice(0, 1), 0, 50, cols)).toBe(0);
  });
});

describe("tocPanelGeometry (U2 chassis)", () => {
  test("null below TOC_MIN_COLS or for regionHeight < 5 → callers use the text fallback", () => {
    expect(tocPanelGeometry(TOC_MIN_COLS - 1, 20)).toBeNull();
    expect(tocPanelGeometry(100, 4)).toBeNull();
  });

  test("width caps at 40, always leaves ≥30 transcript cols; panel spans the full region height", () => {
    const g60 = tocPanelGeometry(60, 20)!;
    expect(g60.width).toBe(30);
    expect(g60.left).toBe(30);
    const g100 = tocPanelGeometry(100, 24)!;
    expect(g100.width).toBe(40);
    expect(g100.left + g100.width).toBe(100);
    expect(g100.height).toBe(24);
    expect(g100.innerWidth).toBe(36);
    expect(g100.innerHeight).toBe(22);
  });

  test("no-reflow invariant: the transcript window is byte-identical with or without a panel", () => {
    const cols = 100;
    const fixture: ChatMessage[] = [
      { role: "user", text: "a question" },
      { role: "assistant", text: "an answer\nwith a second line" },
      { role: "tool", text: "tool output", toolName: "bash" },
    ];
    const before = getScrollableMessages(fixture, 12, 3, cols);
    tocPanelGeometry(cols, 20); // panel geometry exists…
    const after = getScrollableMessages(fixture, 12, 3, cols); // …and is not an input here
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe("clipPanelLines (U2 panel interior)", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`);

  test("always exactly innerHeight rows; short content padded with empty (painted) rows", () => {
    const { lines: out, top } = clipPanelLines(lines.slice(0, 3), 6, 0);
    expect(out).toHaveLength(6);
    expect(out.slice(3)).toEqual(["", "", ""]);
    expect(top).toBe(0);
  });

  test("cursor stays visible at both extremes and while walking down", () => {
    expect(clipPanelLines(lines, 4, 0).top).toBe(0);
    const bottom = clipPanelLines(lines, 4, 9);
    expect(bottom.top).toBe(6);
    expect(bottom.lines[3]).toBe("row 9");
    const mid = clipPanelLines(lines, 4, 5);
    expect(mid.top).toBeLessThanOrEqual(5);
    expect(5).toBeLessThan(mid.top + 4);
  });
});
