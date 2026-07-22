/**
 * Stop-gate (A2) — the run-level complement to the per-step done-gate.
 *
 * The per-step done-gate (`bigPlanHooks.before`) refuses a `todowrite` that marks ONE step
 * `completed` while its `verify` fails. It cannot, however, stop the agent from simply ENDING the
 * run — going quiet with no more tool calls — while the plan still has unfinished or failing steps.
 * This module fills that gap by hanging off the loop's one terminal seam, `shouldStopAfterTurn`
 * (agent/loop.ts:155), which fires after every settled turn.
 *
 * The rule (all reads off the ledger — no checks are re-run here):
 *   - A turn that still requests tools is NOT a stop attempt → let the loop continue.
 *   - The plan is "not done" when any step is not `completed`, OR a completed step's latest gate
 *     row has `outcome === "failed"`. (`unrunnable` is an environment error, never a block — the
 *     same conservative stance the recovery ladder takes.)
 *   - While strikes remain, a stop attempt on a not-done plan is DENIED: a firm continuation
 *     message is pushed into `state.followUp` (so the loop re-drives the model instead of breaking)
 *     and a strike is spent.
 *   - Once `maxStrikes` denials are spent, the harness stops fighting the agent and ASKS: in an
 *     interactive run it raises the question overlay (keep going / accept as done / freetext steer);
 *     headless (no ask channel) it just lets the run end. Either way a single audit-only `stop`
 *     gate row is written.
 *
 * Enforcement lives here (harness code at a turn boundary), not in prompt text — per the
 * "enforcement in the dispatcher, guidance in the prompt" principle. Everything is gated by
 * `config.bigPlan` + `config.stopStrikes > 0` at the call site (runtime.ts); this module is
 * inert unless wired in. Fail-open throughout: any ledger error assesses as "not blocked" so a
 * broken read can never wedge the loop.
 */

import type { AgentState, ShouldStopAfterTurn, ToolResultLike } from "../agent/state.ts";
import type { AssistantMessage } from "../ai/index.ts";
import { Message, text } from "../ai/types.ts";
import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import type { AskUserRef } from "../tools/question.ts";

/** How many step reasons to spell out in a message before collapsing to "+N more". */
const MAX_REASONS_SHOWN = 5;
/** Trim a step's content for a one-line reason. */
const REASON_CONTENT_MAX = 80;

/** The ledger's verdict on whether the run may end. Pure read; never throws. */
export interface StopAssessment {
  /** True when at least one step is incomplete or has a failing check → the run should not end. */
  blocked: boolean;
  /** One human-readable line per offending step (already truncated). */
  reasons: string[];
  /** Steps not yet `completed`. */
  incomplete: number;
  /** Completed steps whose latest gate `outcome === "failed"`. */
  redSteps: number;
}

const EMPTY_ASSESSMENT: StopAssessment = {
  blocked: false,
  reasons: [],
  incomplete: 0,
  redSteps: 0,
};

function trunc(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  return t.length > REASON_CONTENT_MAX ? `${t.slice(0, REASON_CONTENT_MAX - 1)}…` : t;
}

/**
 * Read the active plan and decide whether the run may end. A step blocks when it is not
 * `completed`, or when it IS completed but its latest gate row failed (a regression the done-gate
 * can't retroactively catch). Total + fail-open: no db/session, no active plan, no steps, or any
 * error → not blocked (never invent a stop).
 */
export function assessStop(db: MinimaDb | null, sessionId: string | null): StopAssessment {
  if (!db || !sessionId) return EMPTY_ASSESSMENT;
  try {
    const plan = db.getActivePlan(sessionId);
    if (!plan) return EMPTY_ASSESSMENT;
    // Gate only on the plan of record — the newest non-cancelled plan, the same one /why and
    // Ctrl+G display. An older still-active row (adoption/seeding pile-up) that a newer closed
    // plan has outlived is stale evidence, never a reason to block the stop (MUB-181).
    const latest = db.getLatestPlan(sessionId, { excludeCancelled: true });
    if (latest && latest.id !== plan.id) return EMPTY_ASSESSMENT;
    const steps = db.getPlanSteps(plan.id);
    if (steps.length === 0) return EMPTY_ASSESSMENT;

    const latestGateByStep = new Map<string, GateRow>();
    for (const g of db.getGates(plan.id)) {
      if (g.step_id) latestGateByStep.set(g.step_id, g); // getGates is oldest-first → last wins
    }

    const reasons: string[] = [];
    let incomplete = 0;
    let redSteps = 0;
    steps.forEach((s, i) => {
      const label = `step ${i + 1}/${steps.length}`;
      if (s.status !== "completed") {
        incomplete += 1;
        reasons.push(`${label} not complete: ${trunc(s.content)}`);
        return;
      }
      const gate = latestGateByStep.get(s.id);
      if (gate?.outcome === "failed") {
        redSteps += 1;
        reasons.push(`${label} check failing: ${trunc(s.content)}`);
      }
    });
    return { blocked: reasons.length > 0, reasons, incomplete, redSteps };
  } catch {
    return EMPTY_ASSESSMENT;
  }
}

