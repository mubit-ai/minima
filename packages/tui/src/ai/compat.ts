/**
 * Cross-provider message compatibility.
 *
 * Port of the Python harness's ai/compat.py. Some providers can't represent every
 * content block the harness carries (e.g. a provider that has no thinking
 * channel). normalizeForTarget is the pre-pass that rewrites a message list for
 * a target api id before the provider serializes it.
 *
 * Today it carries exactly one rewrite: hoisting images out of tool results for the two
 * targets that cannot nest them. Anthropic can (`tool_result.content` accepts text and
 * image blocks), so it stays the identity.
 */

import { type ContentBlock, type ImageContent, Message, text } from "./types.ts";

export type TargetApi = "anthropic-messages" | "google-generative-ai" | "openai-completions";

/** Marks the synthetic message that carries hoisted tool-result images. */
const HOIST_NOTE = "[image output from the preceding tool result(s)]";

/** A tool result stripped of its images still needs a body — an empty content array is
 * rejected by both targets. */
const HOIST_PLACEHOLDER = "[image]";

const isImage = (b: ContentBlock): b is ImageContent => b.type === "image";

/**
 * Move images out of `toolResult` messages into a following synthetic user message.
 *
 * OpenAI's chat-completions API accepts only `text` parts in a `role: "tool"` message, and
 * Gemini's `functionResponse` cannot carry inline media on the models this harness seeds.
 * Both, however, accept images in an ordinary user message — which every provider already
 * serializes (openai_compat's `image_url`, google's `inlineData`).
 *
 * The images of a MAXIMAL CONTIGUOUS RUN of tool results are collected and emitted as ONE
 * message after the whole run. That is not a tidiness choice: OpenAI requires every
 * `role: "tool"` message to sit in an unbroken run immediately after the assistant message
 * that carried the `tool_calls`, so a synthetic user message inserted *between* two tool
 * results would break the association for the later ones.
 *
 * Never mutates. `messages` is the live transcript shared with the DB sink, the TUI and
 * compaction; rewritten entries are new objects and untouched ones pass through by
 * reference (so a list with no tool-result images is returned as-is).
 */
function hoistToolResultImages(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === "toolResult" && m.content.some(isImage))) return messages;

  const out: Message[] = [];
  // Images of the run currently being walked; flushed as one message when the run ends.
  let pending: ImageContent[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push(new Message({ role: "user", content: [text(HOIST_NOTE), ...pending] }));
    pending = [];
  };

  for (const m of messages) {
    if (m.role !== "toolResult") {
      flush();
      out.push(m);
      continue;
    }
    const mine = m.content.filter(isImage);
    if (mine.length === 0) {
      out.push(m);
      continue;
    }
    pending.push(...mine);
    const rest = m.content.filter((b) => !isImage(b));
    out.push(
      new Message({
        role: "toolResult",
        content: rest.length > 0 ? rest : [text(HOIST_PLACEHOLDER)],
        timestamp: m.timestamp,
        tool_call_id: m.tool_call_id,
        tool_name: m.tool_name,
        is_error: m.is_error,
      }),
    );
  }
  flush();
  return out;
}

/** Rewrite `messages` for `target`. */
export function normalizeForTarget(messages: Message[], target: TargetApi): Message[] {
  if (target === "anthropic-messages") return messages;
  return hoistToolResultImages(messages);
}
