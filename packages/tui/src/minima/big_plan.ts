/**
 * Big Plan ledger — pure projection/attribution helpers + the afterToolCall sink that
 * keeps the SQLite plan of record in step with what the agent actually did. Everything here
 * is gated by MINIMA_TUI_BIG_PLAN at the wiring sites (main.ts / runtime.ts); this module
 * itself is inert until a caller invokes it.
 *
 * M3.3: the todowrite branch of the sink also captures a pre-work baseline — when a step
 * with a `verify` command first enters in_progress (or first gains a verify while already
 * in_progress), its check is run once and the result (red|green|unrunnable) is recorded on
 * the step, so post-work gates can tell "I fixed it" from "it was already green".
 *
 * M4.1–M4.3: bigPlanHooks adds the done-gate — a beforeToolCall that refuses any
 * todowrite completing a step whose `verify` does not pass (enforcement in the dispatcher,
 * not the prompt), and gate rows recording every verification verdict, including the blocked
 * attempts (Stage 7's attempts signal). It also enforces ONE todowrite per assistant message:
 * all before-hooks in a batch run before any tool executes, so a second todowrite would be
 * previewed against stale (pre-batch) plan state — a gate bypass. Checks are cancellable by
 * the run's AbortSignal (BigPlanAgentRef.runSignal); an aborted check is never evidence.
 *
 * Fail-open is a hard rule for BOOKKEEPING: a broken ledger write must never break a turn.
 * The afterToolCall factory swallows its own errors, and the pure helpers are total (never
 * throw on bad input). The done-gate is the one deliberate exception — it is ENFORCEMENT, so
 * a check that runs and fails (or cannot run) fails CLOSED; only gate infrastructure breaking
 * (db gone, preview threw) falls back to allow.
 */
import type { AfterToolCall, BeforeToolCall } from "../agent/tools.ts";
import { AssistantMessage } from "../ai/index.ts";
import type {
  CompletionFlip,
  FileChangeRow,
  GateRow,
  MinimaDb,
  PlanRow,
  PlanStepRow,
  TodoInput,
} from "../db/minima_db.ts";
import type { ConfidenceTier, Factors, GateOutcome, VerifiedBy } from "./big_plan_contract.ts";
import {
  type FactorFs,
  classifyCheckOrigin,
  computeCoverageHit,
  defaultFactorFs,
  detectTamper,
} from "./big_plan_factors.ts";
import { baselineFromResult, resolveCheckTimeoutMs, runCheck, wasAborted } from "./check.ts";
import { parseStepTools, stepAllowlistDecision } from "./tool_permissions.ts";
import { gateVerdictFor } from "./why.ts";

/**
 * Minimal structural view of MinimaAgent — avoids a runtime import cycle. `runSignal` (the
 * in-flight run's AbortSignal, null when idle) makes every check the ledger spawns
 * cancellable by the same abort() that stops the run; optional so tests can pass a bare
 * {db, runId} pair.
 */
export interface BigPlanAgentRef {
  db: MinimaDb | null;
  runId: string | null;
  readonly runSignal?: AbortSignal | null;
  /** The routed rung currently executing (set around super.prompt) — stamps gate identity. */
  readonly currentRecId?: string | null;
  readonly agentId?: string | null;
}

/** MP18: may this verify command execute on the host RIGHT NOW? Keyed on the exact string
 *  that would run (the execution-time command, never the approved-at-todowrite one — a
 *  post-approval swap must re-consent). Undefined = allow (the pre-MP18 library default);
 *  fail-closed is a WIRING decision — the TUI injects its permission-state-backed checker,
 *  headless injects headlessVerifyConsent. */
export type VerifyConsent = (cmd: string) => boolean;

export const VERIFY_CONSENT_BLOCK =
  "could not run (this verify command was never approved by the user — approve it in an " +
  "interactive session, or set MINIMA_TUI_ALLOW_VERIFY=1 to opt headless runs in)";

