/**
 * Context compaction — summarize old turns to free token budget.
 *
 * When context usage exceeds a threshold (default 80%), or on manual /compact,
 * older messages are replaced with a concise summary, keeping the most recent
 * turns intact for continuity.
 */

import { complete } from "../ai/stream.ts";
import type { Message, Model } from "../ai/types.ts";
import { Message as AgentMessage, AssistantMessage, text } from "../ai/types.ts";
import type { MinimaAgent } from "../minima/runtime.ts";
import { isTtsrReminder } from "../minima/ttsr.ts";
import type { ToolArtifacts } from "../tools/types.ts";

const KEEP_RECENT = 6;

/** Serialized-window chars fed to the summarizer when the meta model reports no window.
 * Chars ≈ tokens × 4 — the same basis as approxContextTokens and the 80% auto threshold. */
const SUMMARY_INPUT_CHARS_FALLBACK = 200_000;

/** Tool payloads longer than this reach the summarizer as head + tail around an elision
 * marker. The artifact holds every byte, so nothing becomes unrecoverable — this only stops
 * one grep dump from crowding the user/assistant turns out of the input budget. */
const TOOL_ELIDE_CHARS = 2_000;
const TOOL_ELIDE_HEAD = 1_200;
const TOOL_ELIDE_TAIL = 600;

/** Cap on the carried-forward anchor when compactions chain. */
const PRIOR_SUMMARY_CHARS = 8_000;

/** Opening of every summary message assemble() emits — also how a LATER compaction
 * recognizes an earlier one in its own window (the anchor of the compaction chain). */
const SUMMARY_HEADER_PREFIX = "[Compacted ";

/**
 * The structured template. Freeform "write a summary" prompts measure poorly on exactly the
 * thing a coding continuation needs most — artifact tracking (which files, which paths, what
 * changed) — while explicit-section templates beat them on technical specificity. Hence the
 * five fixed headings and the extra weight on the file section. Sections are never parsed:
 * the reply is used as-is, so a model that ignores the format degrades the summary's shape
 * but can never fail the compaction.
 */
const SUMMARIZE_SYSTEM =
  "You are compacting an engineering session. Everything in <transcript> is about to be " +
  "deleted from the assistant's context and replaced by what you write, so the assistant must " +
  "be able to carry on from your summary alone.\n\n" +
  "When a <previous_summary> is present it is the compacted record of even older turns. Carry " +
  "every fact in it forward unless the transcript supersedes it. Never drop a path, a decision " +
  "or an open thread merely because it is old.\n\n" +
  "Reply with exactly these five sections, each heading on its own line, and nothing else:\n" +
  "## Intent — what the user asked for, in their terms, with any constraints or preferences " +
  "they stated.\n" +
  "## Files — every file, symbol and artifact read or changed, by exact path, and what changed " +
  "in each. Continuations need this section most and summaries lose it most: be exhaustive and " +
  "literal, never 'various files'.\n" +
  "## Decisions — choices made and the reason for each, including options rejected and why.\n" +
  "## State — what is done and verified, commands run and their outcomes, what is currently " +
  "failing or broken.\n" +
  "## Next — what remains, in the order it should be tackled.\n\n" +
  "Prefer concrete paths, names, numbers and commands over prose. Write 'none' under a heading " +
  "with nothing to report. Do not invent anything absent from the input, and do not address the " +
  "user — this is context, not a reply.";

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

interface Split {
  /** TTSR reminders from the old window — kept verbatim, never summarized. */
  preserved: Message[];
  /** The lossy window: what gets spilled to an artifact and summarized. */
  summarizable: Message[];
  /** The intact tail. */
  recent: Message[];
}

/** Choose the cut. null = nothing to compact. */
function splitForCompaction(messages: Message[]): Split | null {
  if (messages.length <= KEEP_RECENT + 2) return null;

  // Never cut between an assistant's toolCall and its toolResult: a kept tail that OPENS
  // with a toolResult carries a tool_use_id whose owning message was just summarized away,
  // and the provider rejects the next request ("tool_use ids were not found"). Every later
  // prompt replays the same broken history, so the session is wedged until /clear — which
  // discards exactly what the user compacted to keep. Walk the split BACK onto the owning
  // assistant (keeping the whole round) rather than forward past the orphans, which would
  // empty the kept window whenever KEEP_RECENT trailing messages are all tool results. A
  // `while`, not an `if`: parallel tool calls put N consecutive toolResults under one
  // assistant.
  let cut = messages.length - KEEP_RECENT;
  while (cut > 0 && messages[cut]!.role === "toolResult") cut--;

  const oldMessages = messages.slice(0, cut);

  // TTSR (W4.2): harness-injected tripwire reminders in the old window are preserved verbatim
  // as active context rather than truncated into the summary — they are enforcement steers the
  // model must keep seeing across compaction.
  return {
    preserved: oldMessages.filter((m) => isTtsrReminder(m.textContent)),
    summarizable: oldMessages.filter((m) => !isTtsrReminder(m.textContent)),
    recent: messages.slice(cut),
  };
}

