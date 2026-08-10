import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Box, render } from "ink";
import type React from "react";
import stringWidth from "string-width";
import type { EffortModel } from "../src/ai/provider_quirks.ts";
import type { ContextUsage } from "../src/tui/context_meter.ts";
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

const ctxUsage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  usedTokens: 68_000,
  windowTokens: 200_000,
  pct: 34,
  basis: "exact",
  inputTokens: 4273,
  outputTokens: 3624,
  ...over,
});

function statusBar(over: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <StatusBar
        model="gemini-2.5-pro"
        basis="prior"
        routeMode="auto"
        thinkingLevel="off"
        ctx={ctxUsage()}
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

/** Render at `columns`, with the StatusBar told the same width the terminal has. */
function statusLines(
  columns: number,
  over: Partial<React.ComponentProps<typeof StatusBar>> = {},
): Promise<string[]> {
  return renderedLines(statusBar({ columns, ...over }), columns);
}

/** The rendered rows, blank padding dropped — app.tsx's footerHeight and layout.ts's
 * PANEL_STATUS_ROWS both hard-assume the status bar is exactly two of them. */
function statusRows(lines: string[]): string[] {
  return lines.filter((l) => l.trim().length > 0);
}

describe("footer row physical width (enforce ⛔ + badge)", () => {
  test("enforce-mode footer never exceeds the terminal width", async () => {
    for (const columns of [80, 100, 110, 120, 140]) {
      const lines = await statusLines(columns);
      for (const l of lines) {
        expect(stringWidth(l)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("at full width the ⛔ marker and the whole badge render on one row", async () => {
    const lines = await statusLines(160);
    const row = lines.findLast((l) => l.includes("model:"));
    expect(row).toBeDefined();
    expect(row as string).toContain("⛔");
    expect(row as string).toContain("[⏵⏵ ACCEPT EDITS]");
    expect(stringWidth(row as string)).toBeLessThanOrEqual(160);
  });

  test("warn mode (no glyph) stays within width too", async () => {
    const lines = await statusLines(120, {
      budget: { spentUsd: 0.045, limitUsd: 0.02, fraction: 2.25, mode: "warn" },
    });
    for (const l of lines) {
      expect(stringWidth(l)).toBeLessThanOrEqual(120);
    }
  });
});

// The ctx segment grew by up to 11 cells, paid for by dropping `route:`/`reason:` when they
// hold their shipped defaults. The budget was measured here, not hand-counted: package.json
// overrides is-fullwidth-code-point precisely because ⛔ measures differently across
// versions, so this file — real Ink, real width tables, emitted bytes — is the arbiter.
describe("the context segment fits, and never adds a row", () => {
  const worst = {
    routeMode: "confirm",
    thinkingLevel: "high",
    queueNote: "2 queued · held (esc clears)",
    activeChildren: 3,
    routingOffline: true,
    offlineReason: "minima unreachable",
  } as const;

  test("worst case at every width: every line fits", async () => {
    for (const columns of [80, 100, 120, 160]) {
      const lines = await statusLines(columns, worst);
      for (const l of lines) {
        expect(stringWidth(l)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("exactly two status rows, default and worst case, at every width", async () => {
    for (const columns of [80, 100, 120, 160]) {
      expect(statusRows(await statusLines(columns))).toHaveLength(2);
      expect(statusRows(await statusLines(columns, worst))).toHaveLength(2);
    }
  });

  test("the parenthetical is responsive: shown at >= 100 columns, dropped below", async () => {
    const wide = statusRows(await statusLines(120))[0] as string;
    expect(wide).toContain("ctx 34% (68k/200k)");
    const narrow = statusRows(await statusLines(80))[0] as string;
    expect(narrow).toContain("ctx 34%");
    expect(narrow).not.toContain("68k");
  });

  test("route:/reason: are dropped at their defaults and restored when they are not", async () => {
    const quiet = statusRows(await statusLines(160))[0] as string;
    expect(quiet).not.toContain("route:");
    expect(quiet).not.toContain("reason:");
    const loud = statusRows(await statusLines(160, worst))[0] as string;
    expect(loud).toContain("route: confirm");
    expect(loud).toContain("reason: high");
  });

  test("an unresolvable window renders ctx ?%, never a confident ctx 0%", async () => {
    const row = statusRows(
      await statusLines(120, { ctx: ctxUsage({ pct: null, windowTokens: null }) }),
    )[0] as string;
    expect(row).toContain("ctx ?%");
    expect(row).toContain("(68k/?)");
    expect(row).not.toContain("ctx 0%");
  });

  test("an estimated basis is marked with a tilde", async () => {
    const row = statusRows(
      await statusLines(120, {
        ctx: ctxUsage({ basis: "estimated", pct: 12, usedTokens: 24_000 }),
      }),
    )[0] as string;
    expect(row).toContain("ctx ~12% (24k/200k)");
  });

  test("a fresh, empty context is a plain 0% — nothing to estimate, nothing unknown", async () => {
    const row = statusRows(
      await statusLines(120, {
        ctx: {
          usedTokens: 0,
          windowTokens: null,
          pct: null,
          basis: "estimated",
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
    )[0] as string;
    expect(row).toContain("ctx 0%");
    expect(row).not.toContain("ctx ~");
    expect(row).not.toContain("ctx ?%");
  });

  // MUB-229: the reason segment used to render the requested level whatever the wire did.
  // These go through real Ink, so they assert the row the user actually reads.
  describe("the reason segment renders the EFFECTIVE effort", () => {
    const reasoner: EffortModel = { provider: "openai", reasoning: true };

    test("a clamped level renders requested→effective", async () => {
      const row = statusRows(
        await statusLines(160, { thinkingLevel: "xhigh", effortModel: reasoner }),
      )[0] as string;
      expect(row).toContain("reason: xhigh→high");
    });

    test("an honoured level renders bare, with no arrow", async () => {
      const row = statusRows(
        await statusLines(160, { thinkingLevel: "medium", effortModel: reasoner }),
      )[0] as string;
      expect(row).toContain("reason: medium");
      expect(row).not.toContain("→");
    });

    test("the tools pin is visible even with thinking off — it explains a silent model", async () => {
      const pinned = { ...reasoner, tools_require_effort_none: true };
      const row = statusRows(
        await statusLines(160, { thinkingLevel: "off", effortModel: pinned, hasTools: true }),
      )[0] as string;
      expect(row).toContain("reason: none");
    });
  });

  test("MINIMA_TUI_CONTEXT_METER=0 renders the pre-fix row: bare ctx%, route: and reason: back", async () => {
    const row = statusRows(
      await statusLines(160, { contextMeter: false, ctx: ctxUsage({ pct: 0 }) }),
    )[0] as string;
    expect(row).toContain("route: auto");
    expect(row).toContain("reason: off");
    expect(row).toContain("ctx 0%");
    expect(row).not.toContain("68k");
    expect(row).not.toContain("ctx ~");
  });
});
