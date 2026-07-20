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

  test("tier→behavior surfaces through the D3a alert fold, not banner rows (MP6)", () => {
    // The armed 🔴 block reaches the panel as a boolean; the alert TEXT is built in
    // task_footer.ts (colored ASCII, no emoji — Q25). The old banner templates are gone.
    expect(src).toContain("blocked: (gtBehavior?.block ?? null) !== null");
    expect(src).not.toContain("{gtFooterNote}");
    expect(src).not.toContain("{gtBlock.prompt}");
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
    expect(src).toContain(
      'answerGate(gateFocus.gateId, input === "a" ? "accept" : "reject", null)',
    );
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
    expect(input).toContain("if (disabled || suspended) return;");
    // Ctrl combos are either readline edits handled locally or fall through to the app
    // handlers — either way the branch returns before the draft-insert path, and meta
    // combos never insert (the meta branch handles Alt+B/F word-jumps, then returns).
    expect(input).toContain("if (key.ctrl) {");
    expect(input).toContain("if (key.meta) {");
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

// exit_plan (plan-mode exit): the tool is registered only while a GT plan session is live,
// the persona steers the model to it (never to slash commands), and the promptPlanner wrapper
// re-applies the build prompt after a mid-turn exit (promptRouted's finally would otherwise
// restore the planner persona it captured at entry — permanently).
describe("tui/app.tsx wires exit_plan", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("persona tells the planner to call exit_plan, not to name slash commands", () => {
    const personaIdx = src.indexOf("const PLANNER_PERSONA");
    expect(personaIdx).toBeGreaterThan(-1);
    // The declaration ends at the closing `";` — a bare ";" appears inside the prose.
    const persona = src.slice(personaIdx, src.indexOf('";', personaIdx));
    expect(persona).toContain("call the exit_plan tool");
    expect(persona).toContain("Never tell the user to run slash commands");
    expect(persona).not.toContain("/plan finalize");
  });

  test("registered whenever plan mode is ON (MP17 universal gate); cleanup by identity", () => {
    const effectIdx = src.indexOf('if (mode !== "plan") return;');
    expect(effectIdx).toBeGreaterThan(-1);
    const effect = src.slice(effectIdx, effectIdx + 900);
    expect(effect).toContain("exitPlanTool({");
    expect(effect).toContain("agent.agentState.tools.push(tool)");
    expect(effect).toContain("agent.agentState.tools.splice(i, 1)");
    expect(effect).toContain('isActive: () => getMode() === "plan"');
    expect(effect).toContain("requiresPlan: () => planSessionRef.current == null");
  });

  test("/plan finalize and the tool share ONE core (runPlanFinalize → finalizePlan)", () => {
    expect(src.split("await runPlanFinalize(").length - 1).toBe(2); // exit_plan + /plan finalize
    // MP18: the shared core awaits finalizePlan so the ok-branch can feed seededVerifies
    // into the consent store before returning.
    expect(src).toContain("const outcome = await finalizePlan(store, {");
    expect(src).toContain("permStateRef.current.approvedVerifies.add(v)");
    // The command path no longer inlines the synthesis/audit/write sequence.
    expect(src).not.toContain("synthesizeGroundTruth(store.session");
    expect(src).not.toContain("await Bun.write(outPath, md)");
  });

  test("promptPlanner re-applies the build prompt after a mid-turn plan exit", () => {
    const idx = src.indexOf("const base = plannerBaseSystemPromptRef.current;");
    expect(idx).toBeGreaterThan(-1);
    const wrapper = src.slice(idx, idx + 400);
    expect(wrapper).toContain("await agent.promptRouted(turn)");
    expect(wrapper).toContain('if (getMode() !== "plan" && base != null)');
    expect(wrapper).toContain("agent.agentState.systemPrompt = base");
  });
});

// Panel input routing: ONE derived `panelCapture` feeds both the global-handler guard list
// and the composer's `suspended`, so the two can never drift — the U3/B5 regression class
// (a panel captured the global handler but left the composer live: arrows scrubbed history,
// letters grew the draft, Enter could submit a prompt). MP2 (MUB-145) removed the docked
// sidebars; since MP4 (MUB-147) the expanded live-region panel is the only populator.
describe("tui/app.tsx panel key routing", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("panelCapture derives from the expanded-panel state — the only capturing panel", () => {
    expect(src).toContain("const panelCapture = panel !== null;");
    expect(src).not.toContain("sidebarOpen");
    expect(src).not.toContain("sidebarFocused");
    expect(src).not.toContain("rewindOpen");
  });

  test("the global guard list uses panelCapture — the per-panel lines are gone", () => {
    expect(src).toContain("panelCapture // ");
    expect(src).not.toContain("tocOpen || // U2");
    expect(src).not.toContain("gtPanelOpen || // U3");
  });

  test("the composer suspends on the SAME expression (the leak fix)", () => {
    expect(src).toContain("suspended={panelCapture}");
    expect(src).not.toContain("suspended={tocOpen}");
  });

  test("an unanswered 🔴 gate wins Ctrl+G — outside AND inside the panel (MP9)", () => {
    // Global arm: the guard keeps falling through to the gate-answer arm.
    expect(src).toContain('input === "g" && !(gtBehavior?.block && !busy)');
    // In-panel arm: closing hands the keyboard to the SAME gate-focus machinery — but
    // only idle, since the modal is idle-only (a busy chord swaps views, never arms dead).
    const idx = src.indexOf("function handlePanelKey");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2600);
    expect(body).toContain("if (gtBehavior?.block && !busy) {");
    expect(body).toContain("setGateFocus({ gateId: gtBehavior.block.gateId, noteEntry: false })");
  });

  test("/why opens the GT panel in the TUI; the text path survives for GT-off/narrow", () => {
    const idx = src.indexOf('case "why": {');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2400);
    expect(body).toContain("gtPanelState(overview, gtRows(overview,");
    expect(body).toContain("whyReportFor(agent.db, agent.runId)");
  });
});