/** Compaction v2 (W4.5): with the artifact store live and the flag on, spill the summarized
 * (lossy) window to a content-addressed artifact so any pruned message is recoverable verbatim
 * via read. Preserved TTSR reminders stay in context, so only `summarizable` needs artifact
 * backing. A null store/flag-off/degraded spill keeps the ref null → the summary is
 * byte-identical to v1. */
function spillFor(agent: MinimaAgent, summarizable: Message[]): string | null {
  const artifacts = agent.config?.compact2 !== false ? agent.artifacts : null;
  return artifacts ? spillCompaction(artifacts, summarizable) : null;
}

/** The offline summary body: every message clipped to its first 200 chars (100 for tool
 * results). Numbered to the artifact's message indices when a ref backs the window. */
function truncatedBody(summarizable: Message[], numbered: boolean): string {
  const summaryParts: string[] = [];
  summarizable.forEach((m, i) => {
    const tag = numbered ? `${i}. ` : "";
    if (m.role === "user") {
      summaryParts.push(`${tag}User: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "assistant") {
      summaryParts.push(`${tag}Assistant: ${m.textContent.slice(0, 200)}`);
    } else if (m.role === "toolResult") {
      summaryParts.push(`${tag}Tool(${m.tool_name}): ${m.textContent.slice(0, 100)}`);
    }
  });
  return summaryParts.join("\n");
}

/** Build the replacement message list: summary + preserved reminders + intact tail. The
 * header names the artifact when one backs the window — that line is the escape hatch for
 * anything the body drops, so it is identical whichever body was produced. */
function assemble(split: Split, ref: string | null, body: string): Message[] {
  const header = ref
    ? `${SUMMARY_HEADER_PREFIX}${split.summarizable.length} messages — full transcript at ${ref}; read it with offset/limit to recover any message verbatim]`
    : `${SUMMARY_HEADER_PREFIX}${split.summarizable.length} messages]`;
  const summaryMsg = new AgentMessage({
    role: "user",
    content: `${header}\n${body}`,
  });

  return [summaryMsg, ...split.preserved, ...split.recent];
}

export function compactMessages(agent: MinimaAgent, messages: Message[]): Message[] {
  const split = splitForCompaction(messages);
  if (!split) return messages;
  const ref = spillFor(agent, split.summarizable);
  return assemble(split, ref, truncatedBody(split.summarizable, ref !== null));
}

export interface CompactLLMOptions {
  /** The cheap meta model. null → deterministic truncation, same as the sync path. */
  model: Model | null;
  signal?: AbortSignal | null;
  /** Realized spend of the summarizer call — the caller books it (meter + budget). */
  onCostUsd?: (usd: number) => void;
  /** Injectable for tests; defaults to the real ai/stream complete(). */
  completeFn?: typeof complete;
}

/** True for a summary emitted by an EARLIER compaction of this same session. */
function isPriorSummary(content: string): boolean {
  return content.startsWith(SUMMARY_HEADER_PREFIX);
}

function elideToolBody(body: string): string {
  if (body.length <= TOOL_ELIDE_CHARS) return body;
  const dropped = body.length - TOOL_ELIDE_HEAD - TOOL_ELIDE_TAIL;
  return `${body.slice(0, TOOL_ELIDE_HEAD)}\n[... ${dropped} chars elided — full text in the artifact ...]\n${body.slice(-TOOL_ELIDE_TAIL)}`;
}

/**
 * Structural reduction of the summarizer's INPUT ONLY — no model, no tokens, no measurable
 * laptop cost, and reported at 10–30% off the window on its own. Three passes, all of them
 * the local analogue of what provider-side tool-result clearing does:
 *
 *   - supersede: an identical earlier result from the same tool is re-fetchable noise once a
 *     later copy exists, so only the last copy keeps its body;
 *   - resolve: a failed call that a later call from the same tool succeeded at is a dead end
 *     the summary should not relitigate;
 *   - elide: oversized payloads keep a head and a tail around a marker.
 *
 * Applied strictly downstream of the artifact spill, so the recoverable record stays byte-
 * exact and every reduction here is reversible via the ref in the summary header. Buying the
 * budget back matters more than the raw saving: a single grep dump can otherwise crowd out
 * the user turns that actually carry intent.
 */
function reduceForSummary(messages: Message[]): Message[] {
  const lastIdentical = new Map<string, number>();
  const lastOk = new Map<string, number>();
  const key = (m: Message) => `${m.tool_name ?? ""} ${m.textContent}`;

  messages.forEach((m, i) => {
    if (m.role !== "toolResult") return;
    lastIdentical.set(key(m), i);
    if (!m.is_error) lastOk.set(m.tool_name ?? "", i);
  });

  return messages.map((m, i) => {
    if (m.role !== "toolResult") return m;
    const tool = m.tool_name ?? "tool";
    let body: string;
    if (lastIdentical.get(key(m)) !== i) {
      body = `[superseded: identical ${tool} output repeated later in this window]`;
    } else if (m.is_error && (lastOk.get(m.tool_name ?? "") ?? -1) > i) {
      body = `[resolved: ${tool} failed here; a later ${tool} call succeeded]`;
    } else {
      body = elideToolBody(m.textContent);
    }
    return body === m.textContent
      ? m
      : new AgentMessage({
          role: m.role,
          content: body,
          tool_name: m.tool_name,
          is_error: m.is_error,
        });
  });
}

/**
 * Build the summarizer's user message: reduce, then split off any summary an earlier
 * compaction left in this window and hoist it into its own anchor block.
 *
 * Sessions do not compact once — a long one compacts ten times or more, each pass summarizing
 * the last pass's output. Left inline the anchor is just another turn competing for attention
 * and the chain erodes a little every round; hoisted and named, the model is told explicitly
 * to carry it forward, which is what keeps early decisions alive at compaction number ten.
 */
function buildSummaryPrompt(summarizable: Message[], model: Model): string {
  const reduced = reduceForSummary(summarizable);
  const prior = reduced.filter((m) => isPriorSummary(m.textContent));
  const turns = reduced.filter((m) => !isPriorSummary(m.textContent));
  const transcript = `<transcript>\n${capForModel(serializeCompaction(turns), model)}\n</transcript>`;
  if (prior.length === 0) return transcript;
  const anchor = prior
    .map((m) => m.textContent)
    .join("\n\n")
    .slice(0, PRIOR_SUMMARY_CHARS);
  return `<previous_summary>\n${anchor}\n</previous_summary>\n\n${transcript}`;
}

/** Cap the serialized window to what the summarizer can hold, keeping the TAIL — the turns
 * nearest the surviving context — and marking the drop so the model knows it is partial. */
function capForModel(serialized: string, model: Model): string {
  const budget = model.context_window
    ? Math.floor(model.context_window * 2)
    : SUMMARY_INPUT_CHARS_FALLBACK;
  if (serialized.length <= budget) return serialized;
  const dropped = serialized.length - budget;
  return `[... ${dropped} earlier bytes of this window truncated ...]\n${serialized.slice(-budget)}`;
}

/** One completion over the window. null = unusable (no model, abort, error reply, empty
 * reply, thrown call) → the caller falls back to the offline body. */
async function summarizeWindow(
  summarizable: Message[],
  opts: CompactLLMOptions,
): Promise<string | null> {
  if (!opts.model || summarizable.length === 0 || opts.signal?.aborted) return null;
  const run = opts.completeFn ?? complete;
  try {
    const resp = await run(
      opts.model,
      {
        system_prompt: SUMMARIZE_SYSTEM,
        messages: [
          new AgentMessage({
            role: "user",
            content: buildSummaryPrompt(summarizable, opts.model),
          }),
        ],
        tools: [],
      },
      {
        options: { timeout: 60, prompt_cache: false },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    try {
      const usd = resp.usage.cost.total;
      opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break a compaction
    }
    if (resp.stop_reason === "error") return null;
    const summary = resp.textContent.trim();
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

/**
 * Manual /compact: summarize the pruned window with one cheap completion fed the FULL
 * verbatim messages, instead of the 200-char-per-message clipping the sync path summarizes
 * from. Fail-open in every direction — no model, an abort, an error or empty reply, or a
 * thrown call all fall back to `truncatedBody`, so /compact can never come out worse than it
 * was. The cut, the TTSR preservation and the artifact ref are identical on both paths.
 *
 * Deliberately NOT wired into maybeAutoCompact: auto fires at 80% mid-turn inside the agent
 * loop, where a network call that hangs or fails would gate the next request. Truncation is
 * the right tool for that slot.
 */
export async function compactMessagesLLM(
  agent: MinimaAgent,
  messages: Message[],
  opts: CompactLLMOptions,
): Promise<Message[]> {
  const split = splitForCompaction(messages);
  if (!split) return messages;
  const ref = spillFor(agent, split.summarizable);
  const body =
    (await summarizeWindow(split.summarizable, opts)) ??
    truncatedBody(split.summarizable, ref !== null);
  return assemble(split, ref, body);
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
