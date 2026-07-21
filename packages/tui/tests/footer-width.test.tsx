import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Box, render } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { StatusBar } from "../src/tui/status.tsx";

// Live regression (2026-07-21): `/budget mode enforce` puts ⛔ into the footer row; with
// Ink's compositor measuring ⛔ via a stale width table (is-fullwidth-code-point@4, where
// U+26D4 is narrow) the composed row came out one cell wider than the terminal, autowrapped,
// and every repaint scrolled the frame — an endless blank-line loop. Fixed by aligning every
// width table in the render pipeline (overrides + the cli-truncate patch); this renders the
// real StatusBar through real Ink and pins the invariant at the emitted-bytes level.

class FakeStdout extends EventEmitter {
  columns: number;
  rows = 30;
  frames: string[] = [];
  isTTY = true;
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
}

async function renderedLines(el: React.ReactElement, columns: number): Promise<string[]> {
  const stdout = new FakeStdout(columns);
  const inst = render(el, { stdout: stdout as never, patchConsole: false });
  await new Promise((r) => setTimeout(r, 30));
  inst.unmount();
  return stdout.frames.join("").split("\n").map(stripVTControlCharacters);
}

function statusBar(over: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <StatusBar
        model="gemini-2.5-pro"
        basis="prior"
        routeMode="auto"
        thinkingLevel="off"
        ctxPct={0}
        inputTokens={4273}
        outputTokens={3624}
        actualCostUsd={0.0493}
        sessionId="ephemeral"
        routingOffline={false}
        offlineReason={null}
        statusText="ready"
        mode="acceptEdits"
        readDirs={[]}
        alwaysTools={[]}
        bashGrants={[]}
        budget={{ spentUsd: 0.045, limitUsd: 0.02, fraction: 2.25, mode: "enforce" }}
        badge={{ text: "⏵⏵ ACCEPT EDITS", color: "green" }}
        {...over}
      />
    </Box>
  );
}

describe("footer row physical width (enforce ⛔ + badge)", () => {
  test("enforce-mode footer never exceeds the terminal width", async () => {
    for (const columns of [80, 100, 110, 120, 140]) {
      const lines = await renderedLines(statusBar(), columns);
      for (const l of lines) {
        expect(stringWidth(l)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("at full width the ⛔ marker and the whole badge render on one row", async () => {
    const lines = await renderedLines(statusBar(), 160);
    const row = lines.findLast((l) => l.includes("model:"));
    expect(row).toBeDefined();
    expect(row as string).toContain("⛔");
    expect(row as string).toContain("[⏵⏵ ACCEPT EDITS]");
    expect(stringWidth(row as string)).toBeLessThanOrEqual(160);
  });

  test("warn mode (no glyph) stays within width too", async () => {
    const lines = await renderedLines(
      statusBar({ budget: { spentUsd: 0.045, limitUsd: 0.02, fraction: 2.25, mode: "warn" } }),
      120,
    );
    for (const l of lines) {
      expect(stringWidth(l)).toBeLessThanOrEqual(120);
    }
  });
});