// Shift+Tab plan mode (2026-07-15): entering plan mode via ANY door must mean the REAL GT
// planning workflow — session + planner persona + exit_plan — never the badge-only half-state
// (mode flipped, session null → prompts ran the NORMAL loop and the model executed with
// per-call approval instead of planning; bare /plan then EXITED instead of recovering).
describe("tui/app.tsx Shift+Tab enters the real planning workflow", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("Shift+Tab cycles the ring EXCEPT out of plan mode, which routes the gate (MP17)", () => {
    // Entering plan still rides the ring (auto-heal plants the GT session); LEAVING plan
    // goes through the 3-option exit gate so approval and the ring share one surface. The
    // sessionless-no-plan-turn fast-path keeps quick flipping (and the modes scenario)
    // cycle-identical. Since the global-arm move the chord lives in app.tsx's useInput
    // ABOVE the overlay/busy guards (Claude Code parity: works mid-run and over the
    // permission overlay) — the composer no longer knows about Shift+Tab at all.
    const handlerIdx = src.indexOf("if (key.tab && key.shift) {");
    expect(handlerIdx).toBeGreaterThan(-1);
    const handler = src.slice(handlerIdx, handlerIdx + 1600);
    expect(handler).toContain('if (getMode() === "plan") {');
    expect(handler).toContain("void requestPlanExitGate();");
    expect(handler).toContain("const next = cycleMode();");
    // The arm sits BEFORE the modal early-return and the busy guard — mid-run parity.
    expect(handlerIdx).toBeLessThan(src.indexOf("panelCapture // the expanded panel owns"));
    expect(handlerIdx).toBeLessThan(src.indexOf("if (busy && (key.escape ||"));
    expect(src).toContain("store == null && !planTurnSeenRef.current");
    expect(src).not.toContain("toggleMode");
    expect(src).not.toContain("onShiftTab");
    const composer = readFileSync(join(import.meta.dir, "../src/tui/text-input.tsx"), "utf8");
    expect(composer).not.toContain("onShiftTab");
  });

  test("a pending permission prompt re-resolves under the newly cycled mode", () => {
    // Claude Code parity: Shift+Tab with the overlay up auto-approves the waiting call
    // when the new mode's bundle says auto — one-time allow, audited as mode-auto, and
    // never a recorded "always" grant.
    const idx = src.indexOf("modeAutoApproves(next, permPrompt.toolName");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 500);
    expect(body).toContain('kind: "mode-auto"');
    expect(body).toContain("setPermPrompt(null);");
    expect(body).toContain('permPrompt.resolve("allow");');
  });

  test("one shared ON notice: definition + auto-heal + /plan", () => {
    expect(src.split("PLAN_ON_NOTICE").length - 1).toBe(3);
  });

  test("planSessionGen keys exit_plan registration to session identity", () => {
    expect(src).toContain("const [planSessionGen, setPlanSessionGen] = useState(0);");
    expect(src.split("setPlanSessionGen((g) => g + 1);").length - 1).toBe(2); // enter + exit
    expect(src).toContain(
      "}, [mode, agent, askUserRef, exitPlanFinalize, exitPlanCancel, planSessionGen]);",
    );
  });

  test("auto-heal effect: plan mode without a session converges to a real one (no loop)", () => {
    const idx = src.indexOf("planSessionRef.current != null ||");
    expect(idx).toBeGreaterThan(-1);
    const effect = src.slice(idx - 400, idx + 400);
    expect(effect).toContain('mode !== "plan" ||');
    expect(effect).toContain("agent.config.groundTruth !== true ||");
    expect(effect).toContain("!planSpawn ||");
    expect(effect).toContain("!planMetaModel");
    // The no-loop invariant: the heal's deps exclude planSessionGen and messages.
    expect(effect).toContain("}, [mode, agent, planSpawn, planMetaModel, enterPlanMode]);");
  });

  test("bare /plan in plan-mode-without-a-session RECOVERS instead of exiting", () => {
    expect(src).toContain('sub === "off" ? false : planSessionRef.current == null');
    // The mode-store test survives only in the GT-off branch and promptPlanner's leak guard.
    expect(src.split('getMode() !== "plan"').length - 1).toBe(2);
  });

  test("the onSubmit fallthrough is surfaced, never silent", () => {
    expect(src).toContain("plan mode without a live council");
    const idx = src.indexOf('? "no plan session"');
    expect(idx).toBeGreaterThan(-1);
    const ternary = src.slice(idx, idx + 200);
    expect(ternary).toContain('"no council spawn"');
    expect(ternary).toContain('"no council model"');
  });
});

