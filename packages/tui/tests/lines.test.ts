import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import type { ChatMessage } from "../src/tui/layout.ts";
import { computeMsgHeight, markdownBodyHeight } from "../src/tui/layout.ts";
import {
  linesFor,
  liveReplyLines,
  markdownToLines,
  renderMessageToLines,
  resetLiveReplyCache,
  thoughtsPeekLines,
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

// Marker-free corpus: for these, renderMessageToLines row count must EQUAL computeMsgHeight
// (the drift alarm chaining lines.ts -> computeMsgHeight -> MessageRow). Inline **/` markers
// are measured raw by the estimate but stripped by the render, so marker fixtures live in
// MARKER_FIXTURES and assert <= instead.
const PARITY_FIXTURES: ChatMessage[] = [
  user("short"),
  user(`${"word ".repeat(80)}end`),
  user("multi\nline\nprompt"),
  { role: "user", text: "stop-gate: continue with the plan", guardKind: "harness" },
  asst(`## Heading\n\nplain paragraph\n- item one\n- item two\n\n${"body ".repeat(60)}tail`),
  asst(`你好世界 ${"混合宽度文本 ".repeat(20)}🚀 end`),
  asst(`${"averyveryverylongunbrokenword".repeat(8)}`),
  asst("```bash\necho hi\n# a comment, not a heading\n- not a list\n```\ndone"),
  asst("streamed and cut mid-fence\n```py\nx = 1"),
  tool(`${"tool output line with some status=ok text\n".repeat(40)}`),
  tool("boom", "bash"),
  { role: "tool", text: "nope", toolName: "edit", guardKind: "deny" },
  thinking(`${"pondering the routing decision deeply ".repeat(20)}`),
  { role: "banner", text: "tip: type / for commands" },
  { role: "banner", text: "" },
];

const MARKER_FIXTURES: ChatMessage[] = [
  asst("say **bold** and `code` here\n- item **one**\n- item `two`"),
];

const gateBlock: ChatMessage = {
  role: "tool",
  toolName: "todowrite",
  isError: true,
  text: "Step not verified — done-gate red: tests failing\nkept: 1 pending",
};

describe("parity with computeMsgHeight (the drift alarm)", () => {
  test("marker-free corpus: rendered row count === computeMsgHeight at 40/80/100 cols", () => {
    for (const msg of PARITY_FIXTURES) {
      for (const cols of [40, 80, 100]) {
        expect(renderMessageToLines(msg, cols).length).toBe(computeMsgHeight(msg, cols));
      }
    }
  });

  test("inline markers: rendered rows never exceed the estimate (conservative bias)", () => {
    for (const msg of MARKER_FIXTURES) {
      for (const cols of [40, 80, 100]) {
        expect(renderMessageToLines(msg, cols).length).toBeLessThanOrEqual(
          computeMsgHeight(msg, cols),
        );
      }
    }
  });

  test("gate-block tool row matches the estimate where its header fits one row", () => {
    // computeMsgHeight measures the ⚙ header; the gate variant paints the longer ⊘ line,
    // which wraps identically at >= 60 cols.
    for (const cols of [80, 100]) {
      expect(renderMessageToLines(gateBlock, cols).length).toBe(computeMsgHeight(gateBlock, cols));
    }
  });

  test("liveReplyLines full-text height: 2 header rows + markdownBodyHeight", () => {
    const full = `## Progress\nfirst paragraph\n- a\n- b\n${"tail ".repeat(30)}`;
    resetLiveReplyCache();
    expect(liveReplyLines(full, 80).length).toBe(2 + markdownBodyHeight(full, 80));
  });
});

describe("the width invariant (the garble guard)", () => {
  test("every emitted line fits the terminal width at 40/80/100 cols", () => {
    for (const msg of [...PARITY_FIXTURES, ...MARKER_FIXTURES, gateBlock]) {
      for (const cols of [40, 80, 100]) {
        for (const line of renderMessageToLines(msg, cols)) {
          expect(visWidth(line)).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  test("no emitted line contains a newline (one string = one row)", () => {
    for (const msg of [...PARITY_FIXTURES, ...MARKER_FIXTURES])
      for (const line of renderMessageToLines(msg, 80)) expect(line).not.toContain("\n");
  });
});

describe("role chrome", () => {
  test("line 0 is always the blank marginTop separator", () => {
    for (const msg of PARITY_FIXTURES) expect(renderMessageToLines(msg, 80)[0]).toBe("");
  });

  test("user: green header + padded bg body rows", () => {
    const lines = renderMessageToLines(user("hello"), 80);
    expect(strip(lines[1]!)).toBe("▸ you");
    expect(strip(lines[2]!)).toBe(" hello ");
    expect(lines[2]!).toContain("48;2;42;42;53"); // the #2a2a35 block
  });

  test("harness steer renders as the single dim line, not a user bubble", () => {
    const lines = renderMessageToLines(
      { role: "user", text: "continue\nsecond line ignored", guardKind: "harness" },
      80,
    );
    expect(lines.length).toBe(2);
    expect(strip(lines[1]!)).toBe("  ⟳ continue");
  });

  test("guard deny renders as the single dim line", () => {
    const lines = renderMessageToLines(
      { role: "tool", text: "denied", toolName: "edit", guardKind: "deny" },
      80,
    );
    expect(lines.length).toBe(2);
    expect(strip(lines[1]!)).toBe("  ⊘ edit — blocked in plan mode");
  });

  test("tool: header, clamped body, hidden-lines hint", () => {
    const many = tool(`${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}`);
    const lines = renderMessageToLines(many, 80);
    expect(strip(lines[1]!)).toBe("  ⚙ bash:");
    expect(strip(lines[lines.length - 1]!)).toMatch(/… \d+ more lines/);
    expect(lines.length).toBe(2 + 30 + 1); // separator + header + MAX_TOOL_LINES + hint
  });

  test("gate-block: calm yellow ⊘ header instead of the red error path", () => {
    const lines = renderMessageToLines(gateBlock, 80);
    expect(strip(lines[1]!)).toBe("  ⊘ verify gate — completion blocked, statuses unchanged:");
    expect(lines[1]!).toContain(`${ESC}[33m`); // yellow, not red
  });

  test("thinking: bordered box is exactly 4 chrome rows + wrapped body", () => {
    const lines = renderMessageToLines(thinking("brief thought"), 80);
    expect(strip(lines[1]!)).toMatch(/^┌─+┐$/);
    expect(strip(lines[2]!)).toContain("🧠 reasoning (1.2s)");
    expect(strip(lines[lines.length - 1]!)).toMatch(/^└─+┘$/);
    expect(lines.length).toBe(5); // separator + top border + header + 1 body row + bottom border
    for (const l of lines.slice(1)) expect(visWidth(l)).toBe(80);
  });

  test("banner: centered glyphs, taglines, and the tip", () => {
    const lines = renderMessageToLines({ role: "banner", text: "tip text" }, 100);
    const glyphRow = lines.find((l) => strip(l).includes("███"));
    expect(glyphRow).toBeDefined();
    expect(strip(glyphRow!).startsWith(" ")).toBe(true); // centered
    expect(lines.some((l) => strip(l).includes("type a prompt, or / for commands"))).toBe(true);
    expect(strip(lines[lines.length - 1]!)).toContain("tip text");
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

  test("fenced code: delimiters dim, body verbatim, no phantom heading/list rows", () => {
    const lines = markdownToLines("```bash\n# comment\n- flag\n```", 80);
    expect(lines.length).toBe(4); // open + 2 code rows + close — no marginTop rows
    expect(strip(lines[1]!)).toBe("# comment");
    expect(strip(lines[2]!)).toBe("- flag");
    expect(lines[0]!).toContain(`${ESC}[2m`); // dim fence delimiter
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

    resetLiveReplyCache();
    let got: string[] = [];
    for (const cut of [3, 12, 13, 30, 31, 55, full.length]) {
      got = liveReplyLines(full.slice(0, cut), 80);
    }
    expect(got).toEqual(expected);
  });

  test("mid-fence split points: code stays code across flushes (inFence carry)", () => {
    const full = "intro\n```bash\necho one\n# not a heading\n- not a list\n```\nafter";
    resetLiveReplyCache();
    const expected = liveReplyLines(full, 80);
    for (const cuts of [
      [7, 10, 20, 29, 30, 44, 55, full.length],
      [14, 15, 16, 38, full.length],
    ]) {
      resetLiveReplyCache();
      let got: string[] = [];
      for (const cut of cuts) got = liveReplyLines(full.slice(0, cut), 80);
      expect(got).toEqual(expected);
    }
    // and the fence interior never gained a heading marginTop blank row
    const stripped = expected.map(strip);
    const idx = stripped.indexOf("# not a heading");
    expect(idx).toBeGreaterThan(0);
    expect(stripped[idx - 1]).toBe("echo one");
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
