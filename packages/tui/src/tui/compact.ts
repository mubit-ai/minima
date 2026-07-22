/**
 * Context compaction — summarize old turns to free token budget.
 *
 * When context usage exceeds a threshold (default 80%), or on manual /compact,
 * older messages are replaced with a concise summary, keeping the most recent
 * turns intact for continuity.
 */

import type { Message } from "../ai/types.ts";
import { Message as AgentMessage, AssistantMessage, text } from "../ai/types.ts";
import type { MinimaAgent } from "../minima/runtime.ts";

const KEEP_RECENT = 6;

export interface CompactResult {
  compacted: number;
  summary: string;
}

export function compactMessages(_agent: MinimaAgent, messages: Message[]): Message[] {
  if (messages.length <= KEEP_RECENT + 2) return messages;

  const oldMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(-KEEP_RECENT);

  const summaryParts: string[] = [];
  for (const m of oldMessages) {
    if (m.role === "user") {
      summaryParts.push(`User: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "assistant") {
      summaryParts.push(`Assistant: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "toolResult") {
      summaryParts.push(`Tool(${m.tool_name}): ${m.textContent.slice(0, 100)}`);
    }
  }

  const summaryText = `[Compacted ${oldMessages.length} messages]\n${summaryParts.join("\n")}`;
  const summaryMsg = new AgentMessage({
    role: "user",
    content: summaryText,
  });

  return [summaryMsg, ...recentMessages];
}

/** Estimated context tokens of a message list (chars/4 — the auto-threshold's own basis). */
export function approxContextTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += m.textContent.length;
  }
  return Math.ceil(totalChars / 4);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * The user-facing /compact line (MUB-170): a session-derived estimated-token delta instead
 * of the canned constant message count. Deterministic and offline — same basis as the 80%
 * auto threshold.
 */
export function compactReport(before: Message[], after: Message[]): string {
  const beforeTokens = approxContextTokens(before);
  if (after === before || after.length === before.length) {
    return `Nothing to compact: ${before.length} messages, ~${fmtTokens(beforeTokens)} tokens (est.)`;
  }
  const afterTokens = approxContextTokens(after);
  const freed =
    beforeTokens > 0
      ? Math.max(0, Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100))
      : 0;
  return `Context compacted: ~${fmtTokens(beforeTokens)} → ~${fmtTokens(afterTokens)} tokens (est., ${freed}% freed) · ${before.length} → ${after.length} messages`;
}

export function maybeAutoCompact(agent: MinimaAgent): boolean {
  const model = agent.agentState.model;
  if (!model?.context_window) return false;

  const pct = (approxContextTokens(agent.agentState.messages) / model.context_window) * 100;

  if (pct < 80) return false;

  const before = agent.agentState.messages.length;
  agent.agentState.messages = compactMessages(agent, agent.agentState.messages);
  return agent.agentState.messages.length < before;
}
