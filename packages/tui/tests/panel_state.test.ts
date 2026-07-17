import { describe, expect, test } from "bun:test";
import {
  type PanelNavKey,
  type PanelState,
  panelReduce,
  tocPanelState,
} from "../src/tui/panel_state.ts";
import type { TocRow, TocSection } from "../src/tui/toc.ts";

const INNER = 23;

// A 3-section ToC shape: title rows at 0, 3, 6; children between; footer at 8.
function fakeRows(): TocRow[] {
  const mk = (text: string, sectionIdx: number, isTitle: boolean): TocRow => ({
    text,
    sectionIdx,
    isTitle,
  });
  return [
    mk("1. first prompt", 0, true),
    mk("   · result", 0, false),
    mk("   ─", 0, false),
    mk("2. second prompt", 1, true),
    mk("   · result", 1, false),
    mk("   ─", 1, false),
    mk("3. third prompt", 2, true),
    mk("   · result", 2, false),
    mk("Σ 1.2k tok (lead agent)", 2, false),
  ];
}

function open(): PanelState {
  return tocPanelState(
    [{ index: 0 } as TocSection, { index: 1 } as TocSection, { index: 2 } as TocSection],
    fakeRows(),
    [],
  );
}

function cursorOf(state: PanelState | null): number {
  if (!state) throw new Error("panel closed unexpectedly");
  const top = state.stack[state.stack.length - 1];
  if (!top) throw new Error("empty panel stack");
  return top.cursor;
}

function step(state: PanelState, input: string, key: PanelNavKey = {}): PanelState {
  const next = panelReduce(state, input, key, INNER);
  if (!next) throw new Error("panel closed unexpectedly");
  return next;
}

describe("tocPanelState", () => {
  test("cursor starts on the first section title; stops are exactly the title rows", () => {
    const s = open();
    const top = s.stack[0]!;
    expect(top.cursor).toBe(0);
    expect(top.stops).toEqual([0, 3, 6]);
    expect(top.lines.length).toBe(9);
  });

  test("an empty session renders a placeholder line with no stops", () => {
    const s = tocPanelState([], [], []);
    expect(s.stack[0]!.lines).toEqual(["(empty session)"]);
    expect(s.stack[0]!.stops).toEqual([]);
  });
});

describe("panelReduce — title-stop cursor (the ToC list)", () => {
  test("j/k move BETWEEN section titles, skipping child rows; clamped at the ends", () => {
    let s = open();
    s = step(s, "j");
    expect(cursorOf(s)).toBe(3);
    s = step(s, "j");
    expect(cursorOf(s)).toBe(6);
    s = step(s, "j");
    expect(cursorOf(s)).toBe(6);
    s = step(s, "kk");
    expect(cursorOf(s)).toBe(0);
    s = step(s, "k");
    expect(cursorOf(s)).toBe(0);
  });

  test("a coalesced chunk applies every character (Ink delivers stdin as ONE string)", () => {
    const s = step(open(), "jj");
    expect(cursorOf(s)).toBe(6);
  });

  test("arrows mirror j/k", () => {
    let s = open();
    s = step(s, "", { downArrow: true });
    expect(cursorOf(s)).toBe(3);
    s = step(s, "", { upArrow: true });
    expect(cursorOf(s)).toBe(0);
  });

  test("PgDn jumps by the window height then snaps to a stop in that direction", () => {
    let s = open();
    s = step(s, "", { pageDown: true });
    // target 0+23 > last line → snaps back to the LAST stop (6), not past the list.
    expect(cursorOf(s)).toBe(6);
    s = step(s, "", { pageUp: true });
    expect(cursorOf(s)).toBe(0);
  });

  test("G/gg jump to the last/first section title — including 'gg' in one chunk", () => {
    let s = open();
    s = step(s, "G");
    expect(cursorOf(s)).toBe(6);
    s = step(s, "gg");
    expect(cursorOf(s)).toBe(0);
    s = step(s, "G");
    s = step(s, "g");
    expect(s.pendingG).toBe(true);
    s = step(s, "j");
    expect(s.pendingG).toBe(false);
    expect(cursorOf(s)).toBe(6);
  });
});

describe("panelReduce — close semantics", () => {
  test("Esc on the only view closes (null)", () => {
    expect(panelReduce(open(), "", { escape: true }, INNER)).toBeNull();
  });

  test("unknown keys are inert and keep the same state object", () => {
    const s = open();
    expect(panelReduce(s, "x", {}, INNER)).toBe(s);
  });
});