// Finalize handoff (2026-07-15): the ledger drives the whole GT build spine — when synthesis
// fails (truncated output was silently costing every seeded step), the user sees it and the
// agent is told to rebuild the ledger via todowrite as its first move.
describe("tui/app.tsx surfaces the finalize→ledger handoff", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the user-facing note warns when synthesis failed and nothing was seeded", () => {
    expect(src).toContain("synthFailed: boolean");
    expect(src).toContain("NO steps were seeded to the plan ledger");
  });

  test("the model is steered by seeding outcome: follow seeded steps, or todowrite first", () => {
    expect(src).toContain("Follow the seeded plan steps");
    expect(src).toContain("The plan ledger has no seeded steps — FIRST record");
    expect(src).toContain("shell `verify` check");
  });
});

// Optimistic prompt echo (2026-07-15): onSubmit pushes the VERBATIM prompt before recall/route
// (and before any council round), and the loop's message_start(user) — which carries the
// @file-expanded/replan-prefixed run content — is deduped via pendingEchoRef.
describe("tui/app.tsx echoes the prompt optimistically", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("verbatim echo lands in onSubmit between the slash dispatch and setBusy", () => {
    const echo = 'setMessages((m) => [...m, { role: "user", text: trimmed }]);';
    const idx = src.indexOf(echo);
    expect(idx).toBeGreaterThan(src.indexOf("await handleCommand(name, args);"));
    const after = src.slice(idx, idx + 300);
    expect(after).toContain("pendingEchoRef.current = true;");
    expect(after).toContain("setBusy(true);");
    expect(after.indexOf("pendingEchoRef.current = true;")).toBeLessThan(
      after.indexOf("setBusy(true);"),
    );
  });

  test("the loop's message_start(user) is deduped, not double-posted", () => {
    const idx = src.indexOf('case "message_start":');
    expect(idx).toBeGreaterThan(-1);
    const handler = src.slice(idx, idx + 500);
    expect(handler).toContain("if (pendingEchoRef.current) {");
    expect(handler).toContain("pendingEchoRef.current = false;");
    // The event echo survives for non-optimistic user messages (finalize handoff, replays).
    expect(handler).toContain('{ role: "user", text: ev.message!.textContent }');
  });

  test("single-slot ref discipline: exactly one set; cleared in dedup + finally", () => {
    expect(src).toContain("const pendingEchoRef = useRef(false);");
    expect(src.split("pendingEchoRef.current = true;").length - 1).toBe(1);
    expect(src.split("pendingEchoRef.current = false;").length - 1).toBe(2);
  });

  test("the finally clear keeps a failed turn from muting a later echo", () => {
    expect(src).toContain("} finally {\n      pendingEchoRef.current = false;");
  });
});

// MP2 (MUB-145): the docked/overlay sidebar system is deleted. These pins keep it deleted
// and protect the survivors (rewind overlay geometry, one-shot text blocks).
describe("tui/app.tsx sidebar removal", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("no sidebar system: geometry, panels and auto-open are gone", () => {
    expect(src).not.toContain("sidebarGeometry");
    expect(src).not.toContain("sidebarPanels");
    expect(src).not.toContain("SidebarChassis");
    expect(src).not.toContain("contentCols");
    expect(src).not.toContain("cols < 100");
  });

  test("Ctrl+T / Ctrl+G always print the one-shot text blocks", () => {
    expect(src).toContain("renderTocText(buildSections(messages, buildUsageLedger()), cols - 6)");
    expect(src).toContain("renderGtOverviewText(overview, cols - 6)");
  });

  test("/rewind is the numbered text list everywhere (the overlay died with fullscreen)", () => {
    expect(src).toContain("renderRewindText(turns, cols - 6)");
    expect(src).not.toContain("RewindPanel");
    expect(src).not.toContain("overlayGeom");
  });
});