function reasonsBlock(a: StopAssessment): string {
  const shown = a.reasons.slice(0, MAX_REASONS_SHOWN);
  const extra = a.reasons.length - shown.length;
  const lines = shown.map((r) => `  • ${r}`);
  if (extra > 0) lines.push(`  • +${extra} more`);
  return lines.join("\n");
}

/** The continuation message pushed into the follow-up queue when a stop attempt is denied. */
function continuationMessage(a: StopAssessment, strike: number, maxStrikes: number): Message {
  const attempt = strike > 0 ? ` (attempt ${strike} of ${maxStrikes})` : "";
  const body = [
    `⛔ You are ending the turn, but the plan is not done — ${a.reasons.length} step(s) still need to be finished and verified${attempt}:`,
    reasonsBlock(a),
    "",
    "Keep working: make each step's `verify` pass (red→green) and mark it completed, or decompose a",
    "step you cannot check into smaller steps that you can. If a step is genuinely blocked, say so",
    "explicitly and why. Do not stop until the plan is complete.",
  ].join("\n");
  return new Message({ role: "user", content: [text(body)] });
}

/** A steer message: the user's free-text redirection injected as a follow-up. */
function steerMessage(steer: string): Message {
  return new Message({
    role: "user",
    content: [text(`The user reviewed the unfinished plan and steered:\n${steer.trim()}`)],
  });
}

/** The two offered choices. Matched by EXACT (case-insensitive) equality so that free text — which
 * the overlay returns as the same raw string as an option pick — is never mistaken for a pick. */
const KEEP_GOING_LABEL = "keep going";
const ACCEPT_LABEL = "accept as done";

/** What the user (or the headless fallback) decided once the strikes were spent. */
type Decision = { kind: "keep-going" } | { kind: "steer"; text: string } | { kind: "stop" };

/**
 * Ask the user what to do now that the strikes are spent. Interactive → the question overlay with
 * two choices; free text is treated as a STEER (the run continues carrying the user's instruction —
 * never discarded). Headless (no ask channel), a dismiss, or an ask that throws → `stop` (let the
 * run end; the audit row still records it). To stop, the user picks "accept as done" or dismisses
 * (Esc): we deliberately bias free text toward continue-with-steer, since misreading a steering
 * instruction as "stop" would silently throw away in-flight work.
 */
async function askOnExhaustion(ref: AskUserRef | null, a: StopAssessment): Promise<Decision> {
  const ask = ref?.current;
  if (!ask) return { kind: "stop" };
  let answer: string | null;
  try {
    answer = await ask({
      question: [
        `The plan still isn't finished — ${a.reasons.length} step(s) unverified after repeated attempts:`,
        reasonsBlock(a),
        "",
        "Keep going, accept as done (or Esc), or type how to steer?",
      ].join("\n"),
      header: "Unfinished plan",
      options: [
        {
          label: KEEP_GOING_LABEL,
          description: "Give the agent more attempts to finish and verify.",
        },
        { label: ACCEPT_LABEL, description: "Stop here and accept the work as-is." },
      ],
      allow_freetext: true,
    });
  } catch {
    return { kind: "stop" };
  }
  if (!answer) return { kind: "stop" }; // dismissed (Esc) → let it end
  const norm = answer.trim().toLowerCase();
  if (norm === KEEP_GOING_LABEL) return { kind: "keep-going" };
  if (norm === ACCEPT_LABEL) return { kind: "stop" };
  return { kind: "steer", text: answer }; // any free text → continue carrying the instruction
}

