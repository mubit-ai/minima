/**
 * Footer token stats (B1.2, MUB-134) — one source of truth for the status bar's
 * `↑input ↓output · ctx%` numbers, used by the post-turn update and both resume paths
 * (interactive /resume and --resume startup). Pure; never yields NaN.
 */

import { findModelById } from "../ai/registry.ts";
import { type Message, isAssistant } from "../ai/types.ts";

export interface FooterStats {
  inputTokens: number;
  outputTokens: number;
  /** 0–100; 0 when no assistant turn or no resolvable context window. */
  ctxPct: number;
}

/**
 * Stats from the last assistant message. Context window resolution: the message's own
 * model (registry lookup) → `fallbackWindow` (e.g. the agent's currently routed model)
 * → 0 (which yields ctx% 0, never NaN — a resumed model may be unregistered until the
 * async catalog refresh; the value self-heals on the first live turn).
 */
export function footerStatsFromMessages(
  messages: Message[],
  fallbackWindow?: number | null,
): FooterStats {
  const last = [...messages].reverse().find(isAssistant);
  if (!last?.usage) return { inputTokens: 0, outputTokens: 0, ctxPct: 0 };
  const window = findModelById(last.model)?.context_window ?? fallbackWindow ?? 0;
  const input = last.usage.input || 0;
  return {
    inputTokens: input,
    outputTokens: last.usage.output || 0,
    ctxPct: window > 0 ? (100 * input) / window : 0,
  };
}
