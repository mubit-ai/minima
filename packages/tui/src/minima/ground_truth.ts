/**
 * Ground-Truth ledger — pure projection/attribution helpers + the afterToolCall sink that
 * keeps the SQLite plan of record in step with what the agent actually did. Everything here
 * is gated by MINIMA_TUI_GROUND_TRUTH at the wiring sites (main.ts / runtime.ts); this module
 * itself is inert until a caller invokes it.
 *
 * M3.3: the todowrite branch of the sink also captures a pre-work baseline — when a step
 * with a `verify` command first enters in_progress (or first gains a verify while already
 * in_progress), its check is run once and the result (red|green|unrunnable) is recorded on
 * the step, so post-work gates can tell "I fixed it" from "it was already green".
 *
 * M4.1–M4.3: groundTruthHooks adds the done-gate — a beforeToolCall that refuses any
 * todowrite completing a step whose `verify` does not pass (enforcement in the dispatcher,
 * not the prompt), and gate rows recording every verification verdict, including the blocked
 * attempts (Stage 7's attempts signal). It also enforces ONE todowrite per assistant message:
 * all before-hooks in a batch run before any tool executes, so a second todowrite would be
 * previewed against stale (pre-batch) plan state — a gate bypass. Checks are cancellable by
 * the run's AbortSignal (GtAgentRef.runSignal); an aborted check is never evidence.
 *
 * Fail-open is a hard rule for BOOKKEEPING: a broken ledger write must never break a turn.
 * The afterToolCall factory swallows its own errors, and the pure helpers are total (never
 * throw on bad input). The done-gate is the one deliberate exception — it is ENFORCEMENT, so
 * a check that runs and fails (or cannot run) fails CLOSED; only gate infrastructure breaking
 * (db gone, preview threw) falls back to allow.
 */
import type { AfterToolCall, BeforeToolCall } from "../agent/tools.ts";
import type {
  CompletionFlip,
  FileChangeRow,
  GateRow,
  MinimaDb,
  PlanRow,
  PlanStepRow,
  TodoInput,
} from "../db/minima_db.ts";
import { baselineFromResult, resolveCheckTimeoutMs, runCheck, wasAborted } from "./check.ts";
import type { ConfidenceTier, Factors, GateOutcome, VerifiedBy } from "./gt_contract.ts";
import {
  type FactorFs,
  classifyCheckOrigin,
  computeCoverageHit,
  defaultFactorFs,
  detectTamper,
} from "./gt_factors.ts";
import { gateVerdictFor } from "./why.ts";

/**
 * Minimal structural view of MinimaAgent — avoids a runtime import cycle. `runSignal` (the
 * in-flight run's AbortSignal, null when idle) makes every check the ledger spawns
 * cancellable by the same abort() that stops the run; optional so tests can pass a bare
 * {db, runId} pair.
 */
export interface GtAgentRef {
  db: MinimaDb | null;
  runId: string | null;
  readonly runSignal?: AbortSignal | null;
  /** The routed rung currently executing (set around super.prompt) — stamps gate identity. */
  readonly currentRecId?: string | null;
  readonly agentId?: string | null;
}

