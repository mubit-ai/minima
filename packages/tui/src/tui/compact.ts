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

export function maybeAutoCompact(agent: MinimaAgent): boolean {
  const model = agent.agentState.model;
  if (!model?.context_window) return false;

  let totalChars = 0;
  for (const m of agent.agentState.messages) {
    totalChars += m.textContent.length;
  }
  const approxTokens = Math.ceil(totalChars / 4);
  const pct = (approxTokens / model.context_window) * 100;

  if (pct < 80) return false;

  const before = agent.agentState.messages.length;
  agent.agentState.messages = compactMessages(agent, agent.agentState.messages);
  return agent.agentState.messages.length < before;
}
