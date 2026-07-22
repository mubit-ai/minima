/**
 * Plan-premium resolution: which models may DECIDE the plan while plan mode is active.
 *
 * Single source of truth for the hard premium constraint (config.planPremium). Resolved at
 * USE time (plan turn / finalize), never snapshotted at startup — /auth can add a provider
 * key mid-session and must take effect on the next plan turn.
 */

import { envVarsForProvider, providerKeyPresent } from "../ai/provider_catalog.ts";
import { findModelById } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import type { HarnessConfig } from "./config.ts";

export interface ResolvedPlanModels {
  /** Runnable premium ids — pre-request candidate assembly for plan-routed recommend calls. */
  candidates: string[];
  /** The plan-shaping model (draft / revise / critic-attack / synth / finalize synthesis). */
  planModel: Model;
}

function unrunnableReason(id: string): string {
  const model = findModelById(id);
  if (!model) return "not in the model registry";
  const envVars = envVarsForProvider(model.provider);
  if (!envVars.length) return `provider ${model.provider} has no key env vars registered`;
  return `set ${envVars[0]}`;
}

/**
 * Resolve the premium plan models from config + registry + env keys.
 *
 * Returns null when the premium policy is INACTIVE (flag off, or an explicit /model pin —
 * explicit user override beats policy). Throws an actionable Error when the policy is active
 * but no allowlisted model is runnable: the hard constraint never silently widens.
 */
/**
 * Routing opts for a plan-MODE turn that runs the NORMAL loop — mode "plan" with no live
 * council (plan verification off, or session setup failed). Same premium hard pool + phase tag
 * as the council's planner turn, so the plan-mode agent never widens back to the cheap
 * general pool just because the council isn't running. Throws (via resolvePlanModels)
 * when the policy is active but no premium model is runnable — the hard constraint stays
 * loud on this path too.
 */
export function planModeRoutingOpts(config: HarnessConfig): {
  candidates?: string[];
  tags: string[];
} {
  const premium = resolvePlanModels(config);
  return { candidates: premium?.candidates, tags: ["phase:plan"] };
}

export function resolvePlanModels(config: HarnessConfig): ResolvedPlanModels | null {
  if (!config.planPremium || config.pinned) return null;
  const pool = [...config.planPremiumModels];
  if (config.planModel && !pool.includes(config.planModel)) pool.push(config.planModel);
  const runnable = pool.filter((id) => {
    const model = findModelById(id);
    return model ? providerKeyPresent(model.provider) : false;
  });
  let planModel: Model | null = null;
  if (config.planModel) {
    planModel = runnable.includes(config.planModel)
      ? (findModelById(config.planModel) ?? null)
      : null;
    if (!planModel) {
      throw new Error(
        `plan-premium: MINIMA_PLAN_MODEL=${config.planModel} is not runnable (${unrunnableReason(config.planModel)}). Fix: add the provider key (/auth), change MINIMA_PLAN_MODEL, or set MINIMA_TUI_PLAN_PREMIUM=0 to disable premium plan mode.`,
      );
    }
  } else {
    const first = runnable[0];
    if (first) planModel = findModelById(first) ?? null;
  }
  if (!runnable.length || !planModel) {
    const lines = pool.map((id) => {
      const provider = findModelById(id)?.provider;
      return `  ${id}${provider ? ` (${provider})` : ""} — ${unrunnableReason(id)}`;
    });
    throw new Error(
      `plan-premium: no runnable premium model for plan mode.\n${lines.join("\n")}\nFix: add a provider key (/auth), edit MINIMA_PLAN_PREMIUM_MODELS, or set MINIMA_TUI_PLAN_PREMIUM=0 to disable premium plan mode.`,
    );
  }
  return { candidates: runnable, planModel };
}
