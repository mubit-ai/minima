/**
 * plan_draft_view — the D3b `plan (draft)` view (MP16): the evolving plan visible WHILE it
 * is being drafted, not only after /plan finalize writes BigPlan.md. Pure builders
 * (no React) over the in-memory PlanSessionStore: `toMarkdown()` is flattened through the
 * SAME classifyMarkdownLines + wrapLineToWidth pair the transcript renderer and height
 * math use (MP11 lockstep), so every emitted row renders exactly one terminal row — the
 * panel frame-height identity that keeps log-update in sync (see readerView's warning).
 * Snapshot-at-open: rows are copied strings; the store mutating later is invisible until
 * reopen, and the round count in the title says which snapshot you are looking at.
 */
import type { PlanSessionStore } from "../minima/plan_session.ts";
import { classifyMarkdownLines, wrapLineToWidth } from "./layout.ts";
import type { PanelState } from "./panel_state.ts";

export interface DraftPanelRow {
  text: string;
  /** Cursor stop (a heading's first wrapped row). */
  isTitle: boolean;
}

export function draftRows(store: PlanSessionStore, innerWidth: number): DraftPanelRow[] {
  const w = Math.max(20, innerWidth);
  const out: DraftPanelRow[] = [];
  const push = (lines: string[], isTitle: boolean): void => {
    lines.forEach((text, i) => out.push({ text, isTitle: isTitle && i === 0 }));
  };
  for (const l of classifyMarkdownLines(store.toMarkdown())) {
    switch (l.kind) {
      case "heading":
        push(wrapLineToWidth(l.text, w), true);
        break;
      case "list":
        push(
          wrapLineToWidth(l.text, w - 2).map((row, i) => (i === 0 ? `- ${row}` : `  ${row}`)),
          false,
        );
        break;
      default:
        push(wrapLineToWidth(l.text, w), false);
    }
  }
  while (out.length > 0 && out[out.length - 1]!.text.trim() === "") out.pop();
  return out.length > 0 ? out : [{ text: "(empty plan session)", isTitle: false }];
}

/** The plan-draft view: heading rows are cursor stops; Enter is inert (nothing to push). */
export function draftPanelState(store: PlanSessionStore, innerWidth: number): PanelState {
  const rows = draftRows(store, innerWidth);
  const lines = rows.map((r) => r.text);
  const stops = rows.flatMap((r, i) => (r.isTitle ? [i] : []));
  return {
    stack: [
      {
        kind: "draft",
        title: `plan (draft) · round ${store.session.rounds}`,
        lines,
        stops: stops.length > 0 ? stops : null,
        cursor: stops[0] ?? 0,
      },
    ],
    pendingG: false,
  };
}
