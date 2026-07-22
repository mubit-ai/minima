/**
 * DbSink — a second Agent.subscribe() consumer that persists the event stream.
 *
 * Buffers rows during a turn and flushes them in ONE transaction at turn_end/agent_end
 * (per-turn atomicity: a crash mid-turn loses at most the in-flight turn, never leaves a
 * half-written one). tool_execution_end carries only {toolCallId, result, isError} — the
 * name/args come from a per-run Map populated on tool_execution_start (never write
 * placeholder tool names). Fail-open at the RUN boundary: a failed flush marks the run
 * `degraded` and disables itself; it never breaks the turn.
 */

import type { Agent } from "../agent/agent.ts";
import type { AgentEvent } from "../agent/events.ts";
import { AssistantMessage, type Message } from "../ai/types.ts";
import type { MinimaDb } from "./minima_db.ts";

interface PendingEvent {
  type: string;
  payload: unknown;
  ts: number;
}
interface PendingTool {
  toolName: string;
  args: unknown;
  result: string;
  isError: boolean;
  ts: number;
}

function messagePayload(m: Message): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, text: m.textContent };
  if (m instanceof AssistantMessage) {
    base.model = m.model; // plain string on AssistantMessage
    base.stop_reason = m.stop_reason;
    if (m.error_message) base.error_message = m.error_message;
    base.usage = {
      input: m.usage.input,
      output: m.usage.output,
      cache_read: m.usage.cache_read,
      cache_write: m.usage.cache_write,
      cost_total: m.usage.cost.total,
    };
    // MUB-175: tool_use blocks must round-trip — a rehydrated conversation missing the
    // ids serializes tool_result rows with tool_use_id undefined and 400s on resume.
    if (m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
    }
  }
  if (m.role === "toolResult") {
    base.tool_name = (m as Message & { tool_name?: string }).tool_name;
    base.is_error = (m as Message & { is_error?: boolean }).is_error ?? false;
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
  }
  return base;
}

export interface DbSinkHandle {
  /** Detach the subscriber and flush anything buffered. */
  detach(): void;
  /** True once a write failed and the sink disabled itself (run marked degraded). */
  readonly degraded: boolean;
}

export function attachDbSink(
  agent: Agent,
  db: MinimaDb,
  opts: { runId: string; agentId?: string | null },
): DbSinkHandle {
  const { runId } = opts;
  const agentId = opts.agentId ?? null;
  // tool_execution_end has no name/args — correlate via _start.
  const inFlightTools = new Map<string, { toolName: string; args: unknown; ts: number }>();
  let events: PendingEvent[] = [];
  let tools: PendingTool[] = [];
  let degraded = false;

  const flush = (): void => {
    if (degraded || (events.length === 0 && tools.length === 0)) return;
    const batchEvents = events;
    const batchTools = tools;
    events = [];
    tools = [];
    try {
      db.transact(() => {
        for (const e of batchEvents) {
          db.appendEvent({ runId, agentId, type: e.type, payload: e.payload, ts: e.ts });
        }
        for (const t of batchTools) {
          db.writeToolCall({
            runId,
            agentId,
            toolName: t.toolName,
            args: t.args,
            result: t.result,
            isError: t.isError,
            ts: t.ts,
          });
        }
      });
    } catch {
      // Fail-open: persistence must never break the turn — but never leave silent gaps
      // that read as truth either. Mark the run degraded and stop writing.
      degraded = true;
      try {
        db.markDegraded(runId);
      } catch {
        // even that failed — nothing more we can do
      }
    }
  };

  const listener = (ev: AgentEvent): void => {
    if (degraded) return;
    const now = Date.now() / 1000;
    switch (ev.type) {
      case "message_end": {
        const m = ev.message;
        if (!m) break;
        // The durable conversation record: user, assistant, toolResult. (Routing entries
        // are written by the DecisionRecord writer with richer fields.)
        if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
          events.push({
            type: m.role === "toolResult" ? "tool" : m.role,
            payload: messagePayload(m),
            ts: now,
          });
        }
        break;
      }
      case "tool_execution_start":
        inFlightTools.set(ev.toolCallId, { toolName: ev.toolName, args: ev.args, ts: now });
        break;
      case "tool_execution_end": {
        const started = inFlightTools.get(ev.toolCallId);
        inFlightTools.delete(ev.toolCallId);
        if (!started) break; // never write placeholder names
        const resultText =
          ev.result?.content
            ?.map((b) => ("text" in b ? (b as { text: string }).text : ""))
            .join("") ?? "";
        tools.push({
          toolName: started.toolName,
          args: started.args,
          result: resultText,
          isError: ev.isError,
          ts: now,
        });
        break;
      }
      case "turn_end":
      case "agent_end":
        flush();
        break;
    }
  };

  const unsubscribe = agent.subscribe(listener);
  return {
    detach(): void {
      unsubscribe();
      flush();
    },
    get degraded(): boolean {
      return degraded;
    },
  };
}
