/**
 * Conversation rewind (B4 /undo · B5 /rewind) — pure helpers over the agent's Message[].
 *
 * The branch model (decided 2026-07-13): rewinds stay in the SAME run. A `rewind` event
 * appended to the SQLite spine carries the cutoff (`keep_prompts`, in REPLAY space — the
 * count of lead user events to keep); rehydrateRun replays events in order and truncates
 * when it meets a marker. The DB stays append-only, /resume just works, and the abandoned
 * turns remain in the log (auditable, still rewindable-to). Live truncation maps picks by
 * DISTANCE FROM THE END: /compact can rewrite old in-memory turns, but the tail is shared
 * between live and replay space, so "drop the last N prompts" means the same thing in both.
 */

import type { Message } from "../ai/types.ts";

/** The payload of a `rewind` event on the events spine. */
export interface RewindMarker {
  /** Lead user prompts to KEEP (replay space); everything from prompt keep+1 on is cut. */
  keep_prompts: number;
}

export function parseRewindMarker(payload: unknown): RewindMarker | null {
  if (!payload || typeof payload !== "object") return null;
  const k = (payload as Record<string, unknown>).keep_prompts;
  return typeof k === "number" && Number.isInteger(k) && k >= 0 ? { keep_prompts: k } : null;
}

/**
 * Truncate to just before the (keep+1)-th user message. keep = number of user prompts
 * that survive. Non-user leading messages (system seeds) always survive a keep of 0.
 */
export function truncateBeforePrompt(messages: Message[], keep: number): Message[] {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "user") continue;
    seen += 1;
    if (seen > keep) return messages.slice(0, i);
  }
  return messages;
}

export interface TailTruncation {
  messages: Message[];
  /** The first dropped user prompt (its text prefills the composer), null if none dropped. */
  droppedPrompt: Message | null;
}

/**
 * Drop the last `count` user prompts (and everything after the earliest of them).
 * The live-space twin of truncateBeforePrompt: counting from the end survives /compact
 * rewriting older turns, because live and replay space share their tail.
 */
export function truncateLastPrompts(messages: Message[], count: number): TailTruncation {
  if (count <= 0) return { messages, droppedPrompt: null };
  const promptIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") promptIdxs.push(i);
  }
  if (promptIdxs.length === 0) return { messages, droppedPrompt: null };
  const cutAt = promptIdxs[Math.max(0, promptIdxs.length - count)]!;
  return { messages: messages.slice(0, cutAt), droppedPrompt: messages[cutAt] ?? null };
}

/** Text of a user Message (first text block or plain string content). */
export function promptText(message: Message | null): string {
  if (!message) return "";
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block) {
        return String((block as { text: unknown }).text ?? "");
      }
    }
  }
  return "";
}
