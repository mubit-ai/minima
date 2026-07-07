/**
 * Run rehydration — restore a persisted run into a live MinimaAgent: the conversation
 * (agent context), the CostMeter rows (cost footer survives restart), and promptsRun
 * (judge cadence continuity). The inverse of the DbSink + DecisionRecord writer.
 */

import { AssistantMessage, Message } from "../ai/types.ts";
import type { CostRow } from "../minima/meter.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import type { MinimaDb, RunRow } from "./minima_db.ts";

export interface RehydratedRun {
  run: RunRow;
  messages: Message[];
  meterRows: CostRow[];
  /** Routed prompts in the run (drives promptsRun for judge cadence). */
  promptsRun: number;
}

/** Rebuild the run's state from the DB (pure read — apply with applyRehydratedRun). */
export function rehydrateRun(db: MinimaDb, runId: string): RehydratedRun {
  const run = db.getRun(runId);
  if (!run) throw new Error(`no such run: ${runId}`);

  const messages: Message[] = [];
  for (const ev of db.getRunEvents(runId)) {
    if (ev.agent_id) continue; // sub-agent context stays out of the lead conversation
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.payload) as Record<string, unknown>;
    } catch {
      continue; // skip unparseable rows rather than corrupt the context
    }
    const text = String(payload.text ?? "");
    if (ev.type === "user") {
      messages.push(new Message({ role: "user", content: text }));
    } else if (ev.type === "assistant") {
      messages.push(new AssistantMessage({ content: text, model: String(payload.model ?? "") }));
    } else if (ev.type === "tool") {
      messages.push(
        new Message({
          role: "toolResult",
          content: text,
          tool_name: String(payload.tool_name ?? "tool"),
          is_error: Boolean(payload.is_error ?? false),
        }),
      );
    }
    // 'routing' events carry decision metadata, not conversation — skipped here.
  }

  const meterRows: CostRow[] = [];
  const decisions = db.getRunDecisions(runId);
  for (const d of decisions) {
    meterRows.push({
      label: String(d.task_label ?? ""),
      model: String(d.chosen_model ?? "(offline)"),
      decisionBasis: String(d.decision_basis ?? "-"),
      estCostUsd: Number(d.est_cost_usd ?? 0),
      actualCostUsd: Number(d.actual_cost_usd ?? 0),
      baselineCostUsd:
        d.configured_baseline_cost_usd === null ? null : Number(d.configured_baseline_cost_usd),
      quality: d.quality === null ? null : Number(d.quality),
      outcome: String(d.outcome ?? "success"),
      turns: Number(d.turns ?? 0),
    });
  }

  return { run, messages, meterRows, promptsRun: decisions.length };
}

/** Apply a rehydrated run to a live agent (context + cost footer + judge cadence). */
export function applyRehydratedRun(agent: MinimaAgent, r: RehydratedRun): void {
  agent.agentState.messages = r.messages;
  if (agent.meter) {
    agent.meter.rows.length = 0;
    agent.meter.rows.push(...r.meterRows);
  }
  agent.setPromptsRun(r.promptsRun);
}
