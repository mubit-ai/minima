import { describe, expect, test } from "bun:test";
import {
  type PanelNavKey,
  type PanelState,
  panelReduce,
  spikePanelState,
} from "../src/tui/panel_state.ts";

const INNER = 23;

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

describe("panelReduce — cursor movement", () => {
  test("j/k move by one and clamp at both ends", () => {
    let s = spikePanelState();
    expect(cursorOf(s)).toBe(0);
    s = step(s, "k");
    expect(cursorOf(s)).toBe(0);
    s = step(s, "j");
    expect(cursorOf(s)).toBe(1);
    s = step(s, "k");
    expect(cursorOf(s)).toBe(0);
  });

  test("a multi-char chunk applies every character (Ink delivers coalesced stdin as ONE input)", () => {
    let s = spikePanelState();
    s = step(s, "jjjjjjjjjj");
    expect(cursorOf(s)).toBe(10);
    s = step(s, "kkk");
    expect(cursorOf(s)).toBe(7);
  });

  test("arrows mirror j/k", () => {
    let s = spikePanelState();
    s = step(s, "", { downArrow: true });
    s = step(s, "", { downArrow: true });
    expect(cursorOf(s)).toBe(2);
    s = step(s, "", { upArrow: true });
    expect(cursorOf(s)).toBe(1);
  });

  test("PgDn/PgUp move by the inner window height", () => {
    let s = spikePanelState();
    s = step(s, "", { pageDown: true });
    expect(cursorOf(s)).toBe(INNER);
    s = step(s, "", { pageUp: true });
    expect(cursorOf(s)).toBe(0);
    s = step(s, "", { pageUp: true });
    expect(cursorOf(s)).toBe(0);
  });

  test("G jumps to the last line, gg back to the top — including 'gg' in one chunk", () => {
    let s = spikePanelState();
    s = step(s, "G");
    expect(cursorOf(s)).toBe(499);
    s = step(s, "gg");
    expect(cursorOf(s)).toBe(0);
  });

  test("split g…g across chunks still jumps; an interposed key cancels the pending g", () => {
    let s = spikePanelState();
    s = step(s, "G");
    s = step(s, "g");
    expect(s.pendingG).toBe(true);
    s = step(s, "g");
    expect(cursorOf(s)).toBe(0);
    s = step(s, "G");
    s = step(s, "g");
    s = step(s, "j");
    expect(s.pendingG).toBe(false);
    expect(cursorOf(s)).toBe(499);
  });
});

describe("panelReduce — close semantics", () => {
  test("Esc on the only view closes (null)", () => {
    const s = spikePanelState();
    expect(panelReduce(s, "", { escape: true }, INNER)).toBeNull();
  });

  test("unknown keys are inert and keep the same state object", () => {
    const s = spikePanelState();
    expect(panelReduce(s, "x", {}, INNER)).toBe(s);
  });
});
