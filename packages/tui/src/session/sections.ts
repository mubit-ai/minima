/**
 * Section model — a pure roll-up of the agent's conversation into user-prompt sections
 * (U1.2, MUB-138). A section opens at every `user` message and spans everything until the
 * next user message, so every message index belongs to exactly one section — the anchor
 * invariant the ToC sidebar (U2) navigates by.
 *
 * Semantics:
 * - Leading non-user messages (rehydrated fragments, system-injected context) form a
 *   synthetic section 0 titled "(session start)".
 * - Only AssistantMessage rows contribute usage; user/toolResult rows are structure only.
 * - `inputTokens` sums per-turn *billed* input (context is re-sent every turn) — truthful
 *   for spend, not a context-size gauge; ctx% stays the footer's job.
 * - Child-agent (task tool) usage is EXCLUDED: children's messages never enter the lead
 *   Message[]; their spend stays attributed via routing_decisions.agent_id and the run meter.
 *
 * Pure and O(n): imports only ai/types, no I/O — pass agent.agentState.messages (live or
 * rehydrated; rehydrate restores usage as of U1.1, so both are equivalent).
 */

import { type Message, isAssistant } from "../ai/types.ts";

export interface SectionUsage {
  /** Σ assistant usage.input across the section (billed input tokens). */
  inputTokens: number;
  /** Σ assistant usage.output across the section. */
  outputTokens: number;
  /** Σ assistant usage.cost.total (includes cache dollars; cache tokens not counted),
   * plus any booked tool provider fees joined by tool_call_id (MUB-172). */
  costUSD: number;
}

export interface Section {
  /** 0-based section ordinal. */
  index: number;
  /** User-prompt excerpt: first line, whitespace-collapsed, ellipsized. */
  title: string;
  /** Index of the opening user message in the input array (synthetic section: 0). */
  startMsgIdx: number;
  /** Inclusive; the last message before the next user prompt (or the last message). */
  endMsgIdx: number;
  usage: SectionUsage;
  /** Running totals through this section, inclusive. */
  cumulative: SectionUsage;
}

export interface SectionLedger {
  sections: Section[];
  /** Equal to the last section's cumulative, or zeros for an empty conversation. */
  totals: SectionUsage;
}

const zeroUsage = (): SectionUsage => ({ inputTokens: 0, outputTokens: 0, costUSD: 0 });

export const SESSION_START_TITLE = "(session start)";
const DEFAULT_TITLE_MAX = 48;

/** First line, whitespace collapsed, ellipsized at `max` (exported for U2 ToC titles). */
export function sectionTitle(promptText: string, max = DEFAULT_TITLE_MAX): string {
  const line = (promptText.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Pure section roll-up over the lead conversation. `toolFees` is the meter's booked
 * provider-fee map (tool_call_id → USD) — fees join the section whose turn ran the tool. */
export function computeSections(
  messages: Message[],
  opts?: { titleMax?: number; toolFees?: ReadonlyMap<string, number> },
): SectionLedger {
  const titleMax = opts?.titleMax ?? DEFAULT_TITLE_MAX;
  const sections: Section[] = [];
  let current: Section | null = null;
  const cumulative = zeroUsage();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user" || current === null) {
      const isPrompt = msg.role === "user";
      current = {
        index: sections.length,
        title: isPrompt ? sectionTitle(msg.textContent, titleMax) : SESSION_START_TITLE,
        startMsgIdx: i,
        endMsgIdx: i,
        usage: zeroUsage(),
        cumulative: zeroUsage(),
      };
      sections.push(current);
    }
    current.endMsgIdx = i;
    if (isAssistant(msg)) {
      current.usage.inputTokens += msg.usage.input || 0;
      current.usage.outputTokens += msg.usage.output || 0;
      current.usage.costUSD += msg.usage.cost.total || 0;
    } else if (msg.role === "toolResult" && msg.tool_call_id) {
      current.usage.costUSD += opts?.toolFees?.get(msg.tool_call_id) ?? 0;
    }
  }

  for (const s of sections) {
    cumulative.inputTokens += s.usage.inputTokens;
    cumulative.outputTokens += s.usage.outputTokens;
    cumulative.costUSD += s.usage.costUSD;
    s.cumulative = { ...cumulative };
  }

  return { sections, totals: { ...cumulative } };
}
