import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  MAX_TOOL_LINES,
  PANEL_STATUS_ROWS,
  QUESTION_TEXT_MAX_ROWS,
  SCROLLBACK_SAFETY_ROWS,
  childTreeHeight,
  clampToolText,
  computeMsgHeight,
  markdownBodyHeight,
  nextLiveFrameHeight,
  panelOuterHeight,
  permHiddenMarker,
  permOverlayHeight,
  permPreviewKey,
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
  test("a tool body wraps at the FULL box width, like MessageRow paints it", () => {
    // The plan-mode ON notice (235 chars): MessageRow renders the body unindented, so at
    // 120 cols it wraps to 2 rows. Counting at an interior width (cols-4 → 3 rows) floats
    // the composer off the terminal bottom — the tui-verify bottom-anchor regression.
    const notice =
      "Plan mode ON — write/edit/bash/apply_patch ask first; todowrite/task blocked. " +
      "Talk through the plan; the design council convenes on substantive turns. " +
      "/plan finalize writes the plan to the project root. /plan status · /plan cancel.";
    expect(computeMsgHeight(tool(notice, "plan"), 120)).toBe(2 + wrappedLineCount(notice, 120));
    expect(wrappedLineCount(notice, 120)).toBe(2);
  });
  test("a tab-bearing body line counts its expanded width (the width-lie class)", () => {
    // stringWidth counts \t as 0 while the terminal advances to a tab stop — un-expanded
    // tabs make Ink under-measure and desync log-update's erase (the garble class the
    // fence/code classifier already guards, layout.ts MdLine). 30 + tab(4) + 8 = 42 > 40.
    const line = `${"x".repeat(30)}\t${"y".repeat(8)}`;
    expect(computeMsgHeight(tool(line), 40)).toBe(2 + 2);
  });
  test("a long MCP tool name wraps the header row — counted, not flat 1", () => {
    const name = "mcp__server__really_long_tool_name_that_wraps";
    const header = `  ⚙ ${name}:`;
    const headerRows = wrappedLineCount(header, 40);
    expect(headerRows).toBeGreaterThan(1);
    expect(computeMsgHeight(tool("body", name), 40)).toBe(1 + headerRows + 1);
  });
  test("boundary: a body line exactly at cols is 1 row; one past wraps", () => {
    expect(computeMsgHeight(tool("x".repeat(120)), 120)).toBe(3);
    expect(computeMsgHeight(tool("x".repeat(121)), 120)).toBe(4);
  });
  test("the irreducible chrome floor per role (empty body still renders header + margin)", () => {
    // A message can never render below this floor — the height estimate must account for it
    // or reservations under-count (the garble class). thinking is 5 (border adds 2).
    expect(computeMsgHeight(user(""), 80)).toBe(3); // marginTop + "▸ you" + 1 body
    expect(computeMsgHeight(tool(""), 80)).toBe(3); // marginTop + "⚙ …:" + 1 body
    expect(computeMsgHeight(asst(""), 80)).toBe(3); // marginTop + "◆ assistant" + 1 body
    expect(computeMsgHeight(thinking(""), 80)).toBe(5); // marginTop + border(2) + header + 1 body
  });
});

