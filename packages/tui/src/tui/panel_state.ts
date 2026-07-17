/**
 * Pure state machine for the expanded live-region panel (D3b; the MP4 spike view is its
 * geometry-certification stand-in, deleted in MP7). No React, no Ink — app.tsx owns the
 * single `panel` state and derives `panelCapture` from it; ExpandPanel forwards raw keys
 * here. Ink delivers a multi-char stdin chunk as ONE input string (a key-repeat storm or
 * coalesced PTY reads arrive as "jjjj"), so character commands iterate the whole string.
 */

export interface PanelView {
  kind: "spike";
  title: string;
  lines: string[];
  cursor: number;
}

export interface PanelState {
  stack: PanelView[];
  pendingG: boolean;
}

export interface PanelNavKey {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
}

function withCursor(view: PanelView, cursor: number): PanelView {
  const max = Math.max(0, view.lines.length - 1);
  const next = Math.max(0, Math.min(max, cursor));
  return next === view.cursor ? view : { ...view, cursor: next };
}

function replaceTop(state: PanelState, view: PanelView, pendingG = false): PanelState {
  const top = state.stack[state.stack.length - 1];
  if (view === top && state.pendingG === pendingG) return state;
  return { stack: [...state.stack.slice(0, -1), view], pendingG };
}

function applyChar(state: PanelState, ch: string): PanelState {
  const top = state.stack[state.stack.length - 1];
  if (!top) return state;
  switch (ch) {
    case "j":
      return replaceTop(state, withCursor(top, top.cursor + 1));
    case "k":
      return replaceTop(state, withCursor(top, top.cursor - 1));
    case "G":
      return replaceTop(state, withCursor(top, top.lines.length - 1));
    case "g":
      if (state.pendingG) return replaceTop(state, withCursor(top, 0));
      return { stack: state.stack, pendingG: true };
    default:
      return state.pendingG ? { stack: state.stack, pendingG: false } : state;
  }
}

/** Returns the next state, or null when the panel should close (Esc on the last view). */
export function panelReduce(
  state: PanelState,
  input: string,
  key: PanelNavKey,
  innerHeight: number,
): PanelState | null {
  const top = state.stack[state.stack.length - 1];
  if (!top) return null;
  if (key.escape) {
    const stack = state.stack.slice(0, -1);
    return stack.length === 0 ? null : { stack, pendingG: false };
  }
  if (key.downArrow) return replaceTop(state, withCursor(top, top.cursor + 1));
  if (key.upArrow) return replaceTop(state, withCursor(top, top.cursor - 1));
  if (key.pageDown) return replaceTop(state, withCursor(top, top.cursor + innerHeight));
  if (key.pageUp) return replaceTop(state, withCursor(top, top.cursor - innerHeight));
  let next = state;
  for (const ch of input) next = applyChar(next, ch);
  return next;
}

/** MP4 only: the 500-line certification list. Deleted when MP7 lands the real views. */
export function spikePanelState(): PanelState {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
  return {
    stack: [{ kind: "spike", title: "spike", lines, cursor: 0 }],
    pendingG: false,
  };
}
