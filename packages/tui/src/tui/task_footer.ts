/**
 * D3a — the compact footer task panel (guide §8 MP5, plan enrichment MP6). Pure row
 * builder: CC-parity, fed straight from todowrite's observable state; with a plan of record the
 * header upgrades to the ledger projection (position/step/drift/plan-scoped cost) and a
 * conditional alert row appears — colored ASCII, no emoji (Q25; the full tiered view is
 * Ctrl+G's job). ONE plan surface: this replaces the old PlanStrip banner + note/block
 * footer rows. Zero rows when there is nothing to show — auto-show IS the empty state.
 * Rows render with wrap="truncate", so no width math lives here.
 */
import type { TodoTask } from "../tools/todowrite.ts";

export interface TaskFooterBigPlan {
  stepPos: number;
  stepTotal: number;
  title: string;
  drift: number;
  /** An unanswered 🔴 gate is armed (routes to the gate-focus modal via ^G). */
  blocked: boolean;
  /** Plan-scoped realized cost (Σ per-step stamps); null hides the cost segment. */
  totalCostUsd: number | null;
}

export interface TaskFooterRow {
  kind: "header" | "alert" | "next";
  text: string;
  color: string;
  bold?: boolean;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

export function taskFooterRows(
  todos: TodoTask[],
  bigPlan?: TaskFooterBigPlan | null,
): TaskFooterRow[] {
  const rows: TaskFooterRow[] = [];
  if (bigPlan) {
    const cost = bigPlan.totalCostUsd !== null ? ` · $${bigPlan.totalCostUsd.toFixed(4)}` : "";
    rows.push({
      kind: "header",
      text: ` plan ${bigPlan.stepPos}/${bigPlan.stepTotal} · ▸ ${oneLine(bigPlan.title)}${cost}`,
      color: "cyan",
      bold: true,
    });
    if (bigPlan.blocked) {
      rows.push({ kind: "alert", text: " !! gate blocked — ^G", color: "red", bold: true });
    } else if (bigPlan.drift > 0) {
      rows.push({
        kind: "alert",
        text: ` drift: ${bigPlan.drift} file${bigPlan.drift === 1 ? "" : "s"} off-plan`,
        color: "yellow",
      });
    }
  } else {
    if (todos.length === 0) return [];
    const done = todos.filter((t) => t.status === "completed").length;
    const current =
      todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
    if (!current) {
      return [
        {
          kind: "header",
          text: ` tasks ${done}/${todos.length} · all done`,
          color: "green",
          bold: true,
        },
      ];
    }
    rows.push({
      kind: "header",
      text: ` tasks ${done}/${todos.length} · ▸ ${oneLine(current.content)}`,
      color: "cyan",
      bold: true,
    });
    const next = todos.slice(todos.indexOf(current) + 1).find((t) => t.status === "pending");
    if (next) rows.push({ kind: "next", text: `   next: ${oneLine(next.content)}`, color: "gray" });
  }
  return rows;
}

/**
 * Collapse the row set into a tight budget: alert wins, then the header, then the next
 * row (the bigPlanFooterFit discipline — reservation and render must consume the SAME result).
 * Display order is preserved.
 */
export function grantTaskRows(rows: TaskFooterRow[], budget: number): TaskFooterRow[] {
  if (budget <= 0) return [];
  if (rows.length <= budget) return rows;
  const priority: Record<TaskFooterRow["kind"], number> = { alert: 0, header: 1, next: 2 };
  const keep = new Set(
    [...rows].sort((a, b) => priority[a.kind] - priority[b.kind]).slice(0, budget),
  );
  return rows.filter((r) => keep.has(r));
}
