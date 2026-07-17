/**
 * D3a — the compact footer task panel (guide §8 MP5). Pure row builder: CC-parity, fed
 * straight from todowrite's observable state (GT is an enrichment, MP6 — never the gate).
 * Fixed shape so footerChrome stays predictable: header row (progress + current task),
 * plus a next-task row the caller renders only if the row budget grants it. Zero rows
 * when the list is empty — the auto-show behavior IS the empty state. Rows render with
 * wrap="truncate", so no width math lives here.
 */
import type { TodoTask } from "../tools/todowrite.ts";

export interface TaskFooterRow {
  text: string;
  color: string;
  bold?: boolean;
}

export function taskFooterRows(todos: TodoTask[]): TaskFooterRow[] {
  if (todos.length === 0) return [];
  const done = todos.filter((t) => t.status === "completed").length;
  const current =
    todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  if (!current) {
    return [{ text: ` tasks ${done}/${todos.length} · all done`, color: "green", bold: true }];
  }
  const rows: TaskFooterRow[] = [
    { text: ` tasks ${done}/${todos.length} · ▸ ${current.content}`, color: "cyan", bold: true },
  ];
  const next = todos.slice(todos.indexOf(current) + 1).find((t) => t.status === "pending");
  if (next) rows.push({ text: `   next: ${next.content}`, color: "gray" });
  return rows;
}