/** Compact footer facts about the active plan (M1.3 strip + M2.3 drift). */
export interface PlanStripInfo {
  /** 1-based position of the active step. */
  stepPos: number;
  stepTotal: number;
  /** The active step's text (falls back to the plan title). */
  title: string;
  /** Count of off-plan (drift) file changes recorded against the plan. */
  drift: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — total functions, safe on malformed input.
// ---------------------------------------------------------------------------

/**
 * M1.1 + M3.1: parse the todowrite tool's `tasks` argument (a JSON string of
 * {content,status,verify?,...}) into ledger todos. M3.1 reverses the old "never source
 * `verify` here" policy: a non-blank `verify` string is trimmed and carried through so the
 * agent can attach/overwrite a step's check command via todowrite. The key is OMITTED (never
 * null) when absent/blank, so the agent can set or overwrite a verify but never clear one —
 * undefined → NULL bind → COALESCE in upsertPlanFromTodos preserves the existing value.
 */
export function parseTodos(raw: unknown): TodoInput[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: TodoInput[] = [];
  for (const t of parsed) {
    if (t == null || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    const content = String(rec.content ?? "").trim();
    if (!content) continue;
    const status = normalizeStatus(rec.status);
    const verify =
      typeof rec.verify === "string" && rec.verify.trim() ? rec.verify.trim() : undefined;
    out.push(verify ? { content, status, verify } : { content, status });
  }
  return out;
}

function normalizeStatus(s: unknown): string {
  return s === "in_progress" || s === "completed" ? s : "pending";
}

/** File paths a write/edit/apply_patch tool call touched (for file_change attribution). */
export function writePathsFromArgs(toolName: string, args: Record<string, unknown>): string[] {
  switch (toolName) {
    case "write":
    case "edit": {
      const p = args.path;
      return typeof p === "string" && p.trim() ? [p.trim()] : [];
    }
    case "apply_patch": {
      const patch = typeof args.patch === "string" ? args.patch : "";
      return pathsFromPatch(patch);
    }
    default:
      return [];
  }
}

/** Extract target paths from a `*** Add/Update/Delete File:` apply_patch envelope. */
export function pathsFromPatch(patch: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
    if (m) {
      const p = m[1]!.trim();
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/** M2.2: best-effort change kind. `write` creates (or overwrites); edit/patch modify. */
export function kindForTool(toolName: string): "created" | "modified" {
  return toolName === "write" ? "created" : "modified";
}

/**
 * M2.2/M2.3 drift heuristic: does the in-progress step's text lay claim to this path? Kept
 * deliberately simple — a full-path or basename mention counts as on-plan. Unmatched writes
 * are marked off_plan so the footer can surface drift.
 */
export function isPathClaimed(stepContent: string | null | undefined, path: string): boolean {
  if (!stepContent || !path) return false;
  const hay = stepContent.toLowerCase();
  const norm = path.toLowerCase();
  if (hay.includes(norm)) return true;
  const base = norm.split("/").pop() ?? "";
  return base.length > 0 && hay.includes(base);
}

/**
 * The always-on Ground-Truth contract, injected into the system prompt whenever `groundTruth` is
 * on — INDEPENDENT of whether a plan exists yet. This is the fix for the plan-authoring gap: the
 * plan projection ({@link formatPlanProjection}) carries the "attach a verify" nudge but is inert
 * until the first todowrite has already created the plan, so without this block the model authors
 * its whole plan before ever seeing the contract. Kept honest per the build guide §6 — genuinely
 * uncheckable scaffolding steps may omit `verify` (they stay flagged, not verified); the model must
 * not fabricate throwaway checks to dodge the gate.
 */
export const GROUND_TRUTH_SYSTEM_GUIDANCE = [
  "# Ground-Truth verification is ON",
  "You plan with the todowrite tool and the harness verifies each step against a real command.",
  "When you FIRST create a step that produces something a command can check — a feature, a fix, a",
  "test — attach a `verify` shell command that proves it (a real test/build command, e.g.",
  "`bun test tests/foo.test.ts`). Do not wait until the step is done to add it.",
  "Marking a step completed runs its `verify` first; the completion is REFUSED unless the check",
  "passes, so a step whose check you cannot yet make pass is simply not done.",
  "A pure-scaffolding step with no runnable check may omit `verify` — it will be flagged for review,",
  "not verified. Never write a throwaway test just to have a green check.",
].join("\n");

/**
 * M1.2 + M3.1: project a persisted plan into a compact, numbered system-prompt block with the
 * active step marked, so the model always sees the plan of record. Steps that carry a `verify`
 * command render it inline so the model knows the check it must keep green. Returns null for
 * an empty plan.
 */
export function formatPlanProjection(plan: PlanRow, steps: PlanStepRow[]): string | null {
  if (steps.length === 0) return null;
  const pos = activeStepPos(steps);
  const lines = steps.map((s, i) => {
    const mark = s.status === "completed" ? "x" : s.status === "in_progress" ? ">" : " ";
    const verify = s.verify ? ` — verify: \`${s.verify}\`` : "";
    return `${i + 1}. [${mark}] ${s.content ?? ""}${verify}`;
  });
  const header = `# Current plan (step ${pos}/${steps.length}${plan.title ? ` — ${plan.title}` : ""})`;
  return `${header}\n${lines.join("\n")}\n\nStay on this plan. As you work, keep it current with todowrite (mark steps in_progress/completed); do not silently drift onto unrelated files. Any step above without a \`verify\` and where a runnable check exists still needs one: add it now with todowrite. Marking a step completed runs its \`verify\` first; the completion is refused unless the check passes.`;
}

/** Convenience for runtime.ts: fetch + project the active plan for a session. */
export function planProjectionFor(db: MinimaDb | null, sessionId: string | null): string | null {
  if (!db || !sessionId) return null;
  const plan = db.getActivePlan(sessionId);
  if (!plan) return null;
  return formatPlanProjection(plan, db.getPlanSteps(plan.id));
}

/** M1.3/M2.3: footer facts for the active plan, or null when there is no plan to show. */
export function planStripInfo(db: MinimaDb | null, sessionId: string | null): PlanStripInfo | null {
  if (!db || !sessionId) return null;
  const plan = db.getActivePlan(sessionId);
  if (!plan) return null;
  const steps = db.getPlanSteps(plan.id);
  if (steps.length === 0) return null;
  const pos = activeStepPos(steps);
  const active = steps[Math.min(pos - 1, steps.length - 1)];
  return {
    stepPos: pos,
    stepTotal: steps.length,
    title: active?.content ?? plan.title ?? "",
    drift: db.countOffPlanChanges(plan.id),
  };
}

/**
 * M1.3: the footer plan-of-record line, e.g. `▸ plan 2/5 — Wire the router`. Interior newline
 * runs in the step content (plus surrounding indentation) collapse to a single space so the
 * strip is provably one rendered row against its one-row footer reservation — projection-only:
 * `plan_steps.content` stays verbatim in the DB.
 */
export function planStripLabel(info: PlanStripInfo): string {
  return `▸ plan ${info.stepPos}/${info.stepTotal} — ${info.title.replace(/\s*[\r\n]+\s*/g, " ")}`;
}

/**
 * M2.3: the drift suffix appended (in yellow) after the label when off-plan changes exist,
 * e.g. `   ⚠ 3 off-plan (drift)`. Returns "" for zero drift so the caller renders nothing.
 */
export function planStripDrift(drift: number): string {
  return drift > 0 ? `   ⚠ ${drift} off-plan (drift)` : "";
}

/**
 * 1-based active step: the first in-progress step, else the first not-yet-completed step,
 * else the last (all done). Never returns 0 for a non-empty list.
 */
function activeStepPos(steps: PlanStepRow[]): number {
  const inProgress = steps.findIndex((s) => s.status === "in_progress");
  if (inProgress >= 0) return inProgress + 1;
  const firstOpen = steps.findIndex((s) => s.status !== "completed");
  if (firstOpen >= 0) return firstOpen + 1;
  return steps.length;
}

// ---------------------------------------------------------------------------
// M7.1/M7.2/M7.3 grounded outcome — the run's most recent verified step's verdict.
// ---------------------------------------------------------------------------

/** The grounded verdict of the step verified under a prompt (M7.1 stamp, M7.2 feedback, M7.3 ladder). */
export interface GroundedOutcome {
  gateId: string;
  outcome: GateOutcome; // verified | failed | unrunnable
  verifiedBy: VerifiedBy; // deterministic | judge | user
  confidence: ConfidenceTier | null; // green | yellow | red — stored tier, else derived from factors
}

/**
 * A gate row's flip identity within one rung. Content-first: a brand-new todo completed in one
 * shot has NO step row when its blocked attempt is written (the whole call was refused, so the
 * upsert never ran), while the passing retry's verdict row does — only the flip's content links
 * the two, so the retry can supersede the orphan red. step_id covers rows written without
 * flipContent (seeded/legacy); the row's own id makes the key total.
 */
function flipKeyFor(gate: GateRow): string {
  if (gate.factors_json) {
    try {
      const raw = JSON.parse(gate.factors_json) as Record<string, unknown>;
      if (typeof raw.flipContent === "string" && raw.flipContent.trim())
        return `c:${raw.flipContent.trim()}`;
    } catch {
      // fall through to step/row identity
    }
  }
  if (gate.step_id) return `s:${gate.step_id}`;
  return `g:${gate.id}`;
}

const TIER_BADNESS: Record<ConfidenceTier, number> = { green: 0, yellow: 1, red: 2 };

/**
 * Read the grounded verdict of the gates minted under ONE routed rung (`recId`) — identity join,
 * never recency. The single seam three milestones share: M7.1 stamps it onto
 * `routing_decisions.gt_*`, M7.2 prefers it over the LLM judge in feedback, M7.3 escalates on a
 * failed one. Rows with NULL rec_id (pre-v6 history, manual seeds) match no rung and are invisible
 * here by construction — stale gates cannot poison later prompts.
 *
 * Aggregation, over the LATEST row per flip (see {@link flipKeyFor}):
 *  - any failed/unrunnable → that verdict (newest such row) — red always wins;
 *  - else any verified → the newest verified row, with `confidence` = the WORST tier across
 *    every flip this rung completed: verified rows resolve via {@link gateVerdictFor} (a null
 *    tier counts yellow), and `unchecked` completions count yellow — so a green (and with it
 *    verified_in_production) requires every completion flip to be verified green;
 *  - only unchecked rows → null (no deterministic evidence either way; the judge path runs).
 *
 * Total + fail-open: null db/recId, no rows, or nothing with an outcome+verifier returns `null`
 * (never throws into the feedback path).
 */
export function groundedOutcomeFor(
  db: MinimaDb | null,
  recId: string | null,
): GroundedOutcome | null {
  if (!db || !recId) return null;
  try {
    const gates = db.getGatesForRec(recId); // oldest-first; later rows supersede per flip
    if (gates.length === 0) return null;
    const latest = new Map<string, GateRow>();
    for (const g of gates) if (g.outcome) latest.set(flipKeyFor(g), g);
    const rows = [...latest.values()];
    const attributed = rows.filter((g) => g.outcome !== "unchecked" && g.verified_by);
    if (attributed.length === 0) return null;
    const reds = attributed.filter((g) => g.outcome !== "verified");
    const gate = reds.length > 0 ? reds[reds.length - 1]! : attributed[attributed.length - 1]!;
    if (!gate.outcome || !gate.verified_by) return null;
    if (reds.length > 0) {
      return {
        gateId: gate.id,
        outcome: gate.outcome,
        verifiedBy: gate.verified_by,
        confidence: gateVerdictFor(gate).tier,
      };
    }
    let worst: ConfidenceTier = "green";
    for (const g of rows) {
      const tier: ConfidenceTier =
        g.outcome === "unchecked" ? "yellow" : (gateVerdictFor(g).tier ?? "yellow");
      if (TIER_BADNESS[tier] > TIER_BADNESS[worst]) worst = tier;
    }
    return {
      gateId: gate.id,
      outcome: gate.outcome,
      verifiedBy: gate.verified_by,
      confidence: worst,
    };
  } catch {
    return null; // fail-open: a broken ledger read must never break the turn.
  }
}

/**
 * M7.1: stamp the grounded (deterministic) outcome of the gates minted under `recId` onto the
 * routing decision that picked the model — so Minima learns "the test passed" instead of "the
 * judge guessed 0.7". Called from the runtime feedback seam once a prompt's decision row exists
 * (see runtime.persistDecision). Identity-scoped: only this rung's own gates can stamp it.
 *
 * Total + fail-open: a null db/recId or no grounded gate is a silent no-op.
 */
export function stampGroundedOutcome(db: MinimaDb | null, recId: string | null): void {
  if (!db || !recId) return;
  const grounded = groundedOutcomeFor(db, recId);
  if (!grounded) return;
  try {
    db.attachGroundedOutcome(recId, {
      outcome: grounded.outcome,
      verifiedBy: grounded.verifiedBy,
      confidence: grounded.confidence,
    });
  } catch {
    // fail-open: grounded stamping must never break the feedback path.
  }
}

// ---------------------------------------------------------------------------
// afterToolCall sink — persist the plan + attribute file changes.
// ---------------------------------------------------------------------------

/**
 * M3.3: total wall-clock budget for one todowrite's baseline checks. Each check is capped at
 * the remaining budget (never above the normal per-check timeout); steps whose check would
 * start past the deadline keep a NULL baseline — signal lost, never fabricated — so one
 * todowrite can never wedge a turn for more than this long.
 */
export const BASELINE_BUDGET_MS = 120_000;

/**
 * M1.1 + M2.1/M2.2 + M3.3: after each successful tool call, keep the ledger in step:
 *  - `todowrite`  → upsert the plan + steps for this run, then capture a pre-work baseline
 *    (runCheck on the step's `verify`) for each step that just entered in_progress or just
 *    gained its first verify — once-only per step, sequentially (checks may contend for the
 *    repo), under a shared BASELINE_BUDGET_MS deadline, each step individually fail-open so
 *    one broken write cannot starve the remaining captures.
 *  - write/edit/apply_patch → record each touched path as a file_change, attributed to the
 *    in-progress step and marked on_plan/off_plan (drift).
 * Errored tool calls are ignored (nothing durable happened). All failures are swallowed —
 * ledger bookkeeping must never break a turn.
 */
export function groundTruthAfterToolCall(ref: GtAgentRef): AfterToolCall {
  return async (ctx) => {
    try {
      const db = ref.db;
      const session = ref.runId;
      if (!db || !session || ctx.isError) return null;
      const name = ctx.toolCall.name;
      const args = ctx.toolCall.arguments ?? {};

      if (name === "todowrite") {
        const todos = parseTodos(args.tasks);
        if (todos.length > 0) {
          const { started } = db.upsertPlanFromTodos(session, todos);
          const deadline = performance.now() + BASELINE_BUDGET_MS;
          for (const s of started) {
            if (!s.verify) continue;
            const remaining = deadline - performance.now();
            if (remaining <= 0) break;
            try {
              const result = await runCheck(s.verify, {
                timeoutMs: Math.min(remaining, resolveCheckTimeoutMs()),
                signal: ref.runSignal ?? undefined,
              });
              // A user abort is NO EVIDENCE: leave the baseline NULL (signal lost, never
              // fabricated) and stop — the whole run is being torn down anyway.
              if (wasAborted(result)) break;
              db.setStepBaseline(s.id, baselineFromResult(result));
            } catch {
              // per-step fail-open: one failed baseline write must not skip the rest.
            }
          }
        }
        return null;
      }

      const paths = writePathsFromArgs(name, args);
      if (paths.length === 0) return null;
      const plan = db.getActivePlan(session);
      if (!plan) return null; // no plan of record yet — nothing to attribute against
      const step = db.getInProgressStep(plan.id);
      const kind = kindForTool(name);
      for (const path of paths) {
        const origin = step && isPathClaimed(step.content, path) ? "on_plan" : "off_plan";
        db.insertFileChange({ planId: plan.id, stepId: step?.id ?? null, path, kind, origin });
      }
    } catch {
      // fail-open: never let ledger bookkeeping break the turn.
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Done-gate (M4.1–M4.3) — enforcement at the dispatcher, gate rows for every verdict.
// ---------------------------------------------------------------------------

/**
 * M4.1: total wall-clock budget for one todowrite's done-gate checks (mirrors
 * BASELINE_BUDGET_MS). Each check is capped at min(remaining, resolveCheckTimeoutMs()); a
 * flip whose check would start past the deadline is UNRUNNABLE and blocks — unlike the
 * baseline path, a completion claim with no evidence fails closed, never silently through.
 */
export const GATE_BUDGET_MS = 120_000;

/** Trailing slice of a check's combined output carried into reasons + factors_json. */
const OUTPUT_TAIL_CHARS = 400;

function outputTail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? trimmed.slice(-OUTPUT_TAIL_CHARS) : trimmed;
}

/** The frozen Factors shape plus debug extras persisted alongside it in gates.factors_json. */
type GateFactors = Factors & {
  outputTail?: string;
  durationMs?: number;
  exitCode?: number | null;
  /** The flip's trimmed content — the row's identity when it has no step_id (see flipKeyFor). */
  flipContent?: string;
};

/**
 * A verdict computed in the before-hook, held until the after-hook writes its gate row.
 * `stepId` is the previewed flip's matched step id (stable through the content-matched
 * upsert), so the gate row lands on the exact step the check verified even when several
 * steps share the same content; null only for a brand-new todo completed in one shot,
 * whose row does not exist until the upsert runs.
 */
interface GateVerdict {
  content: string;
  stepId: string | null;
  outcome: "verified" | "unchecked";
  factors: GateFactors;
}

/** Factors for a flip that carries no check at all (M4.3 'unchecked'). */
function uncheckedFactors(): GateFactors {
  return {
    pass: false,
    redToGreen: false,
    hasCheck: false,
    checkOrigin: "agent_new",
    coverageHit: "unknown",
    tamper: false,
  };
}

/** Appended to every block reason: what happened, how to proceed, and the batch caveat. */
const GATE_BLOCK_CODA =
  "All task statuses were left unchanged. Fix the code until the check passes, or overwrite " +
  "the step's `verify` with the correct command (it cannot be cleared), then re-send the " +
  "todowrite. Important: these checks run before any other tool call in the current batch " +
  "executes — make your edits first and mark the step completed in a later message.";

/**
 * One todowrite per assistant message, enforced in the dispatcher: every before-hook in a
 * batch runs before ANY tool in it executes (agent/loop.ts plan-building pass), so a second
 * todowrite would be previewed against pre-batch DB state — letting a red step reach done
 * via an in_progress+completed pair, or double-writing gate rows for one flip. The second
 * call is refused whole; nothing about it was applied.
 */
const SAME_BATCH_BLOCK =
  "Only one todowrite per assistant message: another todowrite in this same message has not " +
  "executed yet, so this call's completion checks would run against stale plan state. This " +
  "call was refused before executing (none of its statuses were applied) — consolidate the " +
  "list into a single todowrite, or re-send this one in your next message.";

/**
 * M4.1–M4.3: the Ground-Truth hook pair. `after` is the existing ledger sink
 * (groundTruthAfterToolCall: plan upsert, baseline capture, file_change attribution) plus the
 * gate-row writer; `before` is the done-gate. Register BOTH on the agent's hook stacks, after
 * the permission hook where one exists (permission first, gate second; first block wins).
 *
 * before — the gate. First the same-batch guard: loop.ts runs every before-hook in a batch
 * before ANY tool in it executes, so while one allowed todowrite is still awaiting execution
 * (`inFlight`, validated against the batch's live pendingToolCalls) any other todowrite is
 * refused outright — a second preview against pre-batch DB state could bypass the gate or
 * double-write gate rows. Then, for each step the todowrite would flip to completed (the DB
 * preview, matched with the upsert's own semantics) it runs the step's effective `verify`
 * under a shared GATE_BUDGET_MS deadline, sequentially (checks may contend for the repo),
 * each check cancellable by the run's AbortSignal:
 *   - any check that fails, times out, cannot spawn, is aborted, or has no budget left to
 *     start → the WHOLE todowrite is blocked (no statuses change — the tool never executes)
 *     and each failing flip gets a durable attempt row NOW (outcome failed|unrunnable,
 *     deterministic); an aborted check is unrunnable, never `failed` — no evidence either way;
 *   - all checked flips pass → the verdicts (verified + unchecked for verify-less flips) are
 *     parked in `pending` keyed by toolCall id, and the call is allowed.
 * Verify-less flips never block (M4.3 records them as 'unchecked' instead). Only gate
 * INFRASTRUCTURE failing (no db, preview threw, unparsable args) falls open to allow.
 *
 * after — the sink first (so the plan of record reflects the successful todowrite), then one
 * gate row per parked verdict, attributed to the verdict's previewed stepId (ids survive the
 * content-matched upsert); only a brand-new todo completed in one shot (stepId null) falls
 * back to content resolution against the freshly-upserted plan, consuming first-come like the
 * upsert so duplicate contents cannot double-attribute. The pending + inFlight entries are
 * deleted in a `finally` (also on ctx.isError), so neither can grow: a BLOCKED call never
 * parks verdicts (loop.ts `continue`s before execution, so its after-hook never fires).
 *
 * `gateBudgetMs` is injectable for tests only; production uses GATE_BUDGET_MS.
 */
export function groundTruthHooks(
  ref: GtAgentRef,
  opts?: { gateBudgetMs?: number; fs?: FactorFs },
): { before: BeforeToolCall; after: AfterToolCall } {
  const budgetMs = opts?.gateBudgetMs ?? GATE_BUDGET_MS;
  const fs = opts?.fs ?? defaultFactorFs;
  const sink = groundTruthAfterToolCall(ref);
  const pending = new Map<string, GateVerdict[]>();
  const inFlight = new Set<string>();

  const before: BeforeToolCall = async (ctx) => {
    try {
      const db = ref.db;
      const session = ref.runId;
      if (!db || !session || ctx.toolCall.name !== "todowrite") return null;
      // Same-batch guard. Prune entries no longer pending (their batch is over — covers an
      // abandoned batch whose after-hooks never fired) so a stale id can never wedge the gate
      // and an orphaned parked verdict can never leak.
      const live = ctx.context?.pendingToolCalls;
      if (live) {
        for (const id of inFlight) {
          if (!live.has(id)) {
            inFlight.delete(id);
            pending.delete(id);
          }
        }
      }
      if (inFlight.size > 0) return { block: true, reason: SAME_BATCH_BLOCK };
      const todos = parseTodos(ctx.args.tasks);
      if (todos.length === 0) return null;
      const flips = db.completionsForTodos(session, todos);
      if (flips.length === 0) {
        inFlight.add(ctx.toolCall.id);
        return null;
      }

      // Stage 5 factor inputs: this run's file_changes (provenance/coverage/tamper), read once.
      // gatePlanId is reused below for the blocked-attempt rows. tamper is a run-level fact —
      // computed once for the whole batch, not per flip.
      let gatePlanId: string | null = null;
      let fileChanges: FileChangeRow[] = [];
      try {
        gatePlanId = db.getActivePlan(session)?.id ?? null;
        if (gatePlanId) fileChanges = db.getFileChanges(gatePlanId);
      } catch {
        // no ledger read — Stage 5 factors degrade to their neutral defaults.
      }
      const tamper = detectTamper(fileChanges, fs);

      const verdicts: GateVerdict[] = [];
      const failures: {
        flip: CompletionFlip;
        outcome: "failed" | "unrunnable";
        why: string;
        factors: GateFactors;
      }[] = [];
      const deadline = performance.now() + budgetMs;
      for (const flip of flips) {
        if (!flip.verify) {
          verdicts.push({
            content: flip.content,
            stepId: flip.stepId,
            outcome: "unchecked",
            factors: { ...uncheckedFactors(), tamper, flipContent: flip.content },
          });
          continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          failures.push({
            flip,
            outcome: "unrunnable",
            why: `could not run (the ${budgetMs} ms gate budget was exhausted by earlier checks)`,
            factors: { ...uncheckedFactors(), hasCheck: true, tamper, flipContent: flip.content },
          });
          continue;
        }
        const capMs = Math.min(remaining, resolveCheckTimeoutMs());
        const result = await runCheck(flip.verify, {
          timeoutMs: capMs,
          signal: ref.runSignal ?? undefined,
        });
        const factors: GateFactors = {
          pass: result.pass,
          redToGreen: flip.baseline === "red" && result.pass,
          hasCheck: true,
          // M5.1 provenance / M5.2 coverage / M5.3 tamper — computed from this run's file_changes.
          checkOrigin: classifyCheckOrigin(flip.verify, fileChanges),
          coverageHit: computeCoverageHit(flip.verify, fileChanges, fs),
          tamper,
          outputTail: outputTail(result.output),
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          flipContent: flip.content,
        };
        if (result.timedOut || result.spawnError !== null || wasAborted(result)) {
          failures.push({
            flip,
            outcome: "unrunnable",
            why: result.timedOut
              ? `could not run (timed out after ${Math.round(capMs)} ms)`
              : result.spawnError !== null
                ? `could not run (spawn error: ${result.spawnError})`
                : "could not run (the run was aborted mid-check)",
            factors,
          });
        } else if (!result.pass) {
          failures.push({
            flip,
            outcome: "failed",
            why: `failed:\n${factors.outputTail}`,
            factors,
          });
        } else {
          verdicts.push({
            content: flip.content,
            stepId: flip.stepId,
            outcome: "verified",
            factors,
          });
        }
      }

      if (failures.length > 0) {
        // M4.1 attempt rows: every blocked attempt is a durable observation (Stage 7 reads
        // the attempts count). Written NOW — a blocked call's after-hook never fires.
        const planId = gatePlanId;
        for (const f of failures) {
          try {
            db.insertGate({
              planId,
              stepId: f.flip.stepId,
              kind: "step_check",
              outcome: f.outcome,
              confidence: null,
              verifiedBy: "deterministic",
              factors: f.factors,
              recId: ref.currentRecId ?? null,
              sessionId: session,
              agentId: ref.agentId ?? null,
            });
          } catch {
            // per-row fail-open: a broken attempt write must not cancel the block below.
          }
        }
        const lines = failures.map(
          (f) => `Step not verified — "${f.flip.content}": check \`${f.flip.verify}\` ${f.why}`,
        );
        return { block: true, reason: `${lines.join("\n\n")}\n\n${GATE_BLOCK_CODA}` };
      }

      if (verdicts.length > 0) pending.set(ctx.toolCall.id, verdicts);
      inFlight.add(ctx.toolCall.id);
      return null;
    } catch {
      // gate infrastructure broke — fail-open (the checks themselves fail closed above).
      return null;
    }
  };

  const after: AfterToolCall = async (ctx) => {
    const out = await sink(ctx);
    try {
      const verdicts = pending.get(ctx.toolCall.id);
      if (!verdicts || ctx.isError) return out;
      const db = ref.db;
      const session = ref.runId;
      if (!db || !session) return out;
      const plan = db.getActivePlan(session);
      if (!plan) return out;
      // Attribution: trust the previewed stepId (stable through the upsert). Only stepId-null
      // verdicts (brand-new todos completed in one shot) resolve by content — via a consuming
      // first-come queue, like the upsert's own matcher, skipping ids other verdicts already
      // claim, so duplicate contents can never stack two rows on one step.
      const claimed = new Set<string>();
      for (const v of verdicts) if (v.stepId) claimed.add(v.stepId);
      const queueByContent = new Map<string, PlanStepRow[]>();
      for (const s of db.getPlanSteps(plan.id)) {
        const key = (s.content ?? "").trim();
        const queue = queueByContent.get(key);
        if (queue) queue.push(s);
        else queueByContent.set(key, [s]);
      }
      const resolveStepId = (v: GateVerdict): string | null => {
        if (v.stepId) return v.stepId;
        const queue = queueByContent.get(v.content.trim());
        while (queue && queue.length > 0) {
          const s = queue.shift();
          if (s && !claimed.has(s.id)) {
            claimed.add(s.id);
            return s.id;
          }
        }
        return null;
      };
      for (const v of verdicts) {
        try {
          db.insertGate({
            planId: plan.id,
            stepId: resolveStepId(v),
            kind: "step_check",
            outcome: v.outcome,
            confidence: null,
            verifiedBy: v.outcome === "verified" ? "deterministic" : null,
            factors: v.factors,
            recId: ref.currentRecId ?? null,
            sessionId: session,
            agentId: ref.agentId ?? null,
          });
        } catch {
          // per-verdict fail-open: one broken gate write must not starve its siblings.
        }
      }
      // 99B plan closure — strictly AFTER the verdict loop: the sink and the verdict
      // attribution above both re-read the active plan; closing earlier would null those
      // reads and silently drop the final turn's verified verdicts.
      try {
        const steps = db.getPlanSteps(plan.id);
        if (steps.length > 0 && steps.every((s) => s.status === "completed")) {
          db.setPlanStatus(plan.id, "done");
        }
      } catch {
        // fail-open: closure bookkeeping must never break the turn.
      }
    } catch {
      // fail-open: gate bookkeeping must never break the turn.
    } finally {
      pending.delete(ctx.toolCall.id);
      inFlight.delete(ctx.toolCall.id);
    }
    return out;
  };

  return { before, after };
}

export type { FileChangeRow };
