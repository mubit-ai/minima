import { describe, expect, test } from "bun:test";
import { wrapLineToWidth, wrappedLineCount } from "../src/tui/layout.ts";
import type { ChatMessage } from "../src/tui/messages.tsx";
import { sectionReaderLines } from "../src/tui/reader.ts";

describe("wrapLineToWidth — the producer the height estimates are DEFINED by", () => {
  test("property: produced row count === wrappedLineCount, per line, across widths", () => {
    const lines = [
      "",
      "short",
      "a plain sentence that goes on for a while and must wrap at narrow widths",
      `${"A".repeat(11)} ${"B".repeat(11)} ${"C".repeat(11)}`,
      "x".repeat(160),
      "你".repeat(25),
      `mixed ${"你".repeat(9)} and ascii tail`,
      "word " + "y".repeat(75) + " end",
    ];
    for (const line of lines) {
      for (const w of [20, 24, 37, 60, 80, 120]) {
        expect(wrapLineToWidth(line, w).length).toBe(wrappedLineCount(line, w));
      }
    }
  });

  test("wrapping loses no content: rows re-join to the original words", () => {
    const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const rows = wrapLineToWidth(line, 20);
    expect(rows.join(" ").split(/\s+/)).toEqual(line.split(" "));
  });

  test("a hard-broken long word re-joins exactly", () => {
    const long = "z".repeat(55);
    expect(wrapLineToWidth(long, 20).join("")).toBe(long);
  });
});

function msg(role: ChatMessage["role"], text: string, toolName?: string): ChatMessage {
  return { role, text, ...(toolName ? { toolName } : {}) } as ChatMessage;
}

describe("sectionReaderLines — a section's messages as plain panel lines", () => {
  const MESSAGES: ChatMessage[] = [
    msg("user", "first prompt"),
    msg("assistant", "# Title\nbody text\n- bullet one"),
    msg("user", "second prompt"),
    msg("tool", "line1\nline2", "bash"),
    msg("assistant", "closing reply"),
  ];

  test("renders headers + bodies for the sliced range only (section bounds)", () => {
    const lines = sectionReaderLines(MESSAGES, 0, 2, 80);
    expect(lines[0]).toBe("▸ you");
    expect(lines[1]).toBe("first prompt");
    expect(lines).toContain("◆ assistant");
    expect(lines).not.toContain("second prompt");
    expect(lines).not.toContain("⚙ bash:");
  });

  test("a blank separator row sits between messages, never before the first", () => {
    const lines = sectionReaderLines(MESSAGES, 0, 2, 80);
    expect(lines[0]).not.toBe("");
    expect(lines[2]).toBe("");
  });

  test("assistant markdown mirrors the height rules: heading gets a blank, bullets keep '- '", () => {
    const lines = sectionReaderLines(MESSAGES, 1, 2, 80);
    const i = lines.indexOf("◆ assistant");
    expect(lines[i + 1]).toBe("");
    expect(lines[i + 2]).toBe("Title");
    expect(lines).toContain("- bullet one");
  });

  test("tool bodies keep the honest truncation marker (CC format — MP12)", () => {
    const big = msg("tool", Array(80).fill("row").join("\n"), "bash");
    const lines = sectionReaderLines([big], 0, 1, 80);
    expect(lines[0]).toBe("⚙ bash:");
    expect(lines.some((l) => /^… \d+ more lines$/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("+"))).toBe(false);
  });

  test("out-of-range slices and empty sections yield the placeholder", () => {
    expect(sectionReaderLines(MESSAGES, 5, 9, 80)).toEqual(["(empty section)"]);
    expect(sectionReaderLines([], 0, 0, 80)).toEqual(["(empty section)"]);
  });
});
