import { describe, expect, test } from "bun:test";
import {
  type PanelNavKey,
  type PanelState,
  planOverviewPanelState,
  panelReduce,
  readerView,
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

describe("panelReduce — the pushed reader view (MP8)", () => {
  function withReader(): PanelState {
    const base = open();
    return {
      stack: [...base.stack, readerView("contents ▸ first prompt", ["l1", "l2", "l3", "l4"])],
      pendingG: false,
    };
  }

  test("reader lines are plain stops — j/k move one LINE, not one section", () => {
    let s = withReader();
    s = step(s, "jj");
    expect(cursorOf(s)).toBe(2);
    s = step(s, "k");
    expect(cursorOf(s)).toBe(1);
  });

  test("Esc pops back to the list (same list state), second Esc closes", () => {
    const s = withReader();
    const back = panelReduce(s, "", { escape: true }, INNER);
    expect(back?.stack.length).toBe(1);
    expect(back?.stack[0]!.kind).toBe("toc");
    expect(panelReduce(back!, "", { escape: true }, INNER)).toBeNull();
  });

  test("h and ← also go back from the reader, but are inert on the top-level list", () => {
    expect(panelReduce(withReader(), "h", {}, INNER)?.stack.length).toBe(1);
    expect(panelReduce(withReader(), "", { leftArrow: true }, INNER)?.stack.length).toBe(1);
    const list = open();
    expect(panelReduce(list, "h", {}, INNER)).toBe(list);
  });

  test("an empty reader gets the placeholder line", () => {
    expect(readerView("t", []).lines).toEqual(["(empty section)"]);
  });

  test("embedded newlines are flattened — every view line is exactly ONE terminal row", () => {
    // A multi-row line breaks the panel height identity (log-update desync → ghost row in
    // scrollback; one more row trips the wipe). Caught live on a stepCardLines entry.
    expect(readerView("t", ["a\nb", "c"]).lines).toEqual(["a", "b", "c"]);
  });
});

describe("planOverviewPanelState — the Plan Overview view (MP9)", () => {
  test("stops are the step-title rows and the breadcrumb carries plan position", () => {
    const overview = {
      stepPos: 2,
      stepTotal: 3,
      steps: [],
      gatesByStep: new Map(),
    } as unknown as Parameters<typeof planOverviewPanelState>[0];
    const rows = [
      { text: "⬜ 1. scaffold", stepIdx: 0, isTitle: true },
      { text: "   check: bun test", stepIdx: 0, isTitle: false },
      { text: "🟦 2. wire", stepIdx: 1, isTitle: true },
    ];
    const s = planOverviewPanelState(overview, rows);
    const top = s.stack[0]!;
    expect(top.kind).toBe("plan_overview");
    expect(top.title).toBe("plan · 2/3");
    expect(top.stops).toEqual([0, 2]);
    expect(top.cursor).toBe(0);
  });
});

describe("draft view navigation (MP16)", () => {
  test("j/k step between heading stops, gg/G jump, Esc closes", async () => {
    const { PlanSessionStore } = await import("../src/minima/plan_session.ts");
    const { SEED_ROUND_1 } = await import("../src/minima/plan_seed.ts");
    const { draftPanelState } = await import("../src/tui/plan_draft_view.ts");
    const store = new PlanSessionStore("demo");
    store.applyCouncilResult(SEED_ROUND_1);
    let state: ReturnType<typeof draftPanelState> | null = draftPanelState(store, 80);
    const top = () => state!.stack[state!.stack.length - 1]!;
    expect(top().kind).toBe("draft");
    const stops = top().stops!;
    expect(stops.length).toBeGreaterThanOrEqual(3);
    state = panelReduce(state!, "j", {}, 10);
    expect(top().cursor).toBe(stops[1]!);
    state = panelReduce(state!, "G", {}, 10);
    expect(top().cursor).toBe(stops[stops.length - 1]!);
    state = panelReduce(state!, "gg", {}, 10);
    expect(top().cursor).toBe(stops[0]!);
    state = panelReduce(state!, "", { escape: true }, 10);
    expect(state).toBeNull();
  });
});
