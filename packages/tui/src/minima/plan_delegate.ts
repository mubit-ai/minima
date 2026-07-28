/**
 * Plan-delegated steps — project a plan step into a Delegation and run it as a sub-agent.
 *
 * A plan step and a Delegation already describe almost the same thing: what to do, with which
 * tools, routed among which models, under what spend cap. This module owns the two pieces the
 * plan format does not carry — `output_format` and `boundaries` — plus the budget slice, and
 * nothing else. It deliberately does NOT import the spawner: the seam takes a SpawnFn, so the
 * projection is testable without spawning anything and big_plan.ts never depends on spawn.ts.
 *
 * Sequential by construction. `file_changes` attribute to THE in-progress step and the schema
 * permits exactly one, so concurrent steps would force worktree isolation → an opaque marker →
 * Factors.blind → the plan's confidence tier capped at yellow, surrendering the only origin
 * allowed to claim verified_in_production. Wall-clock is not worth that.
 */

import type { MinimaDb, PlanStepRow } from "../db/minima_db.ts";
import type { ChildResult, Delegation, SpawnFn } from "../tools/task.ts";
import type { AgentTypeRegistry } from "./agent_types.ts";

/**
 * Character ceiling on the prior-results projection. Uncapped, a child's prompt would grow
 * linearly with plan length and give back the context hygiene this feature exists for;
 * previous-step-only would starve a step building on something three steps back.
 */
export const PRIOR_RESULTS_CAP_CHARS = 4000;

/** Completed steps' stored results, most recent first, truncated at the cap boundary. */
export function priorResultsFor(
  steps: PlanStepRow[],
  capChars: number = PRIOR_RESULTS_CAP_CHARS,
): ChildResult[] {
  const out: ChildResult[] = [];
  let used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.status !== "completed" || !s.result) continue;
    const room = capChars - used;
    if (room <= 0) break;
    const text = s.result.length <= room ? s.result : `${s.result.slice(0, room)}…`;
    used += text.length;
    out.push({
      step_id: s.id,
      childId: "",
      text,
      costUsd: 0,
      quality: null,
      outcome: "success",
      workdir: null,
    });
  }
  return out;
}

/** What this child must NOT do: the other steps' work. */
export function synthesizeBoundaries(steps: PlanStepRow[], stepId: string): string {
  const others = steps
    .filter((s) => s.id !== stepId && (s.content ?? "").trim())
    .map((s) => `- ${s.content!.trim()}`);
  const head =
    "Do ONLY this step. Do not start, finish, or refactor toward any other step of the plan, " +
    "and change no file this step does not require.";
  return others.length ? `${head}\nThese belong to other steps:\n${others.join("\n")}` : head;
}

function jsonList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the child's contract. `depends_on` is set to the prior steps because that is how
 * delegationPrompt addresses ctx.priorResults — it renders results only for ids listed there.
 * The plan stays linear; this is prompt plumbing, not a dependency graph.
 */
export function buildStepDelegation(
  steps: PlanStepRow[],
  step: PlanStepRow,
  budgetUsd: number,
  agentTypes?: AgentTypeRegistry,
): Delegation {
  const priors = priorResultsFor(steps);
  const verify = (step.verify ?? "").trim();
  const d: Delegation = {
    step_id: step.id,
    objective: (step.content ?? "").trim(),
    output_format: verify
      ? `A short report of what you changed, plus the output of running \`${verify}\`.`
      : "A short report of what you changed and how you confirmed it works.",
    boundaries: synthesizeBoundaries(steps, step.id),
    depends_on: priors.map((p) => p.step_id),
    // Same defensive shape as the budget_usd clamp below: applyAgentType fills isolation
    // ONLY when the delegation left it unset, so a type declaring isolation:"workdir" would
    // otherwise force a worktree child — the opaque marker this module's header says must
    // never happen. Setting it here, always, closes that off regardless of agent_type.
    isolation: "inherit",
  };
  const tools = jsonList(step.tools);
  if (tools) d.tool_allowlist = tools;
  const candidates = jsonList(step.candidates);
  if (candidates) d.candidates = candidates;
  const typeName = step.agent_type?.trim().toLowerCase();
  if (typeName) d.agent_type = typeName;
  // The slice is the plan's ceiling, and a type's own cap only ever LOWERS it. applyAgentType
  // fills budget_usd solely when the delegation left it unset, and this one never does — so
  // without taking the min here a $2 slice would silently widen a type that declared $0.25.
  const typeCap = typeName ? agentTypes?.types.get(typeName)?.budget_usd : undefined;
  d.budget_usd = typeCap !== undefined ? Math.min(budgetUsd, typeCap) : budgetUsd;
  return d;
}

/** Below this a child cannot finish anything useful, so the plan stops instead of
 *  spawning an agent that will immediately hit its cap and report partial. */
export const MIN_VIABLE_SLICE_USD = 0.02;

export type DelegateSkip =
  | "flag_off"
  | "already_delegated"
  | "no_budget"
  | "plan_exhausted"
  | "slice_too_thin"
  | "no_content";

/** What is LEFT, divided among the steps that REMAIN — recomputed before every spawn, so a
 *  cheap early step leaves more for later ones and a static split cannot strand the last. */
