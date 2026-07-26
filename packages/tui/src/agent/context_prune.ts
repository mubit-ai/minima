/**
 * P4 context prune — pure helpers behind the checkpoint/rewind tool pair.
 *
 * A rewind manipulates the PROJECTION only (AgentState.messages / the replayed
 * conversation); the DB transcript keeps every pruned row. The `context_rewind`
 * event (deliberately NOT the B4 `rewind` type) is both the audit record and the
 * replay marker. Replay-order constraint: the sink stamps the rewind turn's
 * assistant event at message_end time — BEFORE the tool executes and appends the
 * marker — so on replay the marker usually arrives AFTER that assistant; the
 * marker therefore carries rewind_tool_call_id and applyContextRewindMarker
 * re-attaches the rewind turn as the tail instead of truncating it away. A crash
 * between execute and the turn_end flush loses the rewind turn's messages but
 * keeps the marker carrying the report — acceptable.
 */

import type { Message, ToolCall } from "../ai/types.ts";

export const CONTEXT_REWIND_EVENT = "context_rewind";

export interface PendingContextRewind {
  anchorToolCallId: string;
  rewindToolCallId: string;
}

export interface ContextRewindMarker {
  anchor_tool_call_id: string;
  rewind_tool_call_id: string | null;
  report: string;
}

function toolCallIds(m: Message): string[] {
  if (m.role !== "assistant") return [];
  return m.content.filter((b): b is ToolCall => b.type === "toolCall").map((b) => b.id);
}

function lastResultIndex(messages: Message[], match: (m: Message) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult" && match(m)) return i;
  }
  return -1;
}

function lastAssistantWithCall(messages: Message[], toolCallId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (toolCallIds(messages[i]!).includes(toolCallId)) return i;
  }
  return -1;
}

/** The latest non-error checkpoint result NOT consumed by a later successful rewind. */
export function findRewindAnchor(messages: Message[]): string | null {
  const consumed = lastResultIndex(messages, (m) => m.tool_name === "rewind" && !m.is_error);
  for (let i = messages.length - 1; i > consumed; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult" && m.tool_name === "checkpoint" && !m.is_error && m.tool_call_id) {
      return m.tool_call_id;
    }
  }
  return null;
}

/** Everything through the anchor toolResult; null when the anchor is absent. */
export function truncateAfterAnchor(
  messages: Message[],
  anchorToolCallId: string,
): Message[] | null {
  const anchorIdx = lastResultIndex(messages, (m) => m.tool_call_id === anchorToolCallId);
  if (anchorIdx < 0) return null;
  return messages.slice(0, anchorIdx + 1);
}

/**
 * Turn-boundary apply: cut (anchor, rewind-assistant) out of the projection. Both
 * slice edges are well-formed pairs — the anchor result stays with its assistant,
 * the rewind assistant stays with its just-appended results. Always clears the field.
 */
export function applyPendingContextRewind(state: {
  messages: Message[];
  pendingContextRewind: PendingContextRewind | null;
}): void {
  const pending = state.pendingContextRewind;
  state.pendingContextRewind = null;
  if (!pending) return;
  const anchorIdx = lastResultIndex(
    state.messages,
    (m) => m.tool_call_id === pending.anchorToolCallId,
  );
  const tailIdx = lastAssistantWithCall(state.messages, pending.rewindToolCallId);
  if (anchorIdx < 0 || tailIdx <= anchorIdx) return;
  state.messages = [...state.messages.slice(0, anchorIdx + 1), ...state.messages.slice(tailIdx)];
}

export function parseContextRewindMarker(payload: unknown): ContextRewindMarker | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.anchor_tool_call_id !== "string" || !p.anchor_tool_call_id) return null;
  return {
    anchor_tool_call_id: p.anchor_tool_call_id,
    rewind_tool_call_id:
      typeof p.rewind_tool_call_id === "string" && p.rewind_tool_call_id
        ? p.rewind_tool_call_id
        : null,
    report: typeof p.report === "string" ? p.report : "",
  };
}

/** Replay-side apply (both marker-vs-assistant orders); null = anchor missing, no-op. */
export function applyContextRewindMarker(
  messages: Message[],
  marker: ContextRewindMarker,
): Message[] | null {
  const anchorIdx = lastResultIndex(messages, (m) => m.tool_call_id === marker.anchor_tool_call_id);
  if (anchorIdx < 0) return null;
  if (marker.rewind_tool_call_id) {
    const tailIdx = lastAssistantWithCall(messages, marker.rewind_tool_call_id);
    if (tailIdx > anchorIdx) {
      return [...messages.slice(0, anchorIdx + 1), ...messages.slice(tailIdx)];
    }
  }
  return messages.slice(0, anchorIdx + 1);
}
