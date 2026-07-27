import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { PlanSessionStore } from "../src/minima/plan_session.ts";
import { wrapLineToWidth } from "../src/tui/layout.ts";
import { draftPanelState, draftRows } from "../src/tui/plan_draft_view.ts";

const round = (over: Record<string, unknown> = {}) => ({
  draft: "",
  decisions: [],
  findings: [],
  faults: [],
  questions: [],
  facts: [],
  constraints: [],
  costUsd: 0,
  aborted: false,
  ...over,
});

const seeded = (): PlanSessionStore => {
  const store = new PlanSessionStore("ship the demo widget");
  store.applyCouncilResult(
    round({
      draft: [
        "## Demo widget plan",
        "",
        "1. Scaffold `demo_widget.ts` with the render entry point.",
        "2. Pin the rendered rows with a regression test.",
        "",
        "```ts",
        "export function demoWidget(): Widget {",
        "\treturn factory({ id: 'demo' });",
        "}",
        "```",
      ].join("\n"),
      findings: [
        { source: "critic", summary: "row pin must cover the 60-col floor", severity: "concern" },
      ],
      questions: [
        {
          question: "Should the widget register eagerly or lazily?",
          header: "registration",
          options: [{ label: "eager", description: "simple", recommended: true }],
          why: "affects startup",
        },
      ],
    }) as never,
  );
  return store;
};

describe("draftRows — the plan-draft D3b content builder (MP16)", () => {
  test("headings become cursor stops; only the FIRST wrapped row of a heading is a stop", () => {
    const rows = draftRows(seeded(), 80);
    const stops = rows.flatMap((r, i) => (r.isTitle ? [i] : []));
    expect(stops.length).toBeGreaterThanOrEqual(3);
    const titleTexts = stops.map((i) => rows[i]!.text);
    expect(titleTexts.some((t) => t.includes("Plan"))).toBe(true);
    expect(titleTexts.some((t) => t.includes("Open Questions"))).toBe(true);
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i]!.isTitle) expect(rows[i + 1]!.isTitle && rows[i + 1]!.text === "").toBe(false);
    }
  });

  test("every row is ONE terminal row: no embedded newlines, display width within the panel", () => {
    const store = seeded();
    store.applyCouncilResult(
      round({ draft: `long line ${"x".repeat(200)} tail\n\ttabbed code` }) as never,
    );
    for (const w of [24, 37, 60, 80]) {
      for (const r of draftRows(store, w)) {
        expect(r.text.includes("\n")).toBe(false);
        expect(stringWidth(r.text)).toBeLessThanOrEqual(w);
      }
    }
  });

  test("steps, open questions, and council verdicts all surface", () => {
    const rows = draftRows(seeded(), 100);
    const all = rows.map((r) => r.text).join("\n");
    expect(all).toContain("Scaffold");
    expect(all).toContain("Should the widget register eagerly or lazily?");
    expect(all).toContain("(critic/concern) row pin must cover the 60-col floor");
  });

  test("wrap parity: a plain long paragraph's rows equal wrapLineToWidth output", () => {
    const store = new PlanSessionStore("goal");
    const para = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
    store.applyCouncilResult(round({ draft: para }) as never);
    const rows = draftRows(store, 24).map((r) => r.text);
    const expected = wrapLineToWidth(para, 24);
    for (const line of expected) expect(rows).toContain(line);
  });
});

describe("draftPanelState — snapshot-at-open panel view (MP16)", () => {
  test("titles the view with the council round count (the convergence signal)", () => {
    const state = draftPanelState(seeded(), 100);
    const top = state.stack[0]!;
    expect(top.kind).toBe("draft");
    expect(top.title).toBe("plan (draft) · round 1");
    expect(top.stops?.length ?? 0).toBeGreaterThan(0);
    expect(top.cursor).toBe(top.stops![0]!);
  });

  test("snapshot-at-open: mutating the store after build does not change the view lines", () => {
    const store = seeded();
    const state = draftPanelState(store, 100);
    const before = [...state.stack[0]!.lines];
    store.applyCouncilResult(round({ draft: "COMPLETELY DIFFERENT PLAN." }) as never);
    expect(state.stack[0]!.lines).toEqual(before);
  });

  test("an empty session builds a browsable placeholder", () => {
    const state = draftPanelState(new PlanSessionStore(""), 80);
    const top = state.stack[0]!;
    expect(top.lines.length).toBeGreaterThan(0);
    expect(top.cursor).toBeGreaterThanOrEqual(0);
  });
});
