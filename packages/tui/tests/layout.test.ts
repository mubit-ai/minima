import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  MAX_TOOL_LINES,
  QUESTION_TEXT_MAX_ROWS,
  SCROLLBACK_SAFETY_ROWS,
  childTreeHeight,
  clampToolText,
  computeMsgHeight,
  getScrollableMessages,
  gtFooterFit,
  markdownBodyHeight,
  permHiddenMarker,
  permOverlayHeight,
  permPreviewLines,
  permToolLabel,
  questionDisplayText,
  questionOverlayHeight,
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
  sidebarGeometry,
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

describe("tocPanelGeometry (legacy overlay chassis — remaining consumer: the B5 rewind picker)", () => {
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
});

describe("sidebarGeometry (docked ToC/GT sidebar — the 2026-07-14 reflow revision)", () => {
  test("null below TOC_MIN_COLS or for regionHeight < 5 → callers use the text fallback", () => {
    expect(sidebarGeometry(TOC_MIN_COLS - 1, 20)).toBeNull();
    expect(sidebarGeometry(100, 4)).toBeNull();
  });

  test("width caps at 40; sidebarWidth + contentCols partition cols exactly", () => {
    const g100 = sidebarGeometry(100, 24)!;
    expect(g100).toEqual({
      sidebarWidth: 40,
      contentCols: 60,
      height: 24,
      innerWidth: 36,
      innerHeight: 22,
    });
    const g60 = sidebarGeometry(60, 20)!;
    expect(g60.sidebarWidth).toBe(30);
    expect(g60.contentCols).toBe(30);
    for (const cols of [60, 75, 100, 200]) {
      const g = sidebarGeometry(cols, 20)!;
      expect(g.sidebarWidth + g.contentCols).toBe(cols);
      expect(g.contentCols).toBeGreaterThanOrEqual(30);
    }
  });

  test("closed = no reflow (contentCols === cols); docked = the window recomputes at contentCols with Σ ≤ budget", () => {
    const cols = 100;
    const fixture: ChatMessage[] = [
      { role: "user", text: "a question" },
      { role: "assistant", text: `an answer ${"word ".repeat(40)}` },
      { role: "tool", text: "tool output", toolName: "bash" },
    ];
    // Sidebar closed: app.tsx passes contentCols = cols — byte-identical to the original.
    const closed = getScrollableMessages(fixture, 12, 0, cols);
    expect(JSON.stringify(getScrollableMessages(fixture, 12, 0, cols))).toBe(
      JSON.stringify(closed),
    );
    // Docked: the window is computed at the narrowed width and the Σ≤budget guarantee holds
    // there by construction (conservative heights + the trim loop, now fed contentCols).
    const { contentCols } = sidebarGeometry(cols, 20)!;
    const docked = getScrollableMessages(fixture, 12, 0, contentCols);
    const sum = docked.visible.reduce((n, m) => n + computeMsgHeight(m, contentCols), 0);
    expect(sum).toBeLessThanOrEqual(12);
    // The long assistant line wraps differently at 60 cols than at 100 — reflow is real.
    expect(computeMsgHeight(fixture[1]!, contentCols)).toBeGreaterThan(
      computeMsgHeight(fixture[1]!, cols),
    );
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

describe("questionDisplayText", () => {
  test("short questions pass through untouched", () => {
    expect(questionDisplayText("Which approach?", 80)).toBe("Which approach?");
  });
  test("an over-long single line is sliced to the row budget and ellipsized", () => {
    const out = questionDisplayText("x".repeat(1000), 80); // interior 76, budget 4 rows
    expect(out.endsWith("…")).toBe(true);
    expect(wrappedLineCount(out, 76)).toBeLessThanOrEqual(QUESTION_TEXT_MAX_ROWS + 1);
  });
  test("newline-heavy questions are clamped by rendered rows, not characters", () => {
    const out = questionDisplayText(Array(50).fill("line").join("\n"), 80);
    expect(wrappedLineCount(out, 76)).toBeLessThanOrEqual(QUESTION_TEXT_MAX_ROWS + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("questionOverlayHeight", () => {
  const q = (over: Partial<Parameters<typeof questionOverlayHeight>[0]> = {}) => ({
    question: "Which approach?",
    options: [
      { label: "A", description: "first" },
      { label: "B", description: null },
    ],
    allow_freetext: true,
    ...over,
  });
  test("border + question + option rows + Other row + hint", () => {
    // cols 80: 2 (border) + 1 (question) + 2 (options) + 1 (Other) + 1 (hint), window not trimmed
    expect(questionOverlayHeight(q(), 80, 10)).toBe(7);
  });
  test("no free-text drops the Other row", () => {
    expect(questionOverlayHeight(q({ allow_freetext: false }), 80, 10)).toBe(6);
  });
  test("a huge option list is windowed: cap + 2 marker rows, not one row per option", () => {
    const many = q({
      options: Array.from({ length: 30 }, (_, i) => ({ label: `opt-${i}`, description: null })),
    });
    // 2 border + 1 question + 5 visible + 2 markers + 1 hint — NOT 31 option rows
    expect(questionOverlayHeight(many, 80, 5)).toBe(11);
  });
  test("a huge question is clamped near QUESTION_TEXT_MAX_ROWS", () => {
    const tall = q({ question: "word ".repeat(500) });
    // 2 border + <=5 question rows + 2 options + 1 Other + 1 hint
    expect(questionOverlayHeight(tall, 80, 10)).toBeLessThanOrEqual(
      2 + QUESTION_TEXT_MAX_ROWS + 1 + 2 + 1 + 1,
    );
  });
  test("option rows are truncated, never wrapped — long descriptions don't grow the estimate", () => {
    const wide = q({ options: [{ label: "opt", description: "y".repeat(300) }] });
    expect(questionOverlayHeight(wide, 40, 10)).toBe(2 + 1 + 1 + 1 + 1);
  });
});

describe("permToolLabel", () => {
  test("maps each gated tool onto the overlay's header label", () => {
    for (const t of ["read", "ls", "glob", "grep"]) expect(permToolLabel(t)).toBe("READ");
    expect(permToolLabel("write")).toBe("WRITE (new file)");
    expect(permToolLabel("edit")).toBe("EDIT (modify file)");
    expect(permToolLabel("bash")).toBe("RUN COMMAND");
    expect(permToolLabel("todowrite")).toBe("TODOWRITE");
  });
});

describe("permPreviewLines — clips the permission preview by RENDERED rows", () => {
  const shortLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  test("source-line parity with the old budget when nothing wraps: 12 fit, 13+ clip to 11", () => {
    expect(permPreviewLines(shortLines(12), 80)).toEqual({
      lines: shortLines(12).split("\n"),
      hidden: 0,
    });
    const thirteen = permPreviewLines(shortLines(13), 80);
    expect(thirteen.lines).toHaveLength(11);
    expect(thirteen.hidden).toBe(2);
    const twenty = permPreviewLines(shortLines(20), 80);
    expect(twenty.lines).toHaveLength(11);
    expect(twenty.hidden).toBe(9);
  });

  test("a long verify line that word-wraps is kept WHOLE — never char-truncated", () => {
    const verify = "x".repeat(200);
    expect(permPreviewLines(verify, 50)).toEqual({ lines: [verify], hidden: 0 });
  });

  test("wrapped rows consume the budget, not source lines", () => {
    // 10 lines of 50 chars at cols 40 (interior 36) render 2 rows each = 20 rows > 12, so only
    // 5 source lines (10 rendered rows) fit under the 11-row cap — a source-line clip would
    // have kept 10 and overflowed the reservation by 8 rows.
    const preview = Array(10).fill("x".repeat(50)).join("\n");
    const { lines, hidden } = permPreviewLines(preview, 40);
    expect(lines).toHaveLength(5);
    expect(hidden).toBe(5);
  });

  test("the first line is always kept even when it alone exceeds the budget", () => {
    const huge = "x".repeat(46 * 15); // 15 rendered rows at cols 50 (interior 46)
    const { lines, hidden } = permPreviewLines(`${huge}\ntail`, 50);
    expect(lines).toEqual([huge]);
    expect(hidden).toBe(1);
  });

  test("floors the interior width at 20 (no divide-by-tiny)", () => {
    const { lines, hidden } = permPreviewLines("x".repeat(40), 10);
    expect(lines).toEqual(["x".repeat(40)]); // 2 rows at width 20 — fits, kept whole
    expect(hidden).toBe(0);
  });
});

describe("permOverlayHeight — mirrors PermissionOverlay, estimate == render", () => {
  test("border + header + preview rows + marker + hint when lines are hidden", () => {
    // cols 80: 2 border + 1 header + 11 preview rows + 1 marker + 1 hint.
    const preview = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const p = { toolName: "bash", promptText: "run bash", argsSummary: "ls", diffPreview: preview };
    expect(permOverlayHeight(p, 80)).toBe(16);
  });

  test("counts the wrapped rows of a long verify line — the under-reservation pinned", () => {
    // One 200-char line at cols 50 (interior 46) renders 5 rows: 2 border + 1 header + 5 + 1
    // hint = 9. The old source-line formula reserved 3 + 1 + 1 = 5 and overflowed by 4 rows.
    const p = {
      toolName: "bash",
      promptText: "run bash",
      argsSummary: "irrelevant",
      diffPreview: "x".repeat(200),
    };
    expect(permOverlayHeight(p, 50)).toBe(9);
  });

  test("the target row is counted only when there is no preview (matching the render gate)", () => {
    const base = { toolName: "read", promptText: "read from /tmp", argsSummary: "src/foo.ts" };
    // 2 border + 1 header + 1 target + 1 hint.
    expect(permOverlayHeight({ ...base, diffPreview: null }, 80)).toBe(5);
    // 2 border + 1 header + 1 preview row + 1 hint — the target row is not rendered.
    expect(permOverlayHeight({ ...base, diffPreview: "one line" }, 80)).toBe(5);
  });

  test("the hidden marker's own wrapping is counted at narrow widths", () => {
    // cols 24 → interior 20: 20 one-row lines clip to 11 + the marker, which itself wraps to
    // 3 rows at width 20. 2 border + 1 header ("RUN COMMAND run bash") + 11 + 3 + 1 hint = 18.
    const preview = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const p = { toolName: "bash", promptText: "run bash", argsSummary: "", diffPreview: preview };
    expect(permHiddenMarker(9)).toBe("… +9 more lines not shown — reject if unsure");
    expect(permOverlayHeight(p, 24)).toBe(18);
  });

  test("a GT todowrite preview with a long verify command reserves its true rendered rows", () => {
    const preview = [
      "1. [ ] wire the parser",
      `     verify (runs as a shell command): bun test tests/${"deeply/nested/".repeat(8)}parser.test.ts`,
    ].join("\n");
    const p = {
      toolName: "todowrite",
      promptText: "run todowrite",
      argsSummary: "1 task (1 with a verify shell command)",
      diffPreview: preview,
    };
    // Whatever the exact wrap count, the reservation must exceed the old source-line formula
    // (3 + 2 lines + 1 = 6) because the verify line wraps at cols 50 — and the verify command
    // itself must be shown in full (hidden = 0).
    expect(permPreviewLines(preview, 50).hidden).toBe(0);
    expect(permOverlayHeight(p, 50)).toBeGreaterThan(6);
  });
});

describe("gtFooterFit — priority-ordered collapse of the GT footer rows", () => {
  const all = { block: true, strip: true, note: true };

  test("a roomy budget grants every present row", () => {
    expect(gtFooterFit(3, all)).toEqual({ block: true, strip: true, note: true });
    expect(gtFooterFit(10, all)).toEqual({ block: true, strip: true, note: true });
  });

  test("rows collapse in reverse priority: note first, then strip, then block", () => {
    expect(gtFooterFit(2, all)).toEqual({ block: true, strip: true, note: false });
    expect(gtFooterFit(1, all)).toEqual({ block: true, strip: false, note: false });
  });

  test("a zero or negative budget grants nothing", () => {
    expect(gtFooterFit(0, all)).toEqual({ block: false, strip: false, note: false });
    expect(gtFooterFit(-4, all)).toEqual({ block: false, strip: false, note: false });
  });

  test("all-absent in is all-absent out at ANY budget (default path structurally inert)", () => {
    const absent = { block: false, strip: false, note: false };
    for (const budget of [-1, 0, 1, 3, 10]) {
      expect(gtFooterFit(budget, absent)).toEqual(absent);
    }
  });

  test("partial presence: absent rows never consume a slot (no phantom grants)", () => {
    expect(gtFooterFit(1, { block: false, strip: true, note: true })).toEqual({
      block: false,
      strip: true,
      note: false,
    });
    expect(gtFooterFit(1, { block: false, strip: false, note: true })).toEqual({
      block: false,
      strip: false,
      note: true,
    });
    expect(gtFooterFit(2, { block: true, strip: false, note: true })).toEqual({
      block: true,
      strip: false,
      note: true,
    });
  });
});

describe("childTreeHeight", () => {
  test("zero children renders nothing", () => {
    expect(childTreeHeight(0, 8)).toBe(0);
  });
  test("border(2) + header(1) + rows + marginBottom(1)", () => {
    expect(childTreeHeight(3, 8)).toBe(7);
  });
  test("caps at maxRows and adds one '+k more' row", () => {
    expect(childTreeHeight(20, 8)).toBe(4 + 8 + 1);
  });
  test("cap floors at one visible row", () => {
    expect(childTreeHeight(5, 0)).toBe(4 + 1 + 1);
  });
});
