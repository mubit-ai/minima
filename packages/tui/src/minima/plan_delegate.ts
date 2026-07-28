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

import type { PlanStepRow } from "../db/minima_db.ts";
import type { ChildResult, Delegation } from "../tools/task.ts";
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
