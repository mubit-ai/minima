import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCROLLBACK_SAFETY_ROWS, nextLiveFrameHeight } from "../src/tui/layout.ts";

// Deterministic PRNG (LCG) — property tests must not flake run-to-run.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe("nextLiveFrameHeight — the anchor-ledger kernel", () => {
  test("never exceeds the cap (rows − SCROLLBACK_SAFETY_ROWS)", () => {
    expect(nextLiveFrameHeight(100, 0, 100, 36)).toBe(36 - SCROLLBACK_SAFETY_ROWS);
    expect(nextLiveFrameHeight(0, 0, 999, 24)).toBe(24 - SCROLLBACK_SAFETY_ROWS);
  });
  test("never shrinks faster than the committed rows (the floor)", () => {
    // prev 30, commit 4 → floor 26 even though content only needs 10
    expect(nextLiveFrameHeight(30, 4, 10, 36)).toBe(26);
    // no commit → height cannot shrink at all
    expect(nextLiveFrameHeight(30, 0, 10, 36)).toBe(30);
  });
  test("decays by exactly K when content permits", () => {
    let h = 34;
    for (const k of [5, 5, 5, 5]) h = nextLiveFrameHeight(h, k, 8, 36);
    expect(h).toBe(34 - 20);
  });
  test("reset (prev 0) yields the content height", () => {
    expect(nextLiveFrameHeight(0, 0, 12, 36)).toBe(12);
  });
  test("grows to content immediately (growth re-pins via terminal scroll)", () => {
    expect(nextLiveFrameHeight(10, 0, 30, 36)).toBe(30);
  });
  test("a stale prev above the cap is clamped before the floor math", () => {
    expect(nextLiveFrameHeight(50, 0, 5, 36)).toBe(34);
  });
});

/**
 * Terminal simulator with log-update semantics: each flush erases the previous frame at its
 * TOP anchor, prints K static rows there, then the new frame below them; writes past the
 * last row scroll the terminal (which is the only thing that ever re-pins the bottom).
 * gap = rows below the frame bottom (0 = anchored, THE RULE).
 */
function makeTerm(rows: number) {
  return {
    rows,
    top: rows, // startup newline reserve: the first frame writes at the bottom edge
    height: 0,
    flush(k: number, newHeight: number) {
      const bottom = this.top + k + newHeight;
      this.top = bottom > this.rows ? this.rows - newHeight : this.top + k;
      this.height = newHeight;
      return this.rows - (this.top + this.height); // the gap
    },
  };
}

describe("anchor-ledger invariant — simulated log-update terminal", () => {
  test("steady state: the frame bottom IS the terminal bottom after every flush", () => {
    const rnd = lcg(0xa11c0);
    for (const rows of [24, 36, 50]) {
      const term = makeTerm(rows);
      let ledger = 0; // liveHeightRef — per COMMIT, not per flush
      let pendingK = 0;
      for (let i = 0; i < 2000; i++) {
        const k = rnd() < 0.4 ? Math.floor(rnd() * 12) : 0;
        const content = 1 + Math.floor(rnd() * (rows + 6)); // may exceed the cap (clipped)
        ledger = nextLiveFrameHeight(ledger, k, content, rows);
        pendingK += k;
        // Ink's 32ms write throttle: only some commits reach the terminal. The ledger's
        // telescoping floor must keep coalesced flushes anchored too.
        if (rnd() < 0.6) {
          const gap = term.flush(pendingK, ledger);
          pendingK = 0;
          expect(gap).toBe(0);
        }
      }
    }
  });

  test("resize reset: cap-seeded frame lands within SCROLLBACK_SAFETY_ROWS, re-pins as commits land", () => {
    const rnd = lcg(0xbeef);
    for (let run = 0; run < 200; run++) {
      const rows = 24 + Math.floor(rnd() * 30);
      const term = makeTerm(rows);
      // Post-resize (possibly post-wipe) state: the frame sits at an arbitrary row.
      term.height = 1 + Math.floor(rnd() * (rows - 2));
      term.top = Math.floor(rnd() * (rows - term.height));
      // The app seeds prev = cap on a resize reset → one full-height frame. While frames
      // ride the floor at cap the residual gap is bounded by the safety margin; it closes
      // exactly when the frame turns content-driven again (a couple of commits).
      let ledger = nextLiveFrameHeight(rows - SCROLLBACK_SAFETY_ROWS, 0, 5, rows);
      expect(term.flush(0, ledger)).toBeLessThanOrEqual(SCROLLBACK_SAFETY_ROWS);
      let gap = SCROLLBACK_SAFETY_ROWS;
      for (let i = 0; i < 8; i++) {
        ledger = nextLiveFrameHeight(ledger, 8, 10, rows);
        gap = term.flush(8, ledger);
        expect(gap).toBeLessThanOrEqual(SCROLLBACK_SAFETY_ROWS);
      }
      expect(gap).toBe(0);
    }
  });

  test("the MP20 wide-terminal case: commit smaller than the stream-frame shrink stays anchored", () => {
    // At 200 cols the committed reply wraps to FEWER rows than the stream frame it replaces —
    // pre-ledger this floated the composer by the difference (before-evidence: low 42/50).
    const rows = 50;
    const term = makeTerm(rows);
    let ledger = 0;
    ledger = nextLiveFrameHeight(ledger, 0, 10, rows); // idle composer
    expect(term.flush(0, ledger)).toBe(0);
    ledger = nextLiveFrameHeight(ledger, 0, 44, rows); // stream grows the live frame
    expect(term.flush(0, ledger)).toBe(0);
    ledger = nextLiveFrameHeight(ledger, 0, 10, rows); // teardown flush (MP20 order): K=0
    expect(term.flush(0, ledger)).toBe(0); // floor holds the height — padding, not a float
    ledger = nextLiveFrameHeight(ledger, 28, 10, rows); // commit: 28 rows < the 34-row shrink
    expect(term.flush(28, ledger)).toBe(0);
  });
});

describe("app.tsx wires the anchor ledger", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the live box carries an explicit ledger height + overflow clip (wipe unreachable)", () => {
    expect(src).toContain("height={ANCHOR_LEGACY ? undefined : liveHeight}");
    expect(src).toContain('overflow={ANCHOR_LEGACY ? undefined : "hidden"}');
  });

  test("minHeight bottom-mount survives ONLY behind the legacy flag", () => {
    const minHeights = src.match(/minHeight=\{[^}]*bottomMountMinRows[^}]*\}/g) ?? [];
    expect(minHeights.length).toBe(1);
    expect(minHeights[0]).toContain("ANCHOR_LEGACY");
  });

  test("the inner no-shrink wrapper exists (fixed height must top-clip, never compress)", () => {
    const mount = src.indexOf("height={ANCHOR_LEGACY ? undefined : liveHeight}");
    const wrapper = src.indexOf('<Box flexDirection="column" flexShrink={0}>', mount);
    expect(mount).toBeGreaterThan(0);
    expect(wrapper).toBeGreaterThan(mount);
  });

  test("<Static> stays on the flex-start root, outside the ledger box", () => {
    const staticMount = src.indexOf("<Static key={transcriptGen}");
    const mount = src.indexOf("height={ANCHOR_LEGACY ? undefined : liveHeight}");
    expect(staticMount).toBeGreaterThan(0);
    expect(staticMount).toBeLessThan(mount);
  });
});
