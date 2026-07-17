import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeMsgHeight, toolHiddenMarker } from "../src/tui/layout.ts";

describe("toolHiddenMarker — ONE string for both truncation surfaces (MP12)", () => {
  test("CC format: '… N more lines', no '+', no leading spaces", () => {
    expect(toolHiddenMarker(214)).toBe("… 214 more lines");
    expect(toolHiddenMarker(1)).toBe("… 1 more lines");
  });

  test("both render sites consume the helper — the strings cannot diverge", () => {
    const messages = readFileSync(join(import.meta.dir, "../src/tui/messages.tsx"), "utf8");
    const reader = readFileSync(join(import.meta.dir, "../src/tui/reader.ts"), "utf8");
    expect(messages).toContain("toolHiddenMarker(hiddenLines)");
    expect(reader).toContain("toolHiddenMarker(hiddenLines)");
    for (const src of [messages, reader]) {
      expect(src).not.toMatch(/\$\{[^}]*\} more lines/);
    }
  });

  test("clampToolText stays the ONLY tool-trim site; the +1 indicator row reservation holds", () => {
    const layout = readFileSync(join(import.meta.dir, "../src/tui/layout.ts"), "utf8");
    expect(layout.match(/hiddenLines > 0 \? 1 : 0/g)?.length).toBe(1);
    const tall = { role: "tool" as const, text: Array(80).fill("row").join("\n") };
    const clamped = { role: "tool" as const, text: "row" };
    expect(computeMsgHeight(tall, 80) - computeMsgHeight(clamped, 80)).toBeGreaterThanOrEqual(30);
  });
});
