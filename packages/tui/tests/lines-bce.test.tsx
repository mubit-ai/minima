/**
 * The fullscreen stripe bug (2026-07-31): Ink's Text transform (wrap-ansi) re-encodes
 * embedded ANSI and closes a combined `ESC[37;48;2;…m` sequence with `39m` only — the
 * background stayed open past end-of-line and background-color-erase flooded whole
 * terminal rows with the user-bubble color. lines.ts now emits one code per sequence with
 * its specific closer; these tests pin BOTH layers: the strings themselves, and what Ink
 * actually writes after its transform.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Text, render } from "ink";
import React from "react";
import type { ChatMessage } from "../src/tui/layout.ts";
import { renderMessageToLines } from "../src/tui/lines.ts";

const ESC = String.fromCharCode(27);

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 12;
  isTTY = true;
  frames: string[] = [];
  writableNeedDrain = false;
  write(s: string) {
    this.frames.push(s);
    return true;
  }
  override off() {
    return this;
  }
}

/** One viewport row through Ink's real truncate transform (debug bypasses throttling). */
function inkEmits(line: string): string {
  const stdout = new FakeStdout();
  const inst = render(
    React.createElement(Text, { wrap: "truncate" }, line || " "),
    // @ts-expect-error minimal fake stdout
    { stdout, debug: true },
  );
  inst.unmount();
  return stdout.frames.join("");
}

const MESSAGES: ChatMessage[] = [
  { role: "user", text: "hello stripes\nsecond line" },
  { role: "assistant", text: "say **bold** and `code`\n- item **one**\n# Head" },
  { role: "thinking", text: "pondering", thoughtDurationSecs: 1.0 },
  { role: "tool", text: "boom", toolName: "bash", isError: true },
  { role: "banner", text: "tip" },
];

describe("viewport line SGR discipline (the stripe guard)", () => {
  test("no combined multi-code CSI, and every opened background is explicitly closed", () => {
    for (const msg of MESSAGES) {
      for (const line of renderMessageToLines(msg, 80)) {
        // One code per sequence — combined opens are what Ink mis-closes. The truecolor
        // background triplet 48;2;R;G;B is a single logical code and the only ';' allowed.
        for (const m of line.matchAll(/\[([0-9;]+)m/g)) {
          const params = m[1]!;
          expect(params === "0" || !params.includes(";") || params.startsWith("48;2;")).toBe(true);
        }
        const opens = [...line.matchAll(/\[48;2;[0-9;]+m/g)].length;
        const closes = [...line.matchAll(/\[49m/g)].length;
        expect(closes).toBe(opens);
      }
    }
  });

  test("after Ink's truncate transform, every row still closes its background", () => {
    for (const msg of MESSAGES) {
      for (const line of renderMessageToLines(msg, 80)) {
        const out = inkEmits(line);
        const opens = [...out.matchAll(/\[48;2;[0-9;]+m/g)].length;
        const closes = [...out.matchAll(/\[(?:49|0)m/g)].length;
        expect(closes).toBeGreaterThanOrEqual(opens);
        if (opens > 0) {
          // The LAST background-relevant code must be a close, or BCE stripes return.
          const lastOpen = out.lastIndexOf(`${ESC}[48;2;`);
          const lastClose = Math.max(out.lastIndexOf(`${ESC}[49m`), out.lastIndexOf(`${ESC}[0m`));
          expect(lastClose).toBeGreaterThan(lastOpen);
        }
      }
    }
  });
});
