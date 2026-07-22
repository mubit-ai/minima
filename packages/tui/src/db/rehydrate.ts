/**
 * Run rehydration — restore a persisted run into a live MinimaAgent: the conversation
 * (agent context), the CostMeter rows (cost footer survives restart), and promptsRun
 * (judge cadence continuity). The inverse of the DbSink + DecisionRecord writer.
 */

import {
  AssistantMessage,
  type ContentBlock,
  Message,
  type StopReason,
  type ToolCall,
  Usage,
  text as textBlock,
  toolCall,
} from "../ai/types.ts";
import type { CostRow } from "../minima/meter.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import { parseRewindMarker, truncateBeforePrompt } from "../session/rewind.ts";
import type { MinimaDb, RunRow } from "./minima_db.ts";

const STOP_REASONS: readonly StopReason[] = ["stop", "length", "toolUse", "error", "aborted"];

/** Validate a persisted stop_reason against the union; unknown/legacy rows → "stop". */
function stopReasonFrom(raw: unknown): StopReason {
  return STOP_REASONS.includes(raw as StopReason) ? (raw as StopReason) : "stop";
}

/**
 * Rebuild Usage from the sink payload (sink.ts messagePayload). Missing/legacy payloads →
 * zeroed Usage. Only cost.total is persisted (cost_total); per-component dollars stay 0 —
 * nothing downstream consumes them (meter/budget/sections all read cost.total).
 */
function usageFrom(raw: unknown): Usage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Number(v) || 0;
  const usage = new Usage({
    input: n(r.input),
    output: n(r.output),
    cache_read: n(r.cache_read),
    cache_write: n(r.cache_write),
  });
  usage.cost.total = n(r.cost_total);
  return usage;
}

/** Rebuild persisted tool_use blocks (sink payload `tool_calls`); malformed rows → []. */
function toolCallsFrom(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || typeof r.name !== "string") continue;
    const args =
      r.arguments && typeof r.arguments === "object" && !Array.isArray(r.arguments)
        ? (r.arguments as Record<string, unknown>)
        : {};
    out.push(toolCall(r.id, r.name, args));
  }
  return out;
}

/**
 * MUB-175: drop half-pairs an aborted/errored/rewound turn left behind, BOTH directions —
 * an assistant tool_use with no following result loses that block (the whole message when
 * nothing else remains), and a toolResult with no owning tool_use is dropped — so every
 * provider serializes a valid conversation on resume.
 */
export function pruneOrphanToolMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "toolResult") {
      i += 1; // reached only when no preceding assistant claimed it — orphan
      continue;
    }
    if (m instanceof AssistantMessage && m.toolCalls.length > 0) {
      const results: Message[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "toolResult") {
        results.push(messages[j]!);
        j += 1;
      }
      const callIds = new Set(m.toolCalls.map((c) => c.id));
      const answered = new Set<string>();
      const kept: Message[] = [];
      for (const r of results) {
        const id = r.tool_call_id;
        if (id && callIds.has(id) && !answered.has(id)) {
          answered.add(id);
          kept.push(r);
        }
      }
      m.content = m.content.filter((b) => b.type !== "toolCall" || answered.has(b.id));
      if (m.content.length > 0) out.push(m);
      out.push(...kept);
      i = j;
      continue;
    }
    out.push(m);
    i += 1;
  }
  return out;
}

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

  let messages: Message[] = [];
  for (const ev of db.getRunEvents(runId)) {
    if (ev.agent_id) continue; // sub-agent context stays out of the lead conversation
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.payload) as Record<string, unknown>;
    } catch {
      continue; // skip unparseable rows rather than corrupt the context
    }
    if (ev.type === "rewind") {
      // B4: replay-with-truncation — the marker cuts everything from prompt keep+1 on.
      // (Meter rows and promptsRun stay full below: the spend happened — feedback truth.)
      const marker = parseRewindMarker(payload);
      if (marker) messages = truncateBeforePrompt(messages, marker.keep_prompts);
      continue;
    }
    const text = String(payload.text ?? "");
    if (ev.type === "user") {
      messages.push(new Message({ role: "user", content: text }));
    } else if (ev.type === "assistant") {
      const calls = toolCallsFrom(payload.tool_calls);
      const content: ContentBlock[] | string = calls.length
        ? [...(text ? [textBlock(text)] : []), ...calls]
        : text;
      messages.push(
        new AssistantMessage({
          content,
          model: String(payload.model ?? ""),
          stop_reason: stopReasonFrom(payload.stop_reason),
          usage: usageFrom(payload.usage),
        }),
      );
    } else if (ev.type === "tool") {
      messages.push(
        new Message({
          role: "toolResult",
          content: text,
          tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : undefined,
          tool_name: String(payload.tool_name ?? "tool"),
          is_error: Boolean(payload.is_error ?? false),
        }),
      );
    }
    // 'routing' events carry decision metadata, not conversation — skipped here.
  }
  messages = pruneOrphanToolMessages(messages);

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
      // F1: per-row token telemetry is not persisted — a rehydrated row honestly reports
      // none (kvCacheHitRate stays null over these rows rather than faking 100% misses).
      cacheReadTokens: 0,
      inputTokens: 0,
      labeled: Boolean(d.judged) || d.big_plan_outcome !== null,
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
  // D2: reuse the resumed run's provider session id — it keys the provider-side prompt
  // cache, so continuing under the ORIGINAL id keeps the rehydrated prefix warm instead
  // of paying full input price on the first post-resume turn. The column existed since
  // v1 but was never read back.
  if (r.run.provider_session_id) {
    agent.sessionId = r.run.provider_session_id;
    if (agent.db && agent.runId) {
      try {
        agent.db.setProviderSessionId(agent.runId, r.run.provider_session_id);
      } catch {
        // bookkeeping is fail-open
      }
    }
  }
}
