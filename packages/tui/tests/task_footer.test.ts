import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodoTask } from "../src/tools/todowrite.ts";
import { taskFooterRows } from "../src/tui/task_footer.ts";

function task(content: string, status: TodoTask["status"]): TodoTask {
  return { content, status, priority: "medium" };
}

describe("taskFooterRows — the D3a row builder (CC parity, GT never the gate)", () => {
  test("empty list is ZERO rows — auto-show IS the empty state", () => {
    expect(taskFooterRows([])).toEqual([]);
  });

  test("header shows progress + the in_progress task; next pending row follows", () => {
    const rows = taskFooterRows([
      task("scaffold the parser", "completed"),
      task("wire the panel data", "in_progress"),
      task("write regression tests", "pending"),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]!.text).toBe(" tasks 1/3 · ▸ wire the panel data");
    expect(rows[0]!.bold).toBe(true);
    expect(rows[1]!.text).toBe("   next: write regression tests");
  });

  test("no in_progress task falls back to the first pending", () => {
    const rows = taskFooterRows([task("a", "completed"), task("b", "pending"), task("c", "pending")]);
    expect(rows[0]!.text).toBe(" tasks 1/3 · ▸ b");
    expect(rows[1]!.text).toBe("   next: c");
  });

  test("all completed collapses to a single done row", () => {
    const rows = taskFooterRows([task("a", "completed"), task("b", "completed")]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toBe(" tasks 2/2 · all done");
    expect(rows[0]!.color).toBe("green");
  });

  test("no next row when the current task is the last one", () => {
    const rows = taskFooterRows([task("a", "completed"), task("b", "in_progress")]);
    expect(rows.length).toBe(1);
  });
});

// Source pins (the gt-footer.test.ts pattern): reservation and render must derive from the
// SAME value, and the toggle must work mid-run.
describe("tui/app.tsx wires the D3a task panel", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("render and footerHeight are gated on the SAME taskGranted (lockstep)", () => {
    expect(src).toContain("{taskGranted > 0 && (");
    expect(src).toContain("+ gtRows + taskGranted");
    expect(src).toContain("taskRows.slice(0, taskGranted)");
  });

  test("visibility matches the perm/question suppression rule and defers to the panel", () => {
    const idx = src.indexOf("const taskVisible =");
    expect(idx).toBeGreaterThan(-1);
    const expr = src.slice(idx, idx + 260);
    for (const term of [
      "taskRows.length > 0",
      "!taskPanelHidden",
      "!overlayOpen",
      "!permPrompt",
      "!questionPrompt",
      "!panelVisible",
    ]) {
      expect(expr).toContain(term);
    }
  });

  test("Ctrl+B sits ABOVE the busy gate — mid-run toggling is the point", () => {
    const ctrlB = src.indexOf('key.ctrl && input === "b"');
    const busyGate = src.indexOf("// Everything below opens an overlay / changes mode");
    expect(ctrlB).toBeGreaterThan(-1);
    expect(busyGate).toBeGreaterThan(-1);
    expect(ctrlB).toBeLessThan(busyGate);
  });

  test("refresh is driven by tool_execution_end (no toolName on the event — unfiltered bump)", () => {
    expect(src).toContain("setTodoGen((g) => g + 1)");
  });
});

describe("todoState threading — sub-agents stay isolated", () => {
  test("builtinTools passes the observable array; spawn.ts never provides one", () => {
    const builtin = readFileSync(join(import.meta.dir, "../src/tools/builtin.ts"), "utf8");
    expect(builtin).toContain("todowriteTool(opts.todoState ?? [], {");
    const spawn = readFileSync(join(import.meta.dir, "../src/minima/spawn.ts"), "utf8");
    expect(spawn).not.toContain("todoState");
  });

  test("main.ts hands ONE array to both the toolset and the TUI", () => {
    const main = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");
    expect(main).toContain("const todoState: TodoTask[] = [];");
    expect(main).toContain("toolsFor(args, config.groundTruth === true, todoState)");
    expect(main).toContain("todos: todoState,");
  });
});
