/**
 * TTSR — stream tripwire rules (W4.2 / MUB-204).
 *
 * Dormant, harness-defined regex rules matched against the LIVE assistant token stream in
 * agentLoop. On a match mid-stream the loop aborts the provider request, discards the
 * un-committed partial, injects the rule's reminder as a harness-authored user message, and
 * retries the same turn with that reminder in context. Zero regex work until the flag is
 * armed AND a delta arrives; a bounded sliding window keeps matching linear per turn.
 *
 * Layering: the interfaces (TtsrController/TtsrTurnMatcher/TtsrHit) live in agent/state.ts so
 * loop.ts depends only on its own layer; the concrete implementation lives here.
 */

import type { TtsrController, TtsrHit, TtsrTurnMatcher } from "../agent/state.ts";
import { Message, text } from "../ai/types.ts";

/** Prefix stamped on every injected reminder — isTtsrReminder keys on it (compaction, UI). */
export const TTSR_REMINDER_PREFIX = "Stream tripwire fired:";

/** Bounded match window (chars): each delta tests only the tail, so matching stays O(n·W)
 * over a turn, not O(n²). Rules MUST match within this window (no unbounded `.*` spanning the
 * whole buffer); a match ending at the current position is always contained as long as
 * maxMatchLen + maxDeltaLen ≤ TTSR_WINDOW. */
const TTSR_WINDOW = 1024;

/** Per-rule default: how many times a single rule may fire (trigger a retry) within one turn. */
const DEFAULT_RETRY_CAP = 1;

/** A code-level tripwire rule. Patterns must be bounded and carry NO global/sticky flag
 * (RegExp.test is stateful under `g`/`y`). `retryCap` bounds re-fires within a turn. */
export interface TtsrRule {
  id: string;
  pattern: RegExp;
  reminder: string;
  retryCap?: number;
}

/** Seed table — high-precision, catastrophic-only patterns. The flag gates the whole table;
 * default OFF, so a rule's false-positive cost is paid only under opt-in until field-validated. */
export const DEFAULT_TTSR_RULES: TtsrRule[] = [
  {
    id: "destructive-root-delete",
    pattern: /\brm\s+-[rf]+\s+\/(?![\w./-])/,
    reminder:
      "A recursive force-delete rooted at the filesystem root (`rm -rf /` or equivalent) was " +
      "forming in the response. Do not run it. Re-check the exact path you meant to remove and " +
      "scope the command to that path.",
  },
  {
    id: "fork-bomb",
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    reminder:
      "A shell fork bomb was forming in the response. Do not emit or run it. Reconsider what you " +
      "were actually trying to accomplish.",
  },
];

/** True when `content` is a harness-injected tripwire reminder (compaction preserves these
 * verbatim; the transcript may render them as a system line rather than a user bubble). */
export function isTtsrReminder(content: string): boolean {
  return content.startsWith(TTSR_REMINDER_PREFIX);
}

/**
 * Compile a rule table into an installable controller. `capOverride` (MINIMA_TUI_TTSR_CAP)
 * globally overrides each rule's own retryCap when set. arm() yields a fresh per-turn matcher
 * carrying its own per-rule fire counters.
 */
export function compileTtsr(rules: TtsrRule[], capOverride?: number): TtsrController {
  return {
    arm(): TtsrTurnMatcher {
      const fired = new Map<string, number>();
      return {
        test(partialText: string): TtsrHit | null {
          const window =
            partialText.length > TTSR_WINDOW ? partialText.slice(-TTSR_WINDOW) : partialText;
          for (const rule of rules) {
            const cap = capOverride ?? rule.retryCap ?? DEFAULT_RETRY_CAP;
            if ((fired.get(rule.id) ?? 0) >= cap) continue;
            if (rule.pattern.test(window)) return { ruleId: rule.id, reminder: rule.reminder };
          }
          return null;
        },
        onFired(hit: TtsrHit): void {
          fired.set(hit.ruleId, (fired.get(hit.ruleId) ?? 0) + 1);
        },
        reminder(hit: TtsrHit): Message {
          return new Message({
            role: "user",
            content: [text(`${TTSR_REMINDER_PREFIX} ${hit.reminder}`)],
          });
        },
      };
    },
  };
}