export function sliceForStep(
  planTotalUsd: number,
  spentUsd: number,
  stepsRemaining: number,
): number {
  if (stepsRemaining <= 0) return 0;
  return Math.max(0, (planTotalUsd - spentUsd) / stepsRemaining);
}

/**
 * A thin slice is NOT an exhausted plan: "plan_exhausted" means the money itself is gone
 * (the remaining total can't fund even one more step), while "slice_too_thin" means the
 * money is still there but there are too many steps left to divide it usefully — the two
 * need different messages, since only one of them is honestly described as "spent".
 */
export function shouldDelegate(
  step: PlanStepRow,
  planBudgetUsd: number | null,
  spentUsd: number,
  stepsRemaining: number,
): { ok: true; sliceUsd: number } | { ok: false; reason: DelegateSkip } {
  if (step.delegated_cost_usd !== null) return { ok: false, reason: "already_delegated" };
  if (!(step.content ?? "").trim()) return { ok: false, reason: "no_content" };
  if (planBudgetUsd === null || planBudgetUsd <= 0) return { ok: false, reason: "no_budget" };
  const remainingUsd = planBudgetUsd - spentUsd;
  if (remainingUsd < MIN_VIABLE_SLICE_USD) return { ok: false, reason: "plan_exhausted" };
  const sliceUsd = sliceForStep(planBudgetUsd, spentUsd, stepsRemaining);
  if (sliceUsd < MIN_VIABLE_SLICE_USD) return { ok: false, reason: "slice_too_thin" };
  return { ok: true, sliceUsd };
}

/** Run the step if it qualifies; return the report the lead should see, or null when
 *  nothing was delegated (the lead then works the step itself, as it always has). */
export type PlanDelegate = (planId: string, stepId: string) => Promise<string | null>;

export interface PlanDelegateDeps {
  db: MinimaDb;
  spawn: SpawnFn;
  /** The run's live AbortSignal. A plain value would be a snapshot of whatever was in
   *  flight when the delegate was BUILT — since the delegate is constructed once per
   *  session but runSignal changes every turn, that would leave every child unabortable
   *  after the first turn. Pass a thunk (`() => agent.runSignal ?? null`) so it is read
   *  fresh at spawn time; a plain value/null is still accepted for tests. */
  signal?: AbortSignal | null | (() => AbortSignal | null);
  /** Book realized child spend against the wallet — the same seam taskTool uses, so plan
   *  spend is visible to enforce mode exactly like fan-out spend. */
  onSpend?: (usd: number) => void;
  /** Needed here (not just in createSpawn) so a type's lower budget cap can clamp the slice
   *  BEFORE the delegation is built — applyAgentType only fills a field left unset. */
  agentTypes?: AgentTypeRegistry;
}

export function makePlanDelegate(deps: PlanDelegateDeps): PlanDelegate {
  return async (planId, stepId) => {
    const steps = deps.db.getPlanSteps(planId);
    const step = steps.find((s) => s.id === stepId);
    if (!step) return null;
    const remaining = steps.filter((s) => s.status !== "completed").length;
    const spent = deps.db.planDelegatedSpend(planId);
    const budget = deps.db.getPlanBudget(planId);
    const verdict = shouldDelegate(step, budget, spent, remaining);
    if (!verdict.ok) {
      if (verdict.reason === "plan_exhausted") {
        return `Plan budget exhausted: $${spent.toFixed(2)} of the approved $${(budget ?? 0).toFixed(2)} is spent, so this step was not delegated. Stop and tell the user — do not continue the plan until they raise the budget or ask you to finish it yourself.`;
      }
      if (verdict.reason === "slice_too_thin") {
        const perStepUsd = sliceForStep(budget ?? 0, spent, remaining);
        return `Plan budget too thin: $${((budget ?? 0) - spent).toFixed(2)} left, split across ${remaining} remaining step${remaining === 1 ? "" : "s"}, is only $${perStepUsd.toFixed(2)} each — too small for a sub-agent to do anything useful with. This step was not delegated. Stop and ask the user to raise the plan budget before continuing.`;
      }
      return null;
    }

    const delegation = buildStepDelegation(steps, step, verdict.sliceUsd, deps.agentTypes);
    const priorResults = priorResultsFor(steps);
    const signal = typeof deps.signal === "function" ? deps.signal() : (deps.signal ?? null);
    let result: ChildResult;
    try {
      result = await deps.spawn(delegation, {
        depth: 1,
        parentSignal: signal,
        priorResults,
      });
    } catch (exc) {
      // The cost stamp is the one-attempt marker, so it must land even here — otherwise a
      // provider outage lets the same step re-spawn on the lead's next todowrite.
      deps.db.recordStepDelegation(stepId, `delegation failed: ${String(exc)}`, 0);
      return `Step delegation failed: ${String(exc)}\n\nFinish this step yourself with your own tools, then mark it completed.`;
    }

    deps.db.recordStepDelegation(stepId, result.text, result.costUsd);
    if (result.costUsd > 0) deps.onSpend?.(result.costUsd);

    const head = `Step delegated to a sub-agent (${result.outcome}, $${result.costUsd.toFixed(4)}).`;
    if (result.outcome === "success") {
      return `${head}\n\n${result.text || "(no output)"}\n\nVerify it, then mark the step completed.`;
    }
    return `${head}\n\n${result.text || "(no output)"}\n\nThat did not complete the step. Finish this step yourself with your own tools — it will not be delegated again.`;
  };
}
