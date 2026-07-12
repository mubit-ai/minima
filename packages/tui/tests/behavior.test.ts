import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  flaggedFooter,
  gateConfidence,
  ledgerBehavior,
  redPrompt,
  tierBehavior,
} from "../src/minima/behavior.ts";
import type { Factors } from "../src/minima/gt_contract.ts";

// Factors that land on each confidence tier (see confidence.ts):
//   GREEN  → trusted check passed
//   YELLOW → self-written test (agent_new origin)
//   RED    → check did not pass (pass: false)
const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};
const YELLOW: Factors = { ...GREEN, checkOrigin: "agent_new" };
const RED: Factors = { ...GREEN, pass: false };

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

/** Seed an active plan with one step per tier and a Track-A-style gate on each. */
function seedPlan(d: MinimaDb, session: string, tiers: Array<Factors | null>) {
  const { planId, stepIds } = d.upsertPlanFromTodos(
    session,
    tiers.map((_, i) => ({ content: `step ${i}`, status: "completed", verify: "bun test" })),
    "Plan",
  );
  tiers.forEach((factors, i) => {
    if (!factors) return;
    d.insertGate({
      planId,
      stepId: stepIds[i],
      outcome: factors.pass && !factors.tamper ? "verified" : "failed",
      confidence: gateConfidence(factors),
      verifiedBy: "deterministic",
      factors,
    });
  });
  return { planId, stepIds };
}

describe("tierBehavior", () => {
  test("🟢 proceeds silently — not flagged, not blocked", () => {
    expect(tierBehavior("green", "trusted check passed")).toEqual({
      tier: "green",
      action: "proceed",
      proceed: true,
      flagged: false,
      reason: "trusted check passed",
    });
  });

  test("🟡 proceeds but is flagged for the milestone review", () => {
    expect(tierBehavior("yellow", "self-written test")).toEqual({
      tier: "yellow",
      action: "proceed",
      proceed: true,
      flagged: true,
      reason: "self-written test",
    });
  });

  test("🔴 stops the run and prompts", () => {
    expect(tierBehavior("red", "check did not pass")).toEqual({
      tier: "red",
      action: "prompt",
      proceed: false,
      flagged: false,
      reason: "check did not pass",
    });
  });

  test("a null tier (unchecked step) proceeds quietly — never blocks", () => {
    expect(tierBehavior(null, "not verified")).toEqual({
      tier: null,
      action: "proceed",
      proceed: true,
      flagged: false,
      reason: "not verified",
    });
  });
});

describe("flaggedFooter", () => {
  test("collapses to null when nothing is flagged", () => {
    expect(flaggedFooter(0)).toBeNull();
    expect(flaggedFooter(-1)).toBeNull();
  });

  test("is singular for one step", () => {
    expect(flaggedFooter(1)).toBe("🟡 1 step flagged — review at milestone");
  });

  test("is plural for many steps", () => {
    expect(flaggedFooter(3)).toBe("🟡 3 steps flagged — review at milestone");
  });
});

describe("redPrompt", () => {
  test("renders the [v]iew/[a]ccept/[r]eject/[s]teer approval line", () => {
    expect(redPrompt("check did not pass")).toBe(
      "🔴 check did not pass — [v]iew / [a]ccept / [r]eject / [s]teer",
    );
  });
});

describe("gateConfidence", () => {
  test("maps factors onto the confidence ladder's tier", () => {
    expect(gateConfidence(GREEN)).toBe("green");
    expect(gateConfidence(YELLOW)).toBe("yellow");
    expect(gateConfidence(RED)).toBe("red");
  });
});

