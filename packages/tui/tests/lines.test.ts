import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import type { ChatMessage } from "../src/tui/layout.ts";
import { wrappedLineCount } from "../src/tui/layout.ts";
import {
  linesFor,
  liveReplyLines,
  markdownToLines,
  renderMessageToLines,
  resetLiveReplyCache,
  thoughtsPeekLines,
  wrapSegments,
} from "../src/tui/lines.ts";

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI_RE, "");
const visWidth = (s: string) => stringWidth(strip(s));

const user = (text: string): ChatMessage => ({ role: "user", text });
const asst = (text: string): ChatMessage => ({ role: "assistant", text });
const tool = (text: string, toolName = "bash"): ChatMessage => ({ role: "tool", text, toolName });
const thinking = (text: string): ChatMessage => ({
  role: "thinking",
  text,
  thoughtDurationSecs: 1.2,
});

const FIXTURES: ChatMessage[] = [
  user("short"),
  user(`${"word ".repeat(80)}end`),
  user("multi\nline\nprompt"),
  asst(`## Heading\n\n- item **one**\n- item \`two\`\n\n${"body ".repeat(60)}tail`),
  asst(`你好世界 ${"混合宽度文本 ".repeat(20)}🧠🚀 end`),
  asst(`${"averyveryverylongunbrokenword".repeat(8)}`),
  tool(`${"tool output line with some status=ok text\n".repeat(40)}`),
  tool("boom", "bash"),
  thinking(`${"pondering the routing decision deeply ".repeat(20)}`),
];

describe("the width invariant (the garble guard)", () => {
  test("every emitted line fits the terminal width at 40/80/100 cols", () => {
    for (const msg of FIXTURES) {
      for (const cols of [40, 80, 100]) {
        for (const line of renderMessageToLines(msg, cols)) {
          expect(visWidth(line)).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  test("no emitted line contains a newline (one string = one row)", () => {
    for (const msg of FIXTURES)
      for (const line of renderMessageToLines(msg, 80)) expect(line).not.toContain("\n");
  });
});

describe("wrapSegments", () => {
  test("agrees with layout.ts wrappedLineCount on ASCII and CJK (shared break behavior)", () => {
    const cases = [
      "plain words that wrap around the boundary here",
      `${"word ".repeat(50)}end`,
      "a  b   c    d",
      "supercalifragilisticexpialidocious tiny",
      `${"x".repeat(200)}`,
      `你好 世界 ${"宽 ".repeat(30)}`,
      "",
    ];
    for (const text of cases) {
      for (const width of [20, 37, 80]) {
        const mine = wrapSegments([...text], width).length;
        expect(mine).toBe(wrappedLineCount(text, width));
      }
    }
  });

  test("hard-breaks an over-wide word without ever exceeding the width", () => {
    const cps = [...`${"宽".repeat(50)}`]; // 100 display cols of CJK
    for (const [s, e] of wrapSegments(cps, 21)) {
      expect(stringWidth(cps.slice(s, e).join(""))).toBeLessThanOrEqual(21);
    }
  });
});

describe("role chrome", () => {
  test("line 0 is always the blank marginTop separator", () => {
    for (const msg of FIXTURES) expect(renderMessageToLines(msg, 80)[0]).toBe("");
  });

  test("user: green header + padded bg body rows", () => {
    const lines = renderMessageToLines(user("hello"), 80);
    expect(strip(lines[1]!)).toBe("▸ you");
    expect(strip(lines[2]!)).toBe(" hello ");
    expect(lines[2]!).toContain("48;2;42;42;53"); // the #2a2a35 block
  });

  test("tool: header, clamped body, hidden-lines hint", () => {
    const many = tool(`${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}`);
    const lines = renderMessageToLines(many, 80);
    expect(strip(lines[1]!)).toBe("  ⚙ bash:");
    expect(strip(lines[lines.length - 1]!)).toMatch(/… \+\d+ more lines/);
    expect(lines.length).toBe(2 + 30 + 1); // separator + header + MAX_TOOL_LINES + hint
  });

  test("thinking: bordered box is exactly 4 chrome rows + wrapped body", () => {
    const lines = renderMessageToLines(thinking("brief thought"), 80);
    expect(strip(lines[1]!)).toMatch(/^┌─+┐$/);
    expect(strip(lines[2]!)).toContain("🧠 reasoning (1.2s)");
    expect(strip(lines[lines.length - 1]!)).toMatch(/^└─+┘$/);
    expect(lines.length).toBe(5); // separator + top border + header + 1 body row + bottom border
    // every bordered row spans the full width
    for (const l of lines.slice(1)) expect(visWidth(l)).toBe(80);
  });

  test("assistant markdown: heading adds exactly one blank row; lists indent", () => {
    const lines = markdownToLines("# Title\nplain\n- item", 80);
    expect(lines[0]).toBe(""); // heading marginTop
    expect(strip(lines[1]!)).toBe("Title");
    expect(strip(lines[2]!)).toBe("plain");
    expect(strip(lines[3]!)).toBe("  - item");
  });

  test("inline markdown markers are consumed, not rendered", () => {
    const [line] = markdownToLines("say **bold** and `code` here", 80);
    expect(strip(line!)).toBe("say bold and code here");
    expect(line!).toContain(`${ESC}[1m`); // bold opened
    expect(line!).toContain(`${ESC}[36m`); // code cyan opened
  });
});

describe("linesFor cache", () => {
  test("returns identical arrays for repeat calls and re-derives on width change", () => {
    const msg = asst("cache me");
    const a = linesFor(msg, 80);
    expect(linesFor(msg, 80)).toBe(a); // same reference — cache hit
    const b = linesFor(msg, 60);
    expect(b).not.toBe(a);
    expect(linesFor(msg, 60)).toBe(b);
  });
});

describe("liveReplyLines (incremental stream cache)", () => {
  test("incremental feeding equals from-scratch rendering under random split points", () => {
    const full = `## Progress\nfirst paragraph with **bold**\n- a\n- b\n${"tail ".repeat(30)}`;
    resetLiveReplyCache();
    const expected = liveReplyLines(full, 80);

    // Feed in increasing prefixes (simulating stream flushes) with awkward split points.
    resetLiveReplyCache();
    let got: string[] = [];
    for (const cut of [3, 12, 13, 30, 31, 55, full.length]) {
      got = liveReplyLines(full.slice(0, cut), 80);
    }
    expect(got).toEqual(expected);
  });

  test("resets when the text is not an extension (new turn)", () => {
    resetLiveReplyCache();
    liveReplyLines("first turn text\nmore", 80);
    const fresh = liveReplyLines("second", 80);
    resetLiveReplyCache();
    expect(fresh).toEqual(liveReplyLines("second", 80));
  });
});

describe("thoughtsPeekLines", () => {
  test("always exactly 5 rows, full width, regardless of content", () => {
    for (const text of ["", "short", "long thought ".repeat(100), "with\nnewlines\nin it"]) {
      const lines = thoughtsPeekLines(text, 80);
      expect(lines.length).toBe(5);
      for (const l of lines.slice(1)) expect(visWidth(l)).toBe(80);
      expect(lines[0]).toBe("");
    }
  });
});
