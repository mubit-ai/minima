/**
 * /redo — the user's explicit "that was wrong, try again without that model" lever.
 *
 * Sends a corrective failure label (evidence_source "human" — the user's word IS the
 * signal, never re-graded by the LLM judge) for the last server-routed decision, adds
 * that model to the agent's session-scoped exclusions, and hands the original task back
 * to the caller for a normal re-routed submit. No usage fields ride on the corrective
 * feedback: the original rung already reported realized tokens/cost, and fabricating
 * them would corrupt the observed cost basis. Fail-open on transport errors — a dead
 * feedback endpoint must never block the re-route.
 */

import type { MinimaAgent } from "./runtime.ts";

/** Cap for the free-text note appended to the corrective feedback's `notes`. */
export const REDO_NOTE_CAP = 200;

export type RedoOutcome =
  | { kind: "no_history"; message: string }
  | { kind: "pinned"; message: string }
  | {
      kind: "reroute";
      task: string;
      excludedModelId: string;
      alreadyLabeled: boolean;
      message: string;
    };

interface DecisionRowLike {
  rec_id?: unknown;
  chosen_model?: unknown;
  routed?: unknown;
}

/** The latest server-routed decision row (a real rec_id — never local pinned/offline). */
function lastServerDecision(agent: MinimaAgent): { recId: string; modelId: string } | null {
  if (!agent.db || !agent.runId) return null;
  let rows: DecisionRowLike[];
  try {
    rows = agent.db.getRunDecisions(agent.runId);
  } catch {
    return null;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.routed !== "server") continue;
    const recId = typeof r.rec_id === "string" ? r.rec_id : null;
    const modelId = typeof r.chosen_model === "string" ? r.chosen_model : null;
    if (!recId || recId.startsWith("local-") || !modelId) continue;
    return { recId, modelId };
  }
  return null;
}

export async function redoLastRouted(agent: MinimaAgent, note?: string): Promise<RedoOutcome> {
  if (agent.config.pinned) {
    return {
      kind: "pinned",
      message:
        "/redo needs a routed turn, but a pinned model overrides routing — unpin with /model auto, then re-run your prompt.",
    };
  }
  const last = lastServerDecision(agent);
  const task = agent.lastRoutedTask;
  if (!last || !task) {
    return {
      kind: "no_history",
      message: "/redo: nothing routed yet this session — run a prompt first.",
    };
  }

  const extra = (note ?? "").trim();
  const notes = extra ? `user_rejected: ${extra.slice(0, REDO_NOTE_CAP)}` : "user_rejected";
  let alreadyLabeled = false;
  try {
    // Corrective label only: outcome failure, human evidence, NO quality score and NO
    // usage/latency (the original rung's feedback already carried the realized numbers).
    const resp = await agent.router.feedback({
      recommendationId: last.recId,
      chosenModelId: last.modelId,
      outcome: "failure",
      quality: null,
      evidenceSource: "human",
      verifiedInProduction: false,
      judged: false,
      notes,
    });
    if (!resp.accepted || (resp.warnings ?? []).includes("duplicate_feedback_ignored")) {
      alreadyLabeled = true;
    }
  } catch {
    // fail-open: the harness-enforced exclusion below still holds without the label
  }

  agent.excludeModelForSession(last.modelId);
  const labeledNote = alreadyLabeled
    ? " (server had already labeled that turn — exclusion still applies)"
    : "";
  return {
    kind: "reroute",
    task,
    excludedModelId: last.modelId,
    alreadyLabeled,
    message: `marking ${last.modelId} failed (human) — re-routing without it${labeledNote}`,
  };
}
