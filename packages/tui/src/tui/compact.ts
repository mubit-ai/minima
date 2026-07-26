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
import { isTtsrReminder } from "../minima/ttsr.ts";
import type { ToolArtifacts } from "../tools/types.ts";

const KEEP_RECENT = 6;

export interface CompactResult {
  compacted: number;
  summary: string;
}

/** Serialize the pruned window to the parser-recoverable `compact/v1` framing: a header
 * line, then per message a delimiter line carrying role/tool/error/byte-length followed by
 * the verbatim textContent and a single newline. Recovery consumes exactly `bytes` per
 * body (never delimiter-scanning), so header-lookalike text, missing trailing newlines, and
 * multi-byte unicode all round-trip byte-exactly. */
function serializeCompaction(messages: Message[]): string {
  const lines: string[] = [`compact/v1 messages=${messages.length}`];
  messages.forEach((m, i) => {
    const tool = m.tool_name ? ` tool=${m.tool_name}` : "";
    const error = m.is_error ? " error" : "";
    const bytes = Buffer.byteLength(m.textContent, "utf8");
    lines.push(`--- msg ${i} role=${m.role}${tool}${error} bytes=${bytes} ---`);
    lines.push(m.textContent);
  });
  return `${lines.join("\n")}\n`;
}

/** Spill the serialized window through the attached artifact store as tool_name="compact",
 * inheriting the current-run GC exemption (the claim happens before any post-spill prune).
 * Fail-open: a null ref (store degraded) returns null so the caller emits the v1 summary —
 * never a pointer to an unwritten file. */
function spillCompaction(artifacts: ToolArtifacts, messages: Message[]): string | null {
  return artifacts.sink("compact")(serializeCompaction(messages))?.ref ?? null;
}

export function compactMessages(agent: MinimaAgent, messages: Message[]): Message[] {
  if (messages.length <= KEEP_RECENT + 2) return messages;

  const oldMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(-KEEP_RECENT);

  // TTSR (W4.2): harness-injected tripwire reminders in the old window are preserved verbatim
  // as active context rather than truncated into the summary — they are enforcement steers the
  // model must keep seeing across compaction.
  const preserved = oldMessages.filter((m) => isTtsrReminder(m.textContent));
  const summarizable = oldMessages.filter((m) => !isTtsrReminder(m.textContent));

  // Compaction v2 (W4.5): with the artifact store live and the flag on, spill the summarized
  // (lossy) window to a content-addressed artifact and name its path in the summary so any
  // pruned message is recoverable verbatim via read. Preserved TTSR reminders are kept in
  // context, so only `summarizable` needs artifact backing. A null store/flag-off/degraded
  // spill keeps the ref null → the summary is byte-identical to v1.
  const artifacts = agent.config?.compact2 !== false ? agent.artifacts : null;
  const ref = artifacts ? spillCompaction(artifacts, summarizable) : null;

  const summaryParts: string[] = [];
  summarizable.forEach((m, i) => {
    const tag = ref ? `${i}. ` : "";
    if (m.role === "user") {
      summaryParts.push(`${tag}User: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "assistant") {
      summaryParts.push(`${tag}Assistant: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "toolResult") {
      summaryParts.push(`${tag}Tool(${m.tool_name}): ${m.textContent.slice(0, 100)}`);
    }
  });

  const header = ref
    ? `[Compacted ${summarizable.length} messages — full transcript at ${ref}; read it with offset/limit to recover any message verbatim]`
    : `[Compacted ${summarizable.length} messages]`;
  const summaryText = `${header}\n${summaryParts.join("\n")}`;
  const summaryMsg = new AgentMessage({
    role: "user",
    content: summaryText,
  });

  return [summaryMsg, ...preserved, ...recentMessages];
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