describe("clampToolText — bounds huge tool output", () => {
  test("tab-expands so width math matches the terminal (render, ruler, reader all consume this)", () => {
    const { text } = clampToolText("a\tb", 80);
    expect(text).toBe("a    b");
  });
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
    // ~30 rows. The live region must NEVER exceed its budget (the garble class /
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

import { clipPanelLines } from "../src/tui/layout.ts";

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

describe("permPreviewKey — unique React key per preview row", () => {
  test("todowrite verify rows sharing the fixed label prefix get distinct keys", () => {
    // The plan-verification todowrite preview shape (permissions.ts buildDiffPreview): the verify label
    // prefix is 39 chars, so a bare line.slice(0, 40) key collides whenever two commands
    // start with the same character — exactly this fixture.
    const preview = [
      "1. [x] create line_counter.py",
      "     verify (runs as a shell command): python line_counter.py sample.py",
      "2. [ ] add unit tests",
      "     verify (runs as a shell command): pytest tests/",
    ].join("\n");
    const { lines } = permPreviewLines(preview, 120);
    const contentSliced = lines.map((l) => l.slice(0, 40));
    expect(new Set(contentSliced).size).toBeLessThan(contentSliced.length);
    const keys = lines.map((l, i) => permPreviewKey(i, l));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("identical duplicate lines (edit diff repeats) still key uniquely", () => {
    const lines = ["+ same", "+ same", "+ same"];
    const keys = lines.map((l, i) => permPreviewKey(i, l));
    expect(new Set(keys).size).toBe(3);
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

  test("a plan-verification todowrite preview with a long verify command reserves its true rendered rows", () => {
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

describe("resize under an armed permission overlay re-clamps (LB-20)", () => {
  test("the re-wrapped overlay + composer + footer stack never reaches the new terminal height", () => {
    // A resize while the overlay is armed re-wraps every line at the new cols and can newly
    // exceed the cap; the reset frame cap-seeds with a stale prev from the OLD geometry.
    // The kernel must clamp both: the frame stays <= rows − SCROLLBACK_SAFETY_ROWS (excess
    // top-clips under overflow="hidden"), and the bounded preview keeps the overlay's own
    // rows finite so its bottom [y/a/n] hint survives the clip.
    const preview = Array.from({ length: 40 }, (_, i) => `+ line ${i} ${"x".repeat(60)}`).join(
      "\n",
    );
    const p = {
      toolName: "edit",
      promptText: "apply this edit?",
      argsSummary: "src/foo.ts",
      diffPreview: preview,
    };
    for (const rows of [12, 16, 24, 36, 50]) {
      for (const cols of [40, 60, 80, 120, 200]) {
        const overlay = permOverlayHeight(p, cols);
        const stalePrev = 78; // the old geometry's cap-seeded frame (e.g. 80-row terminal)
        const content = overlay + 4 /* composer stays booked (LB-20) */ + 6; /* footer */
        const h = nextLiveFrameHeight(stalePrev, 0, content, rows);
        expect(h).toBeLessThanOrEqual(rows - SCROLLBACK_SAFETY_ROWS);
        const interior = Math.max(20, cols - 4);
        const chrome =
          2 +
          wrappedLineCount(`${permToolLabel("edit")} apply this edit?`, interior) +
          wrappedLineCount(permHiddenMarker(39), interior) +
          1;
        expect(overlay).toBeLessThanOrEqual(chrome + 12);
      }
    }
  });
});

describe("panelOuterHeight — the expanded-panel wipe-threshold identity (MP4)", () => {
  test("panel + composer + status ≡ rows − SCROLLBACK_SAFETY_ROWS at every geometry", () => {
    for (let rows = 12; rows <= 60; rows++) {
      for (let extraInputLines = 0; extraInputLines <= 6; extraInputLines++) {
        for (const planMode of [false, true]) {
          const inputBoxHeight = (planMode ? 7 : 4) + extraInputLines;
          const outer = panelOuterHeight(rows, inputBoxHeight);
          expect(outer + inputBoxHeight + PANEL_STATUS_ROWS).toBe(rows - SCROLLBACK_SAFETY_ROWS);
        }
      }
    }
  });

  test("PANEL_STATUS_ROWS counts the status group that stays mounted under a panel", () => {
    // StatusBar marginTop(1) + 2 truncated rows + keys-legend row(1). ChildTree, busy,
    // suggestions, and the quit-armed line are suppressed/unreachable while a panel
    // captures keys — if one of them becomes visible under a panel, this constant (and
    // the identity above) must absorb it.
    expect(PANEL_STATUS_ROWS).toBe(4);
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
