import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeMsgHeight, toolHiddenMarker } from "../src/tui/layout.ts";
import { readSource } from "./_source.ts";

describe("toolHiddenMarker — ONE string for both truncation surfaces (MP12)", () => {
  test("CC format: '… N more lines', no '+', no leading spaces", () => {
    expect(toolHiddenMarker(214)).toBe("… 214 more lines");
    expect(toolHiddenMarker(1)).toBe("… 1 more lines");
  });

  test("both render sites consume the helper — the strings cannot diverge", () => {
    const messages = readSource("tui/messages.tsx");
    const reader = readSource("tui/reader.ts");
    expect(messages).toContain("toolHiddenMarker(hiddenLines)");
    expect(reader).toContain("toolHiddenMarker(hiddenLines)");
    for (const src of [messages, reader]) {
      expect(src).not.toMatch(/\$\{[^}]*\} more lines/);
    }
  });

  test("clampToolText stays the ONLY tool-trim site; the +1 indicator row reservation holds", () => {
    const layout = readSource("tui/layout.ts");
    expect(layout.match(/hiddenLines > 0 \? 1 : 0/g)?.length).toBe(1);
    const tall = { role: "tool" as const, text: Array(80).fill("row").join("\n") };
    const clamped = { role: "tool" as const, text: "row" };
    expect(computeMsgHeight(tall, 80) - computeMsgHeight(clamped, 80)).toBeGreaterThanOrEqual(30);
  });
});
