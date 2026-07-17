import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  classifyMarkdownLines,
  markdownBodyHeight,
  tailToFit,
  wrapLineToWidth,
  wrappedLineCount,
} from "../src/tui/layout.ts";
import { sectionReaderLines } from "../src/tui/reader.ts";

const FENCED = [
  "# Title",
  "",
  "A plain paragraph that is long enough to wrap at the narrower widths in the matrix below.",
  "```ts",
  "const x = classify(prompt);",
  "    const indented = true;",
  "```",
  "tail line",
].join("\n");

describe("classifyMarkdownLines — the ONE classifier all three sites consume", () => {
  test("fence delimiters, code interior, openerIdx threading", () => {
    const md = classifyMarkdownLines("```ts\n# not a heading\n- not a bullet\n```");
    expect(md.map((l) => l.kind)).toEqual(["fence-open", "code", "code", "fence-close"]);
    expect(md[0]!.text).toBe("```ts");
    expect(md[1]!.text).toBe("# not a heading");
    expect(md[2]!.text).toBe("- not a bullet");
    expect(md[1]!.openerIdx).toBe(0);
    expect(md[3]!.openerIdx).toBe(0);
  });

  test("EOF with an open fence leaves trailing lines as code (the streaming case)", () => {
    const md = classifyMarkdownLines("```py\nx = 1");
    expect(md.map((l) => l.kind)).toEqual(["fence-open", "code"]);
  });

  test("a second block's openerIdx points at ITS opener, not the first", () => {
    const md = classifyMarkdownLines("```a\nx\n```\nmid\n```b\ny\n```");
    expect(md[5]!.kind).toBe("code");
    expect(md[5]!.openerIdx).toBe(4);
  });

  test("list rule requires the space: '- '/'* ' are lists, '-x'/'---'/'--flag' are plain", () => {
    expect(classifyMarkdownLines("- x")[0]).toMatchObject({ kind: "list", text: "x", bullet: "-" });
    expect(classifyMarkdownLines("* x")[0]).toMatchObject({ kind: "list", text: "x", bullet: "•" });
    for (const line of ["-x", "---", "--flag"]) {
      expect(classifyMarkdownLines(line)[0]!.kind).toBe("plain");
    }
  });

  test("headings keep today's rule outside fences; plain lines keep their raw text", () => {
    expect(classifyMarkdownLines("## Two")[0]).toMatchObject({ kind: "heading", text: "Two" });
    expect(classifyMarkdownLines("  padded prose")[0]).toMatchObject({
      kind: "plain",
      text: "  padded prose",
    });
  });

  test("tabs expand to 4 spaces in fence/code text (string-width counts \\t as 0)", () => {
    const md = classifyMarkdownLines("```\n\tindented\n```");
    expect(md[1]!.text).toBe("    indented");
  });
});

describe("markdownBodyHeight — fence-aware (no phantom heading/list rows inside code)", () => {
  test("a '#' line inside a fence is 1 row, not heading marginTop + text", () => {
    expect(markdownBodyHeight("```\n# x\n```", 80)).toBe(3);
    expect(markdownBodyHeight("```ts\n# not a heading", 80)).toBe(2);
  });

  test("overlong code lines count their wrap rows", () => {
    const long = "z".repeat(200);
    expect(markdownBodyHeight(`\`\`\`\n${long}\n\`\`\``, 80)).toBe(2 + Math.ceil(200 / 80));
  });

  test("leading indent counts toward width inside a fence (the under-estimate bug)", () => {
    const line = " ".repeat(8) + "z".repeat(76);
    expect(markdownBodyHeight(`\`\`\`\n${line}\n\`\`\``, 80)).toBe(4);
  });
});

describe("wrapLineToWidth — leading spaces occupy columns (Ink wraps with trim:false)", () => {
  test("8 spaces + 76 chars at width 80 is TWO rows, indent preserved", () => {
    const rows = wrapLineToWidth(" ".repeat(8) + "z".repeat(76), 80);
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe(" ".repeat(8));
    expect(rows[1]).toBe("z".repeat(76));
  });

  test("indented code keeps its indent on the produced first row", () => {
    const rows = wrapLineToWidth("    def walk(node):", 60);
    expect(rows.length).toBe(1);
    expect(rows[0]).toBe("    def walk(node):");
  });

  test("producer/count lockstep holds for indented lines at every matrix width", () => {
    const lines = [
      "    def walk(node):",
      "        return [visit(c) for c in node.children if c.kind not in SKIP_KINDS]",
      " ".repeat(8) + "z".repeat(76),
      "  padded prose with several words that should wrap normally at narrow widths",
    ];
    for (const line of lines) {
      for (const w of [20, 24, 37, 60, 80, 120]) {
        expect(wrapLineToWidth(line, w).length).toBe(wrappedLineCount(line, w));
      }
    }
  });

  test("an indent wider than the row hard-breaks instead of producing an over-wide row", () => {
    const rows = wrapLineToWidth(" ".repeat(24) + "x", 20);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(20);
    expect(rows.join("")).toBe(" ".repeat(24) + "x");
  });
});

describe("three-site lockstep — reader rows EXACTLY equal the height estimate", () => {
  test("heading + plain + fenced content, every matrix width", () => {
    const msgs: ChatMessage[] = [{ role: "assistant", text: FENCED }];
    for (const w of [20, 37, 60, 80, 120]) {
      const lines = sectionReaderLines(msgs, 0, 1, w);
      expect(lines.length - 1).toBe(markdownBodyHeight(FENCED, w));
    }
  });
});

describe("sectionReaderLines — fenced code renders verbatim in the panel reader", () => {
  const msgs: ChatMessage[] = [{ role: "assistant", text: FENCED }];
  const lines = sectionReaderLines(msgs, 0, 1, 120);

  test("delimiters kept verbatim (language tag visible), code indent intact", () => {
    expect(lines).toContain("```ts");
    expect(lines).toContain("    const indented = true;");
  });

  test("no blank heading row injected for '#' lines inside a fence", () => {
    const fenced = sectionReaderLines(
      [{ role: "assistant", text: "```\n# x\n```" }],
      0,
      1,
      120,
    );
    expect(fenced).toEqual(["◆ assistant", "```", "# x", "```"]);
  });
});

describe("tailToFit — a slice never loses its fence opener", () => {
  const OPEN = "intro line\n```ts\naaa\nbbb\nccc";

  test("mid-fence slices re-anchor on the REAL opener and respect the budget", () => {
    for (let budget = 1; budget <= 6; budget++) {
      const out = tailToFit(OPEN, 80, budget);
      expect(markdownBodyHeight(out, 80)).toBeLessThanOrEqual(budget);
    }
    const two = tailToFit(OPEN, 80, 2);
    expect(two.split("\n")[0]).toBe("```ts");
    expect(two.endsWith("ccc")).toBe(true);
  });

  test("a slice that would start on the closing fence drops the block cleanly", () => {
    expect(tailToFit("```ts\ncode\n```\ntail", 80, 2)).toBe("tail");
  });

  test("prose tails behave exactly as before", () => {
    expect(tailToFit("a\nb\nc", 80, 2)).toBe("b\nc");
  });
});
