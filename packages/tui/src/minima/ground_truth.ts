/**
 * Ground-Truth ledger — pure projection/attribution helpers + the afterToolCall sink that
 * keeps the SQLite plan of record in step with what the agent actually did. Everything here
 * is gated by MINIMA_TUI_GROUND_TRUTH at the wiring sites (main.ts / runtime.ts); this module
 * itself is inert until a caller invokes it.
 *
 * Fail-open is a hard rule: a broken ledger write must never break a turn. The afterToolCall
 * factory swallows its own errors, and the pure helpers are total (never throw on bad input).
 */
import type { AfterToolCall } from "../agent/tools.ts";
import type { FileChangeRow, MinimaDb, PlanRow, PlanStepRow, TodoInput } from "../db/minima_db.ts";

/** Minimal structural view of MinimaAgent — avoids a runtime import cycle. */
export interface GtAgentRef {
  db: MinimaDb | null;
  runId: string | null;
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
 * M1.1: parse the todowrite tool's `tasks` argument (a JSON string of {content,status,...})
 * into ledger todos. `verify` is intentionally never sourced here — it is attached later by
 * the red→green machinery (M3.1) and preserved across todowrite calls via COALESCE.
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
    out.push({ content, status: normalizeStatus(rec.status) });
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
 * M1.2: project a persisted plan into a compact, numbered system-prompt block with the active
 * step marked, so the model always sees the plan of record. Returns null for an empty plan.
 */
export function formatPlanProjection(plan: PlanRow, steps: PlanStepRow[]): string | null {
  if (steps.length === 0) return null;
  const pos = activeStepPos(steps);
  const lines = steps.map((s, i) => {
    const mark = s.status === "completed" ? "x" : s.status === "in_progress" ? ">" : " ";
    return `${i + 1}. [${mark}] ${s.content ?? ""}`;
  });
  const header = `# Current plan (step ${pos}/${steps.length}${plan.title ? ` — ${plan.title}` : ""})`;
  return `${header}\n${lines.join("\n")}\n\nStay on this plan. As you work, keep it current with todowrite (mark steps in_progress/completed); do not silently drift onto unrelated files.`;
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
// afterToolCall sink — persist the plan + attribute file changes.
// ---------------------------------------------------------------------------

/**
 * M1.1 + M2.1/M2.2: after each successful tool call, keep the ledger in step:
 *  - `todowrite`  → upsert the plan + steps for this run.
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
        if (todos.length > 0) db.upsertPlanFromTodos(session, todos);
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

export type { FileChangeRow };
