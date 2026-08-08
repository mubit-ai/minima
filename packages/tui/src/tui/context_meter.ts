/**
 * Context-window meter — ONE basis for the status bar's `ctx%` and for the auto-compaction
 * trigger. Pure; never yields NaN.
 *
 * It replaces two numbers that never agreed. The footer divided the last reply's bare
 * `usage.input` by the window, but `usage.input` is the UNCACHED remainder (ai/usage.ts:26)
 * — with prompt caching on (the default) that undercounts the real prompt by roughly an
 * order of magnitude. Auto-compaction meanwhile used chars/4 over the message list, so the
 * number the user watched was not the number that fired compaction.
 */

import { findModelById } from "../ai/registry.ts";
import { type AssistantMessage, type Message, type Usage, isAssistant } from "../ai/types.ts";

/** The share of the window at which a turn ends in auto-compaction — and, because both now
 * read the same quantity, the share at which the footer's `ctx%` turns red. */
export const AUTO_COMPACT_PCT = 80;

/**
 * How `usedTokens` was arrived at:
 * - `exact` — the last message IS the anchor, so the number is the provider's own count
 *   with no chars/4 leakage. This is the steady state at the post-turn call site.
 * - `adjusted` — the provider's count through the anchor, plus an estimate of what has been
 *   appended since.
 * - `estimated` — no reply has recorded usage yet; pure chars/4, byte-identical to the
 *   pre-unification auto-compact basis.
 */
export type ContextBasis = "exact" | "adjusted" | "estimated";

export interface ContextUsage {
  usedTokens: number;
  /** null = unresolvable. Render it as UNKNOWN; a confident `0%` is the bug this replaces. */
  windowTokens: number | null;
  /** 0–100+, uncapped. null when the window is unresolvable — the null PROPAGATES, so
   * `maybeAutoCompact` declines rather than compacting against a made-up denominator. */
  pct: number | null;
  basis: ContextBasis;
  /** The anchor reply's own tokens, for the footer's `↑input ↓output` segment. */
  inputTokens: number;
  outputTokens: number;
}

/** Nothing in context and nothing known about the window — the fresh-session state. */
export const EMPTY_CONTEXT: ContextUsage = {
  usedTokens: 0,
  windowTokens: null,
  pct: null,
  basis: "estimated",
  inputTokens: 0,
  outputTokens: 0,
};

/** Estimated context tokens of a message list (chars/4 — the auto-threshold's own basis).
 * Structurally blind to the system prompt, the tool schemas and every toolCall/thinking
 * block, since `textContent` filters to text blocks and the system prompt is a field on
 * AgentState rather than a message. That blindness is what `overhead` below measures. */
export function approxContextTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += m.textContent.length;
  }
  return Math.ceil(totalChars / 4);
}

/** Compact token count for the status row: `840` · `68k` · `1.5M`. */
export function fmtCtxTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

/** A base Message with role "assistant" passes isAssistant but carries no `usage` at all
 * (the declared type says otherwise), so every read has to survive `undefined`. */
function usageOf(m: Message): Usage | undefined {
  return (m as AssistantMessage).usage as Usage | undefined;
}

/** What the provider actually counted as this reply's PROMPT. `input` is the uncached
 * remainder in all three providers (anthropic.ts:188, google.ts:202, openai_compat.ts:344),
 * so the cached halves have to be added back — the same sum costFor() already does. */
function promptTokens(u: Usage): number {
  return (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0);
}

function resolveWindow(anchorModel: string | null, fallback: number | null): number | null {
  const registered = anchorModel ? findModelById(anchorModel)?.context_window : undefined;
  const w = registered ?? fallback ?? null;
  return w && w > 0 ? w : null;
}

/**
 * Context usage over `messages`, anchored on the last reply that recorded a real prompt:
 *
 *     anchor         = last assistant message whose (input + cache_read + cache_write) > 0
 *     countedThrough = anchor prompt + anchor output
 *     estThrough     = approxContextTokens(messages through the anchor)
 *     overhead       = max(0, countedThrough - estThrough)
 *     usedTokens     = overhead + approxContextTokens(messages)
 *
 * `overhead` is measured arithmetic residue, not a guess: it is "what the provider counted"
 * minus "what chars/4 can see", which is precisely the system prompt, the tool schemas and
 * the provider framing. It is re-derived every turn, so it self-corrects.
 *
 * In the steady state — the anchor IS the last message, which is exactly the situation at
 * the post-turn call site — `estThrough` equals the whole estimate and the two chars/4 terms
 * cancel, leaving `usedTokens === countedThrough` exactly. Appending messages degrades it to
 * `countedThrough + approx(tail)`.
 *
 * Known limitation: removing messages BEFORE the anchor (compaction keeps the last six, so
 * the anchor survives) does not lower the number until the next reply re-anchors it. The
 * cancellation above is exact, so a prefix drop with the anchor still in place is arithmetic-
 * ally indistinguishable from the steady state — the two produce identical inputs here.
 * Removing the anchor itself (/rewind, /undo) does re-anchor and does lower the number.
 *
 * `legacy` (the MINIMA_TUI_CONTEXT_METER=0 rollback) reproduces the pre-fix numbers exactly:
 * bare `usage.input / window`, and `pct` 0 rather than null when the window is unresolvable.
 * It is a PARAMETER, not an ambient env read, so the function stays pure and both branches
 * are unit-testable.
 */
export function contextUsage(
  messages: Message[],
  opts?: { fallbackWindow?: number | null; legacy?: boolean },
): ContextUsage {
  const fallback = opts?.fallbackWindow ?? null;

  if (opts?.legacy) {
    const last = [...messages].reverse().find(isAssistant);
    const u = last ? usageOf(last) : undefined;
    if (!last || !u) {
      return { ...EMPTY_CONTEXT, pct: 0, windowTokens: resolveWindow(null, fallback) };
    }
    const window = resolveWindow(last.model, fallback);
    const input = u.input || 0;
    return {
      usedTokens: input,
      windowTokens: window,
      pct: window ? (100 * input) / window : 0,
      basis: "exact",
      inputTokens: input,
      outputTokens: u.output || 0,
    };
  }

  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !isAssistant(m)) continue;
    const u = usageOf(m);
    if (u && promptTokens(u) > 0) {
      anchorIdx = i;
      break;
    }
  }

  const est = approxContextTokens(messages);
  const anchor = anchorIdx >= 0 ? (messages[anchorIdx] as AssistantMessage) : null;
  const anchorUsage = anchor ? usageOf(anchor) : undefined;

  if (!anchor || !anchorUsage) {
    const window = resolveWindow(null, fallback);
    return {
      usedTokens: est,
      windowTokens: window,
      pct: window ? (100 * est) / window : null,
      basis: "estimated",
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const countedThrough = promptTokens(anchorUsage) + (anchorUsage.output || 0);
  const estThrough = approxContextTokens(messages.slice(0, anchorIdx + 1));
  const overhead = Math.max(0, countedThrough - estThrough);
  const usedTokens = overhead + est;
  const window = resolveWindow(anchor.model, fallback);

  return {
    usedTokens,
    windowTokens: window,
    pct: window ? (100 * usedTokens) / window : null,
    basis: anchorIdx === messages.length - 1 ? "exact" : "adjusted",
    inputTokens: anchorUsage.input || 0,
    outputTokens: anchorUsage.output || 0,
  };
}