/** Identity/provenance the stop gate row carries. `recId` is intentionally NOT taken. */
export interface StopGateDeps {
  db: MinimaDb | null;
  sessionId: string | null;
  agentId: string | null;
  /** N: deny up to this many stop attempts, then ask. Caller guarantees > 0. */
  maxStrikes: number;
  /** Late-bound ask channel (null in headless). */
  askUser: AskUserRef | null;
  /** R5c: true once the anti-spiral's step-cap wrap fired this rung (runtime.ts threads one
   * shared per-rung flag). A stop attempt is then SKIPPED — no strike spent, no follow-up:
   * the harness just told the model to wrap up, and a ⛔ "keep working" would whipsaw it. */
  capWrapFired?: () => boolean;
}

/**
 * Write the single audit-only `stop` gate row. `recId: null` keeps it out of the feedback join by
 * construction (the migration-v6 "NULL = invisible to the feedback join" contract), so it can never
 * inflate or fail a routed rung; `sessionId`/`agentId` are provenance only. Fail-open.
 */
function writeStopGate(deps: StopGateDeps, a: StopAssessment, decision: Decision): void {
  if (!deps.db || !deps.sessionId) return;
  try {
    const plan = deps.db.getActivePlan(deps.sessionId);
    if (!plan) return;
    deps.db.insertGate({
      planId: plan.id,
      stepId: null,
      kind: "stop",
      outcome: "unchecked",
      confidence: "red",
      verifiedBy: null,
      factors: {
        stop: true,
        incomplete: a.incomplete,
        redSteps: a.redSteps,
        decision: decision.kind,
      },
      recId: null,
      sessionId: deps.sessionId,
      agentId: deps.agentId,
    });
  } catch {
    // audit is best-effort; never break the loop over a bookkeeping write.
  }
}

/** True when the settled turn still requested tools — i.e. NOT a stop attempt. */
function isToolTurn(assistant: AssistantMessage): boolean {
  return assistant.stop_reason === "toolUse";
}

/** True when a result carries an explicit user answer (the question tool's details contract). */
function hasAnsweredQuestion(results: ToolResultLike[]): boolean {
  return results.some((r) => r.details?.answered === true);
}

/**
 * Build the run-level stop-gate as a `ShouldStopAfterTurn`. The strike counter is closed over here,
 * so a fresh gate (one per recovery rung) resets strikes. Returns:
 *   - `false` + a queued follow-up  → deny the stop, force another turn.
 *   - `false` (no follow-up)        → allow the natural stop (plan done, or a tool turn).
 *   - `true`                        → stop now (strikes spent and the user/headless chose to end).
 */
export function makeStopGate(deps: StopGateDeps): ShouldStopAfterTurn {
  let strikes = 0;
  let answeredLastTurn = false;
  return async (
    assistant: AssistantMessage,
    results: ToolResultLike[],
    state: AgentState,
  ): Promise<boolean> => {
    if (deps.maxStrikes <= 0) return false; // disabled
    if (isToolTurn(assistant)) {
      answeredLastTurn = hasAnsweredQuestion(results);
      return false; // still working — not a stop attempt
    }
    const answered = answeredLastTurn;
    answeredLastTurn = false;
    // Queued steering already re-drives the loop (loop.ts:165, drained before our follow-up), so
    // defer to it rather than spend a strike and push a continuation that would only wait behind it.
    if (state.steering.length > 0) return false;
    // A question the user just answered IS steering: the reply that immediately follows it may
    // end the turn without spending a strike — the user is present and directing the run.
    if (answered) return false;
    // R5c: the step-cap already told the model to wrap up NOW — never contradict it with a
    // "keep working" strike for the rest of the rung (skip, don't count).
    if (deps.capWrapFired?.()) return false;

    const assessment = assessStop(deps.db, deps.sessionId);
    if (!assessment.blocked) return false; // plan done → allow the natural stop

    if (strikes < deps.maxStrikes) {
      strikes += 1;
      state.followUp.push(continuationMessage(assessment, strikes, deps.maxStrikes));
      return false; // the queued follow-up re-drives the loop
    }

    // Strikes spent — stop fighting the agent and ask (or end, headless).
    const decision = await askOnExhaustion(deps.askUser, assessment);
    if (decision.kind === "keep-going") {
      strikes = 0; // grant a fresh set of attempts
      state.followUp.push(continuationMessage(assessment, 0, deps.maxStrikes));
      return false;
    }
    if (decision.kind === "steer") {
      strikes = 0;
      state.followUp.push(steerMessage(decision.text));
      return false;
    }
    writeStopGate(deps, assessment, decision);
    return true;
  };
}