export function headlessVerifyConsent(env: NodeJS.ProcessEnv = process.env): VerifyConsent {
  return () => env.MINIMA_TUI_ALLOW_VERIFY === "1";
}

/** Compact footer facts about the active plan (M1.3 strip + M2.3 drift; D3a since MP6). */
export interface PlanStripInfo {
  planId: string;
  /** 1-based position of the active step. */
  stepPos: number;
  stepTotal: number;
  /** The active step's text (falls back to the plan title). */
  title: string;
  /** Count of off-plan (drift) file changes recorded against the plan. */
  drift: number;
  /** Plan-scoped realized cost (Σ per-step $ stamps); null when nothing is stamped yet. */
  totalCostUsd: number | null;
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
    // A6: a per-step tool allowlist. Like verify, the key is OMITTED (never null/[]) when
    // absent/empty so the sticky COALESCE in upsertPlanFromTodos preserves an existing allowlist —
    // the agent can set or overwrite a step's tools but never clear them.
    const tools = normalizeToolList(rec.tools);
    const todo: TodoInput = { content, status };
    if (verify) todo.verify = verify;
    if (tools) todo.tools = tools;
    out.push(todo);
  }
  return out;
}

/** Parse a todowrite `tools` value into a trimmed non-empty string[], or undefined when absent/empty. */
function normalizeToolList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean = raw.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  return clean.length > 0 ? clean : undefined;
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

export interface BashWriteHints {
  paths: { path: string; kind: "created" | "modified" | "deleted" }[];
  /** The command mutates state in a way we cannot attribute to paths — signal lost. */
  opaque: boolean;
}

/** Mutation forms whose targets cannot be extracted statically — they force `opaque`. */
const OPAQUE_BASH =
  /\bgit\s+(apply|checkout|reset|stash|merge|rebase|cherry-pick|clean|restore)\b|(^|[\s;|&])patch\b|\b(node|bun)\s+(-e|--eval)\b|\bpython3?\s+-c\b|<<|\|\s*(sh|bash|zsh)\b/;

/**
 * GT101-F5: best-effort write attribution for LLM-authored bash. Extracts the targets of the
 * common explicit-write forms (redirects, tee, sed -i, mv/cp/rm/touch/mkdir); any mutation it
 * cannot resolve to a concrete path (globs, variables, the OPAQUE_BASH forms) sets `opaque`
 * instead — under-extraction degrades to a yellow cap via Factors.blind, never a false green.
 * Pure reads return nothing. Total: never throws.
 */
