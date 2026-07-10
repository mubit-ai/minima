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
  return `${header}\n${lines.join("\n")}\n\nStay on this plan. As you work, keep it current with todowrite (mark steps in_progress/completed); do not silently drift onto unrelated files. Attach a \`verify\` command to each step where a runnable check exists. Marking a step completed runs its \`verify\` first; the completion is refused unless the check passes.`;
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

/** M1.3: the footer plan-of-record line, e.g. `▸ plan 2/5 — Wire the router`. */
export function planStripLabel(info: PlanStripInfo): string {
  return `▸ plan ${info.stepPos}/${info.stepTotal} — ${info.title}`;
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
  confidence: ConfidenceTier | null; // green | yellow | red (null when factors couldn't tier)
}

/**
 * Read the grounded verdict of the run's most recent verified step: the last gate on the active plan.
 * The single seam three milestones share — M7.1 stamps it onto `routing_decisions.gt_*`, M7.2 prefers
 * it over the LLM judge in feedback, M7.3 escalates on a failed one.
 *
 * Join rule: one `recId` per routed prompt ⇒ the *most recent* gate is the step just verified under
 * this decision. As Track A lands a gate per prompt this is a clean 1:1; today it is last-write-wins.
 *
 * Total + fail-open: null db/session, no active plan, no gate, or a gate missing outcome/verifier
 * returns `null` (never throws into the feedback path).
 */
export function groundedOutcomeFor(
  db: MinimaDb | null,
  sessionId: string | null,
): GroundedOutcome | null {
  if (!db || !sessionId) return null;
  try {
    const plan = db.getActivePlan(sessionId);
    if (!plan) return null;
    const gates = db.getGates(plan.id); // oldest-first; the last is the most recent verdict
    const gate: GateRow | undefined = gates[gates.length - 1];
    if (!gate || !gate.outcome || !gate.verified_by) return null;
    return {
      gateId: gate.id,
      outcome: gate.outcome,
      verifiedBy: gate.verified_by,
      confidence: gate.confidence,
    };
  } catch {
    return null; // fail-open: a broken ledger read must never break the turn.
  }
}

/**
 * M7.1: stamp the grounded (deterministic) outcome of the run's most recent verified step onto
 * the routing decision `recId` that picked the model — so Minima learns "the test passed" instead
 * of "the judge guessed 0.7". Called from the runtime feedback seam once a prompt's decision row
 * exists (see runtime.persistDecision), where `recId` and the active plan are both in hand.
 *
 * Total + fail-open: a null db/session/recId or no grounded gate is a silent no-op. A gate whose
 * factors couldn't produce a confidence tier still stamps outcome + verifier, `gt_confidence` null.
 */
export function stampGroundedOutcome(
  db: MinimaDb | null,
  sessionId: string | null,
  recId: string | null,
): void {
  if (!db || !recId) return;
  const grounded = groundedOutcomeFor(db, sessionId);
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
type GateFactors = Factors & { outputTail?: string; durationMs?: number; exitCode?: number | null };

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
            factors: { ...uncheckedFactors(), tamper },
          });
          continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          failures.push({
            flip,
            outcome: "unrunnable",
            why: `could not run (the ${budgetMs} ms gate budget was exhausted by earlier checks)`,
            factors: { ...uncheckedFactors(), hasCheck: true, tamper },
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
          });
        } catch {
          // per-verdict fail-open: one broken gate write must not starve its siblings.
        }
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
