import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the Ground-Truth plan-of-record footer strip wiring in tui/app.tsx (M1.3/M2.3).
// The exact rendered text is unit-tested via planStripLabel/planStripDrift in ground_truth.test.ts;
// these assertions lock in the wiring around it that a pure test can't reach:
//  - the strip renders through the extracted formatters (not an inline template),
//  - it is gated on agent.config.groundTruth === true (inert otherwise),
//  - it costs exactly one footer row so the chat window shrinks instead of clipping,
//  - it is seeded on mount and refreshed on tool_execution_end, and
//  - a ledger read failure fails open to a hidden strip (setPlanStrip(null)) — never a crash.
describe("tui/app.tsx wires the GT footer strip", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("renders the strip through the extracted formatters, not an inline template", () => {
    expect(src).toContain("planStripLabel(planStrip)");
    expect(src).toContain("planStripDrift(planStrip.drift)");
    // The old inline template must be gone so the formatters stay the single source of truth.
    expect(src).not.toContain("`▸ plan ${planStrip.stepPos}");
  });

  test("the drift segment renders only when drift > 0 and in yellow", () => {
    expect(src).toContain("planStrip.drift > 0 ?");
    expect(src).toContain('<Text color="yellow">{planStripDrift(planStrip.drift)}</Text>');
  });

  test("the strip is one truncated line, granted by gtFooterFit in lockstep with footerHeight", () => {
    expect(src).toContain('wrap="truncate-end"');
    // Reservation and render both derive from the SAME fit result so they can never drift:
    // footerHeight counts the strip via gtFit.strip, and the render is gated on the same flag.
    expect(src).toContain("(gtFit.strip ? 1 : 0)");
    expect(src).toContain("{planStrip && gtFit.strip && (");
  });

  test("all three GT rows render only when gtFooterFit grants them (reservation/render lockstep)", () => {
    expect(src).toContain("const gtFit = gtFooterFit(gtBudget, {");
    expect(src).toContain("{gtFooterNote && gtFit.note && (");
    expect(src).toContain("{gtBlock && gtFit.block && (");
    expect(src).toContain("const gtRows = (gtFit.note ? 1 : 0) + (gtFit.block ? 1 : 0)");
  });

  test("the too-small guard is unchanged (default-path pin)", () => {
    expect(src).toContain("if (rows < 10 || cols < 40) {");
  });

  test("gtBudget subtracts the scrollback safety margin and the input-box floor", () => {
    const idx = src.indexOf("const gtBudget =");
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
    // The GT refresh lives inside the tool_execution_end case, before the next case/break.
    const after = src.slice(endIdx, endIdx + 600);
    expect(after).toContain("setPlanStrip(planStripInfo(agent.db, agent.runId))");
  });

  test("a ledger read failure fails open to a hidden strip (never a crash)", () => {
    expect(src).toContain("setPlanStrip(null)");
    expect(src).toContain("} catch {");
  });
});