export function bashWriteHints(command: string): BashWriteHints {
  const paths: BashWriteHints["paths"] = [];
  const seen = new Set<string>();
  let opaque = OPAQUE_BASH.test(command);
  const push = (raw: string, kind: "created" | "modified" | "deleted"): boolean => {
    const p = raw.replace(/^['"`]+|['"`]+$/g, "").trim();
    if (!p || p.startsWith("-") || p.startsWith("/dev/")) return true; // nothing to attribute
    if (/[$*?{}[\]<>]/.test(p)) return false; // vars/globs — cannot resolve statically
    const key = `${kind}:${p}`;
    if (!seen.has(key)) {
      seen.add(key);
      paths.push({ path: p, kind });
    }
    return true;
  };
  for (const m of command.matchAll(/(?:^|[^>|\d])>{1,2}\s*([^\s;|&)]+)/g)) {
    if (m[1]!.startsWith("&")) continue;
    if (!push(m[1]!, "modified")) opaque = true;
  }
  for (const m of command.matchAll(/\btee\s+(?:-a\s+)?([^\s;|&)]+)/g)) {
    if (!push(m[1]!, "modified")) opaque = true;
  }
  for (const segment of command.split(/&&|\|\||[;|]/)) {
    const toks = segment.trim().split(/\s+/).filter(Boolean);
    const head = toks[0] ?? "";
    const args = toks.slice(1).filter((t) => !t.startsWith("-"));
    switch (head) {
      case "mv":
      case "cp": {
        const dest = args[args.length - 1];
        if (dest === undefined || !push(dest, "modified")) opaque = true;
        break;
      }
      case "rm":
        if (args.length === 0) opaque = true;
        for (const t of args) if (!push(t, "deleted")) opaque = true;
        break;
      case "touch":
        for (const t of args) if (!push(t, "created")) opaque = true;
        break;
      case "mkdir":
        for (const t of args) if (!push(t, "created")) opaque = true;
        break;
      case "sed": {
        if (!/\s(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/.test(segment)) break;
        const last = toks[toks.length - 1] ?? "";
        if (!/[./]/.test(last) || !push(last, "modified")) opaque = true;
        break;
      }
      default:
        break;
    }
  }
  return { paths, opaque };
}

/**
 * SHARED attribution sink body (lead + sub-agents): resolve a tool call's touched paths and
 * record them as file_changes attributed to the in-progress step, `agent_id` marking who
 * wrote (NULL = lead). bash goes through {@link bashWriteHints}; a mutation that cannot be
 * attributed lands as ONE `kind='opaque'` row (origin `unknown`) that the factor filters
 * exclude from provenance/coverage but Factors.blind reads as "evidence incomplete".
 */
export function recordFileChanges(
  db: MinimaDb,
  session: string,
  toolName: string,
  args: Record<string, unknown>,
  agentId: string | null,
): void {
  let entries: { path: string; kind: string }[] = [];
  let opaque = false;
  let opaqueLabel = "";
  if (toolName === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    const hints = bashWriteHints(cmd);
    entries = hints.paths;
    opaque = hints.opaque;
    opaqueLabel = `bash: ${cmd.trim().slice(0, 80)}`;
    if (entries.length === 0 && !opaque) return;
  } else {
    entries = writePathsFromArgs(toolName, args).map((path) => ({
      path,
      kind: kindForTool(toolName),
    }));
    if (entries.length === 0) return;
  }
  const plan = db.getActivePlan(session);
  if (!plan) return;
  const step = db.getInProgressStep(plan.id);
  for (const e of entries) {
    const origin = step && isPathClaimed(step.content, e.path) ? "on_plan" : "off_plan";
    db.insertFileChange({
      planId: plan.id,
      stepId: step?.id ?? null,
      path: e.path,
      kind: e.kind,
      origin,
      agentId,
    });
  }
  if (opaque) {
    db.insertFileChange({
      planId: plan.id,
      stepId: step?.id ?? null,
      path: opaqueLabel,
      kind: "opaque",
      origin: "unknown",
      agentId,
    });
  }
}

/** One opaque marker row (e.g. a worktree sub-agent whose writes are invisible here). */
export function recordOpaqueMarker(
  db: MinimaDb,
  session: string,
  label: string,
  agentId: string | null,
): void {
  const plan = db.getActivePlan(session);
  if (!plan) return;
  db.insertFileChange({
    planId: plan.id,
    stepId: null,
    path: label,
    kind: "opaque",
    origin: "unknown",
    agentId,
  });
}

/**
 * The SUB-AGENT attribution sink: file_changes writes ONLY. It hard-skips todowrite (a child
 * todowrite reaching upsertPlanFromTodos would DELETE the lead's steps via the prune) and
 * never touches gates/baselines/plans — the done-gate stays lead-only by design. Registered
 * by createSpawn under parent.config.bigPlan.
 */
export function bigPlanAttributionSink(ref: BigPlanAgentRef, childId: string): AfterToolCall {
  return async (ctx) => {
    try {
      const db = ref.db;
      const session = ref.runId;
      if (!db || !session || ctx.isError) return null;
      if (ctx.toolCall.name === "todowrite") return null;
      recordFileChanges(db, session, ctx.toolCall.name, ctx.toolCall.arguments ?? {}, childId);
    } catch {
      // fail-open: attribution bookkeeping must never break a child turn.
    }
    return null;
  };
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
 * The always-on Big Plan contract, injected into the system prompt whenever `bigPlan` is
 * on — INDEPENDENT of whether a plan exists yet. This is the fix for the plan-authoring gap: the
 * plan projection ({@link formatPlanProjection}) carries the "attach a verify" nudge but is inert
 * until the first todowrite has already created the plan, so without this block the model authors
 * its whole plan before ever seeing the contract. Kept honest per the build guide §6 — genuinely
 * uncheckable scaffolding steps may omit `verify` (they stay flagged, not verified); the model must
 * not fabricate throwaway checks to dodge the gate.
 */
export const BIG_PLAN_SYSTEM_GUIDANCE = [
  "# Big Plan verification is ON",
  "You plan with the todowrite tool and the harness verifies each step against a real command.",
  "When you FIRST create a step that produces something a command can check — a feature, a fix, a",
  "test — attach a `verify` shell command that proves it (a real test/build command, e.g.",
  "`bun test tests/foo.test.ts`). Do not wait until the step is done to add it.",
  "Marking a step completed runs its `verify` first; the completion is REFUSED unless the check",
  "passes, so a step whose check you cannot yet make pass is simply not done.",
  "If you cannot name a `verify` for a step, that step is too vague — decompose it into smaller",
  "steps each of which CAN be checked, rather than leaving it unverified.",
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
    // State-backed nudge (survives compaction): a not-yet-done step with no check is flagged so
    // the model is reminded, every turn, to add a verify or decompose it. Nudge only — never a
    // block. Completed steps are past the point of nudging.
    const verify = s.verify
      ? ` — verify: \`${s.verify}\``
      : s.status === "completed"
        ? ""
        : " — ⚠ no verify (decompose or add a check)";
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
  const { totalUsd } = db.stepCosts(plan.id);
  return {
    planId: plan.id,
    stepPos: pos,
    stepTotal: steps.length,
    title: active?.content ?? plan.title ?? "",
    drift: db.countOffPlanChanges(plan.id),
    totalCostUsd: totalUsd > 0 ? totalUsd : null,
  };
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
// M7.1/M7.2/M7.3 verified outcome — the run's most recent verified step's verdict.
// ---------------------------------------------------------------------------

/** The verified verdict of the step checked under a prompt (M7.1 stamp, M7.2 feedback, M7.3 ladder). */
export interface VerifiedOutcome {
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
 * Read the verified verdict of the gates minted under ONE routed rung (`recId`) — identity join,
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
export function verifiedOutcomeFor(
  db: MinimaDb | null,
  recId: string | null,
): VerifiedOutcome | null {
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
 * M7.1: stamp the deterministic outcome of the gates minted under `recId` onto the
 * routing decision that picked the model — so Minima learns "the test passed" instead of "the
 * judge guessed 0.7". Called from the runtime feedback seam once a prompt's decision row exists
 * (see runtime.persistDecision). Identity-scoped: only this rung's own gates can stamp it.
 *
 * Total + fail-open: a null db/recId or no verified gate is a silent no-op.
 */
export function stampVerifiedOutcome(db: MinimaDb | null, recId: string | null): void {
  if (!db || !recId) return;
  const verifiedOutcome = verifiedOutcomeFor(db, recId);
  if (!verifiedOutcome) return;
  try {
    db.attachBigPlanOutcome(recId, {
      outcome: verifiedOutcome.outcome,
      verifiedBy: verifiedOutcome.verifiedBy,
      confidence: verifiedOutcome.confidence,
    });
  } catch {
    // fail-open: verified-outcome stamping must never break the feedback path.
  }
}

/**
 * A7: turn a deterministic verified verdict into the feedback outcome label, graded by the gate's
 * confidence tier. The caller (runtime.feedbackSafely) only reaches this with a verified outcome
 * that is `verified` or `failed` (an `unrunnable` is filtered upstream — it is an environment error,
 * not model evidence, and falls back to the judge), so this function's whole job is the verified
 * split:
 *
 *   - `failed`  → `failure`  (a red check; also the recovery-ladder trigger, read separately).
 *   - `verified` + `graded`=false → `success`  (M7.2's original binary: any passing check → success).
 *   - `verified` + `graded`=true:
 *       - tier `green`         → `success`  (verified evidence: pre-existing/user check, red→green,
 *                                            coverage — the only tier that also flips vip=true).
 *       - tier `yellow`/`red`/null → `partial`  (a passing-but-untrustworthy check: a self-written
 *                                            test, no red→green evidence, coverage-unknown, or an A5
 *                                            fabrication-floor red-TIER-but-verified pass). Weaker
 *                                            positive evidence than green, so Minima learns it as
 *                                            partial — never a fabricated `success`, never an
 *                                            overstated `failure` (the check DID pass).
 *
 * Pure. A red-tier verified pass mapping to `partial` (not `failure`) is deliberate: it must not
 * masquerade as recovery-worthy — a stronger model can't fix a fabricated test (A5), so the ladder
 * (which triggers on `outcome==='failed'`) correctly stays out of it.
 */
export function deterministicOutcomeLabel(
  verifiedOutcome: VerifiedOutcome,
  graded: boolean,
): "success" | "partial" | "failure" {
  if (verifiedOutcome.outcome !== "verified") return "failure";
  if (!graded) return "success";
  return verifiedOutcome.confidence === "green" ? "success" : "partial";
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
export function bigPlanAfterToolCall(
  ref: BigPlanAgentRef,
  opts?: { verifyConsent?: VerifyConsent },
): AfterToolCall {
  const consent = opts?.verifyConsent;
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
            // MP18: an unconsented verify never executes — the baseline stays NULL (signal
            // withheld, never fabricated). Consent keys on the stored command about to run.
            if (consent && !consent(s.verify)) continue;
            const remaining = deadline - performance.now();
            if (remaining <= 0) break;
            try {
              const result = await runCheck(s.verify, {
                timeoutMs: Math.min(remaining, resolveCheckTimeoutMs()),
                signal: ref.runSignal ?? undefined,
                cwd: s.verify_cwd ?? undefined,
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

      recordFileChanges(db, session, name, args, null);
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

/** Leads every per-step done-gate failure line (also the renderer's gate-block signature). */
const GATE_STEP_BLOCK_PREFIX = "Step not verified — ";

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

/** Sibling tools whose execution can regress a check after its verdict was computed. */
const MUTATING_SIBLINGS = new Set(["write", "edit", "apply_patch", "bash", "task"]);

const SOLO_COMPLETION_PREFIX =
  "This todowrite marks steps completed, but the same message also calls ";

function soloCompletionReason(names: string[]): string {
  return `${SOLO_COMPLETION_PREFIX}${names.join(", ")}. Completion checks run before ANY tool in the batch executes, so the verdict would be recorded against pre-batch state and a sibling could regress it after it passed. This call was refused before executing (none of its statuses were applied) — make your edits first, then mark the step completed in its own later message.`;
}

/**
 * True when a beforeToolCall block reason came from the todowrite done-gate family (step
 * verification, same-batch refusal, solo-completion refusal) rather than a permission
 * denial. Display-only: the TUI renders gate blocks under a distinct "⊘ verify gate"
 * header so an approved-then-gate-blocked todowrite doesn't read as a cancelled call.
 */
export function isGateBlockReason(reason: string): boolean {
  return (
    reason.startsWith(GATE_STEP_BLOCK_PREFIX) ||
    reason.startsWith("Only one todowrite per assistant message:") ||
    reason.startsWith(SOLO_COMPLETION_PREFIX)
  );
}

/**
 * M4.3 milestone gate — one plan-level rollup written exactly once, when the plan closes (every
 * step completed). It aggregates the TERMINAL verdict per step (the latest gate row per step_id,
 * since getGates is oldest-first): outcome is `verified` only when every step's terminal gate is
 * verified, else `unchecked`; confidence is the WORST tier across steps (red wins); verified_by is
 * `deterministic` only when every terminal step gate was deterministic. Because closure can only
 * fire once all steps completed — and completion already refuses any failed/unrunnable check — the
 * rollup is derived purely from real step verdicts (no fabricated quality). Rec-scoped like step
 * gates so verifiedOutcomeFor can factor it; conservative by construction, so it can never make a
 * run look more verified than its steps already are. Fail-open: any error skips the milestone.
 */
function writeMilestoneGate(
  db: MinimaDb,
  planId: string,
  ref: BigPlanAgentRef,
  session: string,
): void {
  const stepGates = db.getGates(planId).filter((g) => g.kind === "step_check");
  const latestByStep = new Map<string, GateRow>();
  for (const g of stepGates) if (g.step_id) latestByStep.set(g.step_id, g); // oldest-first → last wins
  const finals = [...latestByStep.values()];
  if (finals.length === 0) return; // nothing verified to roll up (all steps were verify-less)

  let worst: ConfidenceTier = "green";
  let allVerified = true;
  let allDeterministic = true;
  for (const g of finals) {
    const tier = gateVerdictFor(g).tier ?? "yellow";
    if (TIER_BADNESS[tier] > TIER_BADNESS[worst]) worst = tier;
    if (g.outcome !== "verified") allVerified = false;
    if (g.verified_by !== "deterministic") allDeterministic = false;
  }
  db.insertGate({
    planId,
    stepId: null,
    kind: "milestone",
    outcome: allVerified ? "verified" : "unchecked",
    confidence: worst,
    verifiedBy: allVerified && allDeterministic ? "deterministic" : null,
    factors: {
      milestone: true,
      steps: finals.length,
      verified: finals.filter((g) => g.outcome === "verified").length,
    },
    recId: ref.currentRecId ?? null,
    sessionId: session,
    agentId: ref.agentId ?? null,
  });
}

/**
 * The tool calls of the CURRENT batch: during before-hooks, loop.ts has already appended the
 * assistant message whose toolUse blocks are being dispatched, so the last AssistantMessage
 * with stop_reason "toolUse" IS the batch. Stateless — nothing to leak or wedge when a batch
 * unwinds via an error or abort. Total: any unexpected shape returns [] (rules disabled,
 * fail-open for bare test refs).
 */
export function batchToolCalls(state: unknown): { id: string; name: string }[] {
  const messages = (state as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AssistantMessage) {
      if (m.stop_reason !== "toolUse") return [];
      const out: { id: string; name: string }[] = [];
      for (const b of m.content) {
        if (b.type === "toolCall") out.push({ id: b.id, name: b.name });
      }
      return out;
    }
  }
  return [];
}

/**
 * M4.1–M4.3: the Big Plan hook pair. `after` is the existing ledger sink
 * (bigPlanAfterToolCall: plan upsert, baseline capture, file_change attribution) plus the
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
/**
 * A6 enforcement: does the in-progress step's tool allowlist permit this tool call? Reads the
 * active plan's in-progress step (the same step file changes attribute to), parses its `tools`
 * column, and returns a block decision for a mutating tool absent from a non-empty allowlist; null
 * (allow) when there is no plan/step, the step is unrestricted, or the tool is always-allowed.
 *
 * Total + FAIL-OPEN: any ledger error allows the call — a broken read must never wedge a turn (the
 * allowlist is a guardrail, not a security boundary; the done-gate remains the hard invariant).
 */
function enforceStepAllowlist(
  db: MinimaDb,
  session: string,
  toolName: string,
): { block: true; reason: string } | null {
  try {
    const plan = db.getActivePlan(session);
    if (!plan) return null;
    const step = db.getInProgressStep(plan.id);
    if (!step) return null;
    const allow = parseStepTools(step.tools);
    const decision = stepAllowlistDecision(toolName, allow, step.content);
    return decision.block ? { block: true, reason: decision.reason ?? "tool not permitted" } : null;
  } catch {
    return null; // fail-open: a broken allowlist read must never break a turn.
  }
}

export function bigPlanHooks(
  ref: BigPlanAgentRef,
  opts?: {
    gateBudgetMs?: number;
    fs?: FactorFs;
    enforceAllowlist?: boolean;
    verifyConsent?: VerifyConsent;
    /** E1: fired (post-commit, fail-open) when a plan closes with every step completed —
     * the diff-review trigger. Must not throw and must not block (fire-and-forget). */
    onPlanClosed?: (planId: string) => void;
  },
): { before: BeforeToolCall; after: AfterToolCall } {
  const budgetMs = opts?.gateBudgetMs ?? GATE_BUDGET_MS;
  const fs = opts?.fs ?? defaultFactorFs;
  const enforceAllowlist = opts?.enforceAllowlist ?? false;
  const consent = opts?.verifyConsent;
  const sink = bigPlanAfterToolCall(ref, { verifyConsent: consent });
  const pending = new Map<string, GateVerdict[]>();

  const before: BeforeToolCall = async (ctx) => {
    try {
      const db = ref.db;
      const session = ref.runId;
      if (!db || !session) return null;
      // A6: per-step tool allowlist (task permissions). Any NON-todowrite call is checked against
      // the in-progress step's allowlist; a mutating tool absent from a non-empty list is blocked
      // at the dispatcher. todowrite itself is never blocked here (it is how the agent updates the
      // plan / widens the allowlist / marks a step done) — it falls through to the done-gate below.
      if (ctx.toolCall.name !== "todowrite") {
        if (!enforceAllowlist) return null;
        return enforceStepAllowlist(db, session, ctx.toolCall.name);
      }
      // Stateless batch rules over the CURRENT assistant message (nothing survives across
      // batches, so an abandoned batch can never wedge the gate): (a) only the batch's FIRST
      // todowrite may run — a second would be previewed against pre-batch DB state; (b) a
      // parked verdict from a prior batch whose after-hook never fired is pruned here.
      const batch = batchToolCalls(ctx.context);
      if (batch.length > 0) {
        const liveIds = new Set(batch.map((b) => b.id));
        for (const id of pending.keys()) if (!liveIds.has(id)) pending.delete(id);
        const firstTodowrite = batch.find((b) => b.name === "todowrite");
        if (firstTodowrite && firstTodowrite.id !== ctx.toolCall.id) {
          return { block: true, reason: SAME_BATCH_BLOCK };
        }
      }
      const todos = parseTodos(ctx.args.tasks);
      if (todos.length === 0) return null;
      const flips = db.completionsForTodos(session, todos);
      if (flips.length === 0) return null;
      // Solo-completion: a completion-flipping todowrite must be the only state-changing call
      // in its message — a mutating sibling executes AFTER this verdict is computed and could
      // regress the very state the check just verified.
      const mutating = batch.filter(
        (b) => b.id !== ctx.toolCall.id && MUTATING_SIBLINGS.has(b.name),
      );
      if (mutating.length > 0) {
        return { block: true, reason: soloCompletionReason(mutating.map((b) => b.name)) };
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
      // Factors.blind — evidence completeness, RUN-scoped: any opaque row on the plan OR any
      // opaque bash anywhere in this run's tool_calls (which covers pre-plan mutations that
      // file_changes cannot hold — its plan_id is NOT NULL). Fail-open to false.
      let blind = false;
      try {
        blind =
          fileChanges.some((c) => c.kind === "opaque") ||
          db.getRunToolCommands(session, "bash").some((cmd) => bashWriteHints(cmd).opaque);
      } catch {
        // no ledger read — the factor degrades to its neutral default.
      }

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
            factors: { ...uncheckedFactors(), tamper, blind, flipContent: flip.content },
          });
          continue;
        }
        // MP18: fail CLOSED on an unconsented verify — a completion claim without runnable
        // evidence blocks (mirroring the unrunnable semantics), and the durable attempt row
        // records why. Keyed on flip.verify, the EFFECTIVE execution-time command (a swap
        // after approval re-prompts; the mutation-dodge is structurally closed).
        if (consent && !consent(flip.verify)) {
          failures.push({
            flip,
            outcome: "unrunnable",
            why: VERIFY_CONSENT_BLOCK,
            factors: {
              ...uncheckedFactors(),
              hasCheck: true,
              tamper,
              blind,
              flipContent: flip.content,
            },
          });
          continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          failures.push({
            flip,
            outcome: "unrunnable",
            why: `could not run (the ${budgetMs} ms gate budget was exhausted by earlier checks)`,
            factors: {
              ...uncheckedFactors(),
              hasCheck: true,
              tamper,
              blind,
              flipContent: flip.content,
            },
          });
          continue;
        }
        const capMs = Math.min(remaining, resolveCheckTimeoutMs());
        const result = await runCheck(flip.verify, {
          timeoutMs: capMs,
          signal: ref.runSignal ?? undefined,
          cwd: flip.verify_cwd ?? undefined,
        });
        const factors: GateFactors = {
          pass: result.pass,
          redToGreen: flip.baseline === "red" && result.pass,
          hasCheck: true,
          // M5.1 provenance / M5.2 coverage / M5.3 tamper — computed from this run's file_changes.
          // A stored check_origin (e.g. 'user' on a step seeded from an approved plan) is
          // authoritative and overrides the gate-time classification — a user-accepted check is
          // not agent-graded homework.
          checkOrigin: flip.check_origin ?? classifyCheckOrigin(flip.verify, fileChanges),
          coverageHit: computeCoverageHit(flip.verify, fileChanges, fs),
          tamper,
          blind,
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
          (f) =>
            `${GATE_STEP_BLOCK_PREFIX}"${f.flip.content}": check \`${f.flip.verify}\` ${f.why}`,
        );
        return { block: true, reason: `${lines.join("\n\n")}\n\n${GATE_BLOCK_CODA}` };
      }

      if (verdicts.length > 0) pending.set(ctx.toolCall.id, verdicts);
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
          writeMilestoneGate(db, plan.id, ref, session);
          db.setPlanStatus(plan.id, "done");
          // MUB-181: close stale sibling actives with the plan of record, or the stop-gate's
          // getActivePlan read would resurrect one the user cannot see in /why.
          db.supersedeOtherActivePlans(session, plan.id);
          try {
            opts?.onPlanClosed?.(plan.id);
          } catch {
            // the closure callback is advisory — never let it break the turn
          }
        }
      } catch {
        // fail-open: closure bookkeeping must never break the turn.
      }
    } catch {
      // fail-open: gate bookkeeping must never break the turn.
    } finally {
      pending.delete(ctx.toolCall.id);
    }
    return out;
  };

  return { before, after };
}

export type { FileChangeRow };

/** @deprecated Use `BigPlanAgentRef`. */
export type GtAgentRef = BigPlanAgentRef;
/** @deprecated Use `VerifiedOutcome`. */
export type GroundedOutcome = VerifiedOutcome;
/** @deprecated Use `verifiedOutcomeFor`. */
export const groundedOutcomeFor = verifiedOutcomeFor;
/** @deprecated Use `stampVerifiedOutcome`. */
export const stampGroundedOutcome = stampVerifiedOutcome;
