import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the D3a task-panel wiring in tui/app.tsx — the ONE plan surface (MP6, MUB-149).
// The old GT footer banner (planStrip row + 🟡 note + 🔴 block rows) folded INTO the task
// panel; these assertions lock in what a pure test can't reach:
//  - the banner render sites are GONE (no second plan surface can reappear),
//  - reservation (footerHeight) and render consume the SAME granted rows,
//  - the budget still subtracts the wipe-guard constants,
//  - the ledger refresh cadence and fail-open behavior survived the fold.
describe("tui/app.tsx wires the D3a plan surface (the GT banner is gone)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the old banner render sites are gone — one plan surface", () => {
    expect(src).not.toContain("planStripLabel(planStrip)");
    expect(src).not.toContain("planStripDrift(planStrip.drift)");
    expect(src).not.toContain("{gtFooterNote}");
    expect(src).not.toContain("{gtBlock.prompt}");
    expect(src).not.toContain("gtFooterFit");
    expect(src).not.toContain("`▸ plan ${planStrip.stepPos}");
  });

  test("reservation and render consume the SAME granted rows (lockstep)", () => {
    expect(src).toContain(
      "const taskShown = taskVisible ? grantTaskRows(taskRows, taskBudget) : []",
    );
    expect(src).toContain("+ taskShown.length");
    expect(src).toContain("{taskShown.length > 0 && (");
    expect(src).toContain("{taskShown.map((r, i) => (");
  });

  test("the GT enrichment threads the ledger projection + the armed-block flag", () => {
    expect(src).toContain("blocked: (gtBehavior?.block ?? null) !== null");
    expect(src).toContain("taskFooterRows(todos ?? [], gt)");
  });

  test("the too-small guard is unchanged (default-path pin)", () => {
    expect(src).toContain("if (rows < 10 || cols < 40) {");
  });

  test("taskBudget subtracts the scrollback safety margin and the input-box floor", () => {
    const idx = src.indexOf("const taskBudget =");
    expect(idx).toBeGreaterThan(-1);
    const expr = src.slice(idx, idx + 200);
    // The two constants that keep inline mode from tripping Ink's scrollback-wiping
    // clearTerminal: the safety margin and the (plan-mode-aware) input-box floor.
    expect(expr).toContain("SCROLLBACK_SAFETY_ROWS");
    expect(expr).toContain("planMode ? 7 : 4");
  });

  test("refresh + seed are gated on groundTruth === true", () => {
    expect(src).toContain("agent.config.groundTruth === true");
    // Both the mount seed and the tool_execution_end refresh read the same helper.
    const refreshes = src.split("setPlanStrip(planStripInfo(agent.db, agent.runId))").length - 1;
    expect(refreshes).toBeGreaterThanOrEqual(2);
  });

  test("the refresh is driven by tool_execution_end", () => {
    const endIdx = src.indexOf('case "tool_execution_end":');
    expect(endIdx).toBeGreaterThan(-1);
    // The GT refresh lives inside the tool_execution_end case, before the next case/break
    // (the case body also carries the D3a todoGen bump since MP5, hence the window size).
    const after = src.slice(endIdx, endIdx + 1200);
    expect(after).toContain("setPlanStrip(planStripInfo(agent.db, agent.runId))");
  });

  test("a ledger read failure fails open to a hidden surface (never a crash)", () => {
    expect(src).toContain("setPlanStrip(null)");
    expect(src).toContain("} catch {");
  });
});
