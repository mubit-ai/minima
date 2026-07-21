/**
 * Classify Minima recommend-response warnings for display.
 *
 * The server (src/minima/recommender/engine.py) emits ~18 `warnings` strings, and they are
 * ALL benign/informational on a recommend response — they describe successful selection or
 * graceful degradation (thompson_pick, exploration_pick, no_model_meets_threshold,
 * collapse_guard_applied, prices_stale, no_model_within_*_budget, and the class-specific
 * memory-degradation labels memory_unreachable / memory_auth_failed / memory_rejected_payload /
 * memory_server_error / memory_recall_bug, …).
 * None is a hard failure. The old TUI used a 4-item DENYLIST and rendered everything else as
 * a red error, so any diagnostic not in the list (and any NEW server diagnostic) looked like
 * a failure. We invert that: recommend-path warnings are shown as a MUTED info note, never a
 * red error, and the noisiest purely-internal signals are hidden entirely.
 */

import type { RouteConfirmInfo } from "../minima/runtime.ts";
import { fmtUsd } from "./status.tsx";

// Purely-internal signals with no user value — hidden completely.
const HIDDEN_PREFIXES = [
  "cold_start",
  "reasoner_disabled",
  "reasoner_consulted",
  // Arrives as `escalation_suggested:<reason>` — a purely-internal thin/conflicted-evidence
  // signal (like reasoner_consulted). Surfacing the raw string spills a long unbreakable token
  // past the bordered turn cell; the reference Python harness treats it as inline-only too.
  "escalation_suggested",
  "recall_timeout",
  "prices_stale",
  "thompson_pick",
  "exploration_pick",
  "llm_classified",
  "neighbor_classified",
  "collapse_guard_applied",
];

/** Info-level warnings worth a muted one-liner (everything not hidden). Never errors. */
export function routingInfoWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => !HIDDEN_PREFIXES.some((p) => w.startsWith(p)));
}

/** The route-confirm overlay's question line: model, basis, est cost, filtered warnings. */
export function formatRouteConfirm(info: RouteConfirmInfo): string {
  if (info.decisionBasis === "offline") {
    return `route: offline — ${info.offlineReason ?? "Minima unreachable"} — would run ${
      info.modelId ?? "the current model"
    } unrouted`;
  }
  const cost =
    info.estCostUsd !== null
      ? info.estCostHigh !== null
        ? ` · est ${fmtUsd(info.estCostUsd)}–${fmtUsd(info.estCostHigh)}`
        : ` · est ${fmtUsd(info.estCostUsd)}`
      : "";
  const warn = routingInfoWarnings(info.warnings);
  const warnLine = warn.length ? ` · ⚠ ${warn.join(", ")}` : "";
  return `route: ${info.modelId ?? "?"} ▸ ${info.decisionBasis}${cost}${warnLine}`;
}

/** The Run option's description in the route-confirm overlay. */
export function runOptionDesc(info: RouteConfirmInfo): string {
  if (info.decisionBasis === "offline") return "run unrouted on the current model";
  if (info.decisionBasis === "pinned") return `run pinned ${info.modelId ?? "model"}`;
  return `run ${info.modelId ?? "the routed model"}`;
}
