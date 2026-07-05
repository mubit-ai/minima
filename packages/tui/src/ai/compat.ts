/**
 * Cross-provider message compatibility.
 *
 * Port of the Python harness's ai/compat.py. Some providers can't represent every
 * content block the harness carries (e.g. a provider that has no thinking
 * channel). normalizeForTarget is the pre-pass that rewrites a message list for
 * a target api id before the provider serializes it.
 *
 * Phase 1 ships the identity implementation (openai_compat already handles its
 * own conversion in `_toWire`); provider-specific rewrites land as the
 * anthropic/google providers are added.
 */

import type { Message } from "./types.ts";

export type TargetApi = "anthropic-messages" | "google-generative-ai" | "openai-completions";

/** Rewrite `messages` for `target`. Identity in Phase 1. */
export function normalizeForTarget(messages: Message[], _target: TargetApi): Message[] {
  return messages;
}
