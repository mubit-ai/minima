/**
 * P2 — replay guard: the "observable output" classifier for recovery-ladder rungs.
 *
 * classifyRungOutput inspects a rung's message window (messages.slice(fromIdx)):
 *  - "effectful": any toolResult in the window — a tool call reached the dispatcher
 *    (executed, so possibly world side effects; or hook-blocked, still a model-visible
 *    error result). Conservative: ALL toolResults count.
 *  - "text_only": no toolResult, but some assistant carries a non-empty text/thinking
 *    block streamed to the user — including an error assistant with partial text.
 *  - "clean": everything else (empty window, or only empty-content error assistants —
 *    the provider hard-fail shape).
 *
 * Consumed at the ladder's context rollback (runtime.ts): an effectful rung is never
 * erased-and-replayed; clean/text_only keep the classic rollback (nothing world-side
 * re-executes, the DB sink recorded every message, and the retry is LB-21-flagged).
 */

import type { Message } from "../ai/types.ts";

export type RungOutputClass = "effectful" | "text_only" | "clean";

export function classifyRungOutput(messages: readonly Message[], fromIdx: number): RungOutputClass {
  let sawText = false;
  for (let i = Math.max(0, fromIdx); i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "toolResult") return "effectful";
    if (m.role === "assistant" && !sawText) {
      sawText = m.content.some(
        (b) =>
          (b.type === "text" && b.text.length > 0) ||
          (b.type === "thinking" && b.thinking.length > 0),
      );
    }
  }
  return sawText ? "text_only" : "clean";
}
