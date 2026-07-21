import type { ChatMessage } from "./messages.tsx";
/**
 * Pure state machine for the expanded live-region panel (D3b — certified by the MP4
 * spike, whose throwaway view died in MP7). No React, no Ink — app.tsx owns the single
 * `panel` state and derives `panelCapture` from it; ExpandPanel forwards raw keys here.
 * Ink delivers a multi-char stdin chunk as ONE input string (a key-repeat storm or
 * coalesced PTY reads arrive as "jjjj"), so character commands iterate the whole string.
 *
 * Views window `lines` and move a cursor. `stops` lists the line indices the cursor may
 * land on (ToC section titles); null means every line is a stop (a plain reader). The
 * cursor is ALWAYS a valid line index — with stops present it is always ON a stop.
 */
import type { PlanOverview, PlanOverviewPanelRow } from "./plan_overview.ts";
import type { TocRow, TocSection } from "./toc.ts";

export interface PanelViewBase {
  title: string;
  lines: string[];
  stops: number[] | null;
  cursor: number;
}

export type PanelView = PanelViewBase &
  (
    | {
        kind: "toc";
        rows: TocRow[];
        sections: TocSection[];
        /** The transcript reference captured at open (immutable-updated → a free snapshot). */
        snapshot: ChatMessage[];
      }
    | { kind: "reader" }
    | { kind: "plan_overview"; rows: PlanOverviewPanelRow[]; overview: PlanOverview }
    | { kind: "draft" }
  );

export interface PanelState {
  stack: PanelView[];
  pendingG: boolean;
}

export interface PanelNavKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
}

function replaceTop(state: PanelState, view: PanelView, pendingG = false): PanelState {
  const top = state.stack[state.stack.length - 1];
  if (view === top && state.pendingG === pendingG) return state;
  return { stack: [...state.stack.slice(0, -1), view], pendingG };
}

function withCursor(view: PanelView, cursor: number): PanelView {
  const max = Math.max(0, view.lines.length - 1);
  const next = Math.max(0, Math.min(max, cursor));
  return next === view.cursor ? view : { ...view, cursor: next };
}

/** ±1 in stop space (j/k, arrows): the next/previous stop, clamped at the ends. */
function stepStop(view: PanelView, dir: 1 | -1): PanelView {
  if (!view.stops || view.stops.length === 0) return withCursor(view, view.cursor + dir);
  const i = view.stops.indexOf(view.cursor);
  const j = Math.max(0, Math.min(view.stops.length - 1, (i === -1 ? 0 : i) + dir));
  return withCursor(view, view.stops[j] ?? view.cursor);
}

/** Jump `delta` LINES (PgUp/PgDn), then snap to the nearest stop in that direction. */
function jumpLines(view: PanelView, delta: number): PanelView {
  const target = view.cursor + delta;
  if (!view.stops || view.stops.length === 0) return withCursor(view, target);
  const s = view.stops;
  const snapped =
    delta > 0
      ? (s.find((x) => x >= target) ?? s[s.length - 1]!)
      : ([...s].reverse().find((x) => x <= target) ?? s[0]!);
  return withCursor(view, snapped);
}

function toEnd(view: PanelView, which: "first" | "last"): PanelView {
  if (!view.stops || view.stops.length === 0) {
    return withCursor(view, which === "first" ? 0 : view.lines.length - 1);
  }
  return withCursor(
    view,
    which === "first" ? (view.stops[0] ?? 0) : (view.stops[view.stops.length - 1] ?? 0),
  );
}

/** h/← go BACK one view (reader → list); inert on the top-level view (Esc closes there). */
function popIfNested(state: PanelState): PanelState {
  if (state.stack.length <= 1) {
    return state.pendingG ? { stack: state.stack, pendingG: false } : state;
  }
  return { stack: state.stack.slice(0, -1), pendingG: false };
}

function applyChar(state: PanelState, ch: string): PanelState {
  const top = state.stack[state.stack.length - 1];
  if (!top) return state;
  switch (ch) {
    case "h":
      return popIfNested(state);
    case "j":
      return replaceTop(state, stepStop(top, 1));
    case "k":
      return replaceTop(state, stepStop(top, -1));
    case "G":
      return replaceTop(state, toEnd(top, "last"));
    case "g":
      if (state.pendingG) return replaceTop(state, toEnd(top, "first"));
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
  if (key.downArrow) return replaceTop(state, stepStop(top, 1));
  if (key.upArrow) return replaceTop(state, stepStop(top, -1));
  if (key.leftArrow) return popIfNested(state);
  if (key.pageDown) return replaceTop(state, jumpLines(top, innerHeight));
  if (key.pageUp) return replaceTop(state, jumpLines(top, -innerHeight));
  let next = state;
  for (const ch of input) next = applyChar(next, ch);
  return next;
}

/** The ToC browser view (D3b v1): snapshot-at-open, cursor stops on section titles. */
export function tocPanelState(
  sections: TocSection[],
  rows: TocRow[],
  snapshot: ChatMessage[],
): PanelState {
  const lines = rows.length > 0 ? rows.map((r) => r.text) : ["(empty session)"];
  const stops = rows.flatMap((r, i) => (r.isTitle ? [i] : []));
  return {
    stack: [
      {
        kind: "toc",
        title: "contents",
        lines,
        stops,
        cursor: stops[0] ?? 0,
        rows,
        sections,
        snapshot,
      },
    ],
    pendingG: false,
  };
}

/**
 * A pushed reader view (MP8): plain line scroll, every line a stop. Embedded newlines are
 * flattened — every view line MUST render exactly one terminal row or the panel frame
 * outgrows the height identity: log-update desyncs, a ghost row leaks into scrollback,
 * and one more row trips Ink's wipe (caught live by the panel-plan-overview scenario on a
 * stepCardLines entry that carried a newline).
 */
export function readerView(title: string, lines: string[]): PanelView {
  const flat = lines.flatMap((l) => l.split("\n"));
  return {
    kind: "reader",
    title,
    lines: flat.length > 0 ? flat : ["(empty section)"],
    stops: null,
    cursor: 0,
  };
}

/** The Plan Overview view (MP9): snapshot-at-open, cursor stops on step-title rows. */
export function planOverviewPanelState(
  overview: PlanOverview,
  rows: PlanOverviewPanelRow[],
): PanelState {
  const lines = rows.length > 0 ? rows.map((r) => r.text) : ["(no plan steps)"];
  const stops = rows.flatMap((r, i) => (r.isTitle ? [i] : []));
  return {
    stack: [
      {
        kind: "plan_overview",
        title: `plan · ${overview.stepPos}/${overview.stepTotal}`,
        lines,
        stops,
        cursor: stops[0] ?? 0,
        rows,
        overview,
      },
    ],
    pendingG: false,
  };
}
