import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodoTask } from "../src/tools/todowrite.ts";
import { grantTaskRows, taskFooterRows } from "../src/tui/task_footer.ts";

function task(content: string, status: TodoTask["status"]): TodoTask {
  return { content, status, priority: "medium" };
}

const GT = {
  stepPos: 2,
  stepTotal: 5,
  title: "Wire the router",
  drift: 0,
  blocked: false,
  totalCostUsd: null,
};

describe("taskFooterRows — the D3a row builder (CC parity, GT never the gate)", () => {
  test("empty list is ZERO rows — auto-show IS the empty state", () => {
    expect(taskFooterRows([])).toEqual([]);
    expect(taskFooterRows([], null)).toEqual([]);
  });

  test("header shows progress + the in_progress task; next pending row follows", () => {
    const rows = taskFooterRows([
      task("scaffold the parser", "completed"),
      task("wire the panel data", "in_progress"),
      task("write regression tests", "pending"),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]!.text).toBe(" tasks 1/3 · ▸ wire the panel data");
    expect(rows[0]!.kind).toBe("header");
    expect(rows[0]!.bold).toBe(true);
    expect(rows[1]!.text).toBe("   next: write regression tests");
    expect(rows[1]!.kind).toBe("next");
  });

  test("no in_progress task falls back to the first pending", () => {
    const rows = taskFooterRows([
      task("a", "completed"),
      task("b", "pending"),
      task("c", "pending"),
    ]);
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

describe("taskFooterRows — GT enrichment (MP6: ONE plan surface)", () => {
  test("a GT plan upgrades the header to the ledger projection, even with no session todos", () => {
    const rows = taskFooterRows([], GT);
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toBe(" plan 2/5 · ▸ Wire the router");
    expect(rows[0]!.kind).toBe("header");
  });

  test("plan-scoped cost trails the header; null cost hides the segment (never $0.0000)", () => {
    const rows = taskFooterRows([], { ...GT, totalCostUsd: 0.0123 });
    expect(rows[0]!.text).toBe(" plan 2/5 · ▸ Wire the router · $0.0123");
    expect(taskFooterRows([], GT)[0]!.text).not.toContain("$");
  });

  test("an armed 🔴 block renders the ASCII alert row routing to ^G (no emoji — Q25)", () => {
    const rows = taskFooterRows([], { ...GT, blocked: true });
    expect(rows.length).toBe(2);
    expect(rows[1]!).toMatchObject({ kind: "alert", color: "red", bold: true });
    expect(rows[1]!.text).toBe(" !! gate blocked — ^G");
    expect(rows[1]!.text).not.toContain("🔴");
  });

  test("drift renders the yellow alert only when no block is armed (block wins)", () => {
    expect(taskFooterRows([], { ...GT, drift: 2 })[1]!.text).toBe(" drift: 2 files off-plan");
    expect(taskFooterRows([], { ...GT, drift: 1 })[1]!.text).toBe(" drift: 1 file off-plan");
    const both = taskFooterRows([], { ...GT, drift: 2, blocked: true });
    expect(both.filter((r) => r.kind === "alert").length).toBe(1);
    expect(both[1]!.text).toBe(" !! gate blocked — ^G");
  });

  test("interior newlines in step content collapse — the header is provably ONE row", () => {
    const rows = taskFooterRows([], { ...GT, title: "Wire the router\r\n  and the judge" });
    expect(rows[0]!.text).toBe(" plan 2/5 · ▸ Wire the router and the judge");
    expect(rows[0]!.text).not.toContain("\n");
  });
});

describe("grantTaskRows — alert wins, then header, then next (display order kept)", () => {
  const header = { kind: "header", text: "h", color: "cyan" } as const;
  const alert = { kind: "alert", text: "a", color: "red" } as const;
  const next = { kind: "next", text: "n", color: "gray" } as const;

  test("roomy budget keeps everything in order", () => {
    expect(grantTaskRows([header, alert, next], 3)).toEqual([header, alert, next]);
  });

  test("budget 1 keeps the alert when present, else the header", () => {
    expect(grantTaskRows([header, alert], 1)).toEqual([alert]);
    expect(grantTaskRows([header, next], 1)).toEqual([header]);
  });

  test("budget 2 drops the next row first, preserving display order", () => {
    expect(grantTaskRows([header, alert, next], 2)).toEqual([header, alert]);
  });

  test("zero/negative budget grants nothing", () => {
    expect(grantTaskRows([header, alert], 0)).toEqual([]);
    expect(grantTaskRows([header], -1)).toEqual([]);
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

describe("tui/app.tsx wires the D3a task panel", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

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

  test("/tasks cancel is the CC-style reject: clear + close + TELL THE MODEL", () => {
    const idx = src.indexOf('if (args.trim().toLowerCase() === "cancel")');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2600);
    // Clearing state alone is meaningless — the model's next todowrite re-seeds a fresh
    // active plan; the model-facing rejection notice is the load-bearing part.
    expect(body).toContain("todos.length = 0");
    expect(body).toContain("cancelActivePlans(agent.runId) > 0");
    expect(body).toContain("agent.agentState.messages.push");
    expect(body).toContain("The user cancelled the current");
    expect(body).toContain("do not");
    // The armed gate belongs to the cancelled plan — the modal must disarm.
    expect(body).toContain("setGateFocus(null)");
  });
});

describe("cancelled plans stay dead (the ledger side of /tasks cancel)", () => {
  test("a 'cancelled' plan never reopens; the next todowrite starts a FRESH plan", async () => {
    const { MinimaDb } = await import("../src/db/minima_db.ts");
    const db = new MinimaDb(":memory:");
    const { planId } = db.upsertPlanFromTodos(
      "run1",
      [{ content: "a", status: "in_progress" }],
      "First plan",
    );
    db.setPlanStatus(planId, "cancelled");
    expect(db.getActivePlan("run1")).toBeNull();
    const second = db.upsertPlanFromTodos("run1", [{ content: "b", status: "pending" }], "Second");
    expect(second.planId).not.toBe(planId);
    expect(db.getActivePlan("run1")!.id).toBe(second.planId);
    // Unlike 'done' plans, cancelled ones are not resurrected by matching todos.
    expect(db.getPlanSteps(planId).length).toBe(1);
    db.db.close();
  });

  test("cancelActivePlans sweeps EVERY active plan — adoption piles them up (the field bug)", async () => {
    const { MinimaDb } = await import("../src/db/minima_db.ts");
    const db = new MinimaDb(":memory:");
    // Two active plans on one session, as after adoptActivePlans on a resumed run.
    const a = db.upsertPlanFromTodos("old-run", [{ content: "a", status: "pending" }], "A");
    const b = db.upsertPlanFromTodos("run1", [{ content: "b", status: "pending" }], "B");
    db.adoptActivePlans("old-run", "run1");
    expect(db.cancelActivePlans("run1")).toBe(2);
    expect(db.getActivePlan("run1")).toBeNull();
    for (const id of [a.planId, b.planId]) expect(db.getPlan(id)!.status).toBe("cancelled");
    db.db.close();
  });

  test("display surfaces never resurrect a cancelled plan; the upsert path still sees it", async () => {
    const { MinimaDb } = await import("../src/db/minima_db.ts");
    const { buildGtOverview } = await import("../src/tui/gt_overview.ts");
    const { whyReportFor } = await import("../src/minima/why.ts");
    const db = new MinimaDb(":memory:");
    db.upsertPlanFromTodos("run1", [{ content: "a", status: "in_progress" }], "Rejected plan");
    db.cancelActivePlans("run1");
    // Ctrl+G and /why: the "GT still holds" report — both must come back empty.
    expect(buildGtOverview(db, "run1")).toBeNull();
    expect(whyReportFor(db, "run1")).toContain("No Ground-Truth plan recorded");
    // The todo-upsert path keeps the DEFAULT view so it starts fresh, never resurrects.
    expect(db.getLatestPlan("run1")!.status).toBe("cancelled");
    expect(db.getLatestPlan("run1", { excludeCancelled: true })).toBeNull();
    db.db.close();
  });
});