describe("ledgerBehavior", () => {
  test("fails open to empty behavior for a null db or session", () => {
    const empty = { flaggedCount: 0, footerNote: null, block: null };
    expect(ledgerBehavior(null, "run1")).toEqual(empty);
    expect(ledgerBehavior(db(), null)).toEqual(empty);
  });

  test("is empty when there is no active plan", () => {
    expect(ledgerBehavior(db(), "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });

  test("counts 🟡 steps and renders the milestone-review note; green-only never blocks", () => {
    const d = db();
    seedPlan(d, "run1", [GREEN, YELLOW, YELLOW, GREEN]);
    const b = ledgerBehavior(d, "run1");
    expect(b.flaggedCount).toBe(2);
    expect(b.footerNote).toBe("🟡 2 steps flagged — review at milestone");
    expect(b.block).toBeNull();
  });

  test("all-green produces no note and no block", () => {
    const d = db();
    seedPlan(d, "run1", [GREEN, GREEN]);
    expect(ledgerBehavior(d, "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });

  test("blocks on the earliest 🔴 step in plan order, ignoring later reds", () => {
    const d = db();
    const { stepIds } = seedPlan(d, "run1", [GREEN, RED, RED]);
    const b = ledgerBehavior(d, "run1");
    expect(b.block).not.toBeNull();
    expect(b.block?.stepId).toBe(stepIds[1]);
    expect(b.block?.reason).toBe("check did not pass");
    expect(b.block?.prompt).toBe("🔴 check did not pass — [v]iew / [a]ccept / [r]eject / [s]teer");
  });

  test("a 🟡 before a 🔴 is both flagged and blocked", () => {
    const d = db();
    const { stepIds } = seedPlan(d, "run1", [YELLOW, RED]);
    const b = ledgerBehavior(d, "run1");
    expect(b.flaggedCount).toBe(1);
    expect(b.footerNote).toBe("🟡 1 step flagged — review at milestone");
    expect(b.block?.stepId).toBe(stepIds[1]);
  });

  // M6.3: a gate the user has answered (accept/reject/steer) is resolved and stops re-raising.
  test("an answered 🔴 no longer blocks — the next unanswered red surfaces", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [RED, RED]);
    const firstRed = d.getGates(planId).find((g) => g.step_id === stepIds[0]);
    d.recordUserSignal(firstRed!.id, "accept");
    // The first red is resolved, so the block moves to the still-unanswered second red.
    expect(ledgerBehavior(d, "run1").block?.stepId).toBe(stepIds[1]);
  });

  test("answering the only 🔴 clears the block entirely", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [GREEN, RED]);
    const red = d.getGates(planId).find((g) => g.step_id === stepIds[1]);
    d.recordUserSignal(red!.id, "reject");
    expect(ledgerBehavior(d, "run1").block).toBeNull();
  });

  test("one answer records exactly one user_signal against the focused gate", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [RED]);
    const red = d.getGates(planId).find((g) => g.step_id === stepIds[0]);
    d.recordUserSignal(red!.id, "accept");
    expect(d.getUserSignals(red!.id)).toHaveLength(1);
    expect(d.getUserSignals(red!.id)[0]!.action).toBe("accept");
  });

  // The modal's steer path (`answerGate(gateId, "steer", note)`) lands the note in
  // user_signals.note; the skipped-note path records the same steer with a null note.
  test("a steer answer carries its note into user_signals.note and resolves the block", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [RED]);
    const red = d.getGates(planId).find((g) => g.step_id === stepIds[0]);
    d.recordUserSignal(red!.id, "steer", "try the fixture path first");
    const signals = d.getUserSignals(red!.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.action).toBe("steer");
    expect(signals[0]!.note).toBe("try the fixture path first");
    expect(ledgerBehavior(d, "run1").block).toBeNull();
  });

  test("a steer with a skipped note records a null note (still exactly one signal)", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [RED]);
    const red = d.getGates(planId).find((g) => g.step_id === stepIds[0]);
    d.recordUserSignal(red!.id, "steer", null);
    const signals = d.getUserSignals(red!.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.note).toBeNull();
    expect(ledgerBehavior(d, "run1").block).toBeNull();
  });

  test("the newest gate per step supersedes an earlier one (a retry clears a red)", () => {
    const d = db();
    const { planId, stepIds } = seedPlan(d, "run1", [null]);
    // First attempt fails red, then a retry passes green on the same step.
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
    });
    d.insertGate({
      planId,
      stepId: stepIds[0],
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
    });
    expect(ledgerBehavior(d, "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });

  test("a gate with no step_id is ignored (never counted, never blocks)", () => {
    const d = db();
    const { planId } = seedPlan(d, "run1", [GREEN]);
    d.insertGate({ planId, stepId: null, outcome: "failed", confidence: "red", factors: RED });
    expect(ledgerBehavior(d, "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });

  test("only reads the active plan, not an older archived one", () => {
    const d = db();
    // An older plan gets archived; its red gate must not leak into the active plan's behavior.
    const old = seedPlan(d, "run1", [RED]);
    d.setPlanStatus(old.planId, "archived");
    seedPlan(d, "run1", [GREEN]);
    expect(ledgerBehavior(d, "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });

  test("fails open to empty behavior when a DB read throws", () => {
    const thrower = {
      getActivePlan() {
        throw new Error("boom");
      },
    } as unknown as MinimaDb;
    expect(ledgerBehavior(thrower, "run1")).toEqual({
      flaggedCount: 0,
      footerNote: null,
      block: null,
    });
  });
});

// Guards the M6.2 tier→behavior wiring in tui/app.tsx that a pure test can't reach: the aggregate
// is refreshed alongside the plan strip, the 🟡 note and 🔴 block each cost one truncated footer
// row, and /gt-seed exercises all three tiers so the three snapshots (quiet / note / prompt) exist.
describe("tui/app.tsx wires tier→behavior", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("refreshes gtBehavior from the same helper on mount and tool_execution_end", () => {
    const refreshes = src.split("setGtBehavior(ledgerBehavior(agent.db, agent.runId))").length - 1;
    expect(refreshes).toBeGreaterThanOrEqual(2);
    // Refresh is gated on Ground-Truth being on, like the plan strip.
    expect(src).toContain("agent.config.groundTruth === true");
  });

  test("the 🟡 note and 🔴 block are rendered from the aggregate, not inline templates", () => {
    expect(src).toContain("gtBehavior?.footerNote");
    expect(src).toContain("gtBehavior?.block");
    expect(src).toContain("{gtFooterNote}");
    expect(src).toContain("{gtBlock.prompt}");
  });

  test("the note is yellow and the block prompt is red — one truncated row each", () => {
    expect(src).toContain('<Text color="yellow" wrap="truncate-end">');
    expect(src).toContain('<Text color="red" bold wrap="truncate-end">');
    // Both rows are budgeted into footerHeight (via the gtFooterFit grant) so the chat window
    // shrinks instead of clipping.
    expect(src).toContain("const gtRows = (gtFit.note ? 1 : 0) + (gtFit.block ? 1 : 0)");
    expect(src).toContain("+ gtRows");
  });

  test("fails open to a hidden footer (setGtBehavior(null)) — never a crash", () => {
    expect(src).toContain("setGtBehavior(null)");
  });

  test("/gt-seed seeds all three tiers so every behavior path has a demo", () => {
    expect(src).toContain("Seed trusted verification");
    expect(src).toContain("Seed flagged verification");
    expect(src).toContain("Seed blocked verification");
    // The stored confidence is the ladder's own verdict, not a hardcoded string.
    expect(src).toContain("confidence: gateConfidence(green)");
    expect(src).toContain("confidence: gateConfidence(red)");
  });

  // M6.3: the 🔴 block captures the override through the gate-focus modal. While armed, the
  // TextInput renders disabled, so a/r/s/v/Esc reach only the gate handler — the empty-prompt
  // heuristic (and its double-type hole: Ink dispatches every key to ALL useInput hooks) is gone.
  test("M6.3: the gate-focus modal captures a/r/s into user_signals — no empty-prompt guard", () => {
    expect(src).toContain('answerGate(gateFocus.gateId, input === "a" ? "accept" : "reject", null)');
    expect(src).toContain("agent.db?.recordUserSignal(gateId, action, note)");
    expect(src).not.toContain('typedText.trim() === ""');
  });

  test("gateFocus can only arm when gtBehavior.block exists (default path inert)", () => {
    const armIdx = src.indexOf("const gtBlockId = gtBehavior?.block?.gateId ?? null");
    expect(armIdx).toBeGreaterThan(-1);
    const effect = src.slice(armIdx, armIdx + 500);
    // A null block always DISARMS; arming requires the non-null gateId (and an idle prompt).
    expect(effect).toContain("if (gtBlockId === null) {");
    expect(effect).toContain("setGateFocus(null)");
    expect(effect).toContain("if (busy || gtBlockId === dismissedGateRef.current) return;");
    // The ctrl+g re-arm is likewise gated on a live block.
    expect(src).toContain('if (key.ctrl && input === "g" && gtBehavior?.block) {');
  });

  test("while armed the prompt input is disabled and shows the answer-key hint", () => {
    expect(src).toContain("disabled={busy || (gateFocus !== null && !gateFocus.noteEntry)}");
    expect(src).toContain("[a]ccept · [r]eject · [s]teer · [v]iew · esc to type");
  });

  test("Esc while armed dismisses without recording; steer switches to note entry", () => {
    const gateIdx = src.indexOf("if (gateFocus && gtDb && !key.ctrl && !key.meta) {");
    expect(gateIdx).toBeGreaterThan(-1);
    const branch = src.slice(gateIdx, src.indexOf("if (key.ctrl && input ===", gateIdx));
    // Esc: remember the dismissal and clear focus — no signal write in that path.
    const escIdx = branch.indexOf("if (key.escape) {");
    expect(escIdx).toBeGreaterThan(-1);
    const escBranch = branch.slice(escIdx, branch.indexOf("}", escIdx + 20));
    expect(escBranch).toContain("dismissedGateRef.current = gateFocus.gateId");
    expect(escBranch).not.toContain("answerGate");
    expect(escBranch).not.toContain("recordUserSignal");
    // Steer: flip to the note-entry sub-state; the note lands via answerGate(…, "steer", …).
    expect(branch).toContain("setGateFocus({ gateId: gateFocus.gateId, noteEntry: true })");
    expect(src).toContain('answerGate(gateFocus.gateId, "steer", text.trim() || null)');
    expect(src).toContain('answerGate(gateFocus.gateId, "steer", null)');
  });

  test("the modal's key seams hold: TextInput ignores keys while disabled and ctrl/meta combos", () => {
    const input = readFileSync(join(import.meta.dir, "../src/tui/text-input.tsx"), "utf8");
    expect(input).toContain("if (disabled) return;");
    expect(input).toContain("if (key.ctrl || key.meta) return;");
    // Default path unchanged: no disabledLabel still renders the busy placeholder, truncated.
    expect(input).toContain('disabledLabel ?? "(busy…)"');
    expect(input).toContain('<Text wrap="truncate">');
  });

  // M7.1: /gt-seed gives the run a routing decision then stamps the grounded outcome onto it, so
  // the DB query in the issue's "see it work" shows gt_* attached to the model.
  test("M7.1: /gt-seed writes a routing decision and stamps the grounded outcome", () => {
    expect(src).toContain("agent.db.writeDecision({");
    expect(src).toContain("stampGroundedOutcome(agent.db, seedRecId)");
    // Identity join: seeded gate rows must carry the rec they stamp (v6 gates.rec_id).
    expect(src).toContain("recId: seedRecId");
  });
});
