/**
 * /summarise — one cheap completion that says what the agent actually did over the last N
 * turns. A turn is one user prompt plus everything the agent did in response, so the digest
 * is built from computeSections() over the lead Message[]: prompt, tool-call labels, failing
 * tool results, the closing reply, and the section's realized cost.
 *
 * Fail-open everywhere: no model, an abort, or an unusable reply means the caller prints the
 * deterministic digest instead — the command never errors out.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model, isAssistant } from "../ai/types.ts";
import { computeSections } from "../session/sections.ts";
import { formatActionLabel } from "../tui/permissions.ts";
import { sanitizeForObserver } from "./observer.ts";

const PROMPT_CAP = 300;
const REPLY_CAP = 500;
const ERROR_CAP = 200;
const ACTIONS_MAX = 12;
const ERRORS_MAX = 5;

export interface TurnDigest {
  /** 1-based within the window, oldest first. */
  index: number;
  prompt: string;
  /** `tool: arg summary` per tool call, in call order. */
  actions: string[];
  errors: string[];
  reply: string;
  costUSD: number;
}

const clip = (s: string, max: number): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/** Pure roll-up of the last `n` real user turns. `toolFees` joins booked provider fees. */
export function buildTurnDigests(
  messages: Message[],
  n = 5,
  toolFees?: ReadonlyMap<string, number>,
): TurnDigest[] {
  const sections = computeSections(messages, { toolFees })
    .sections // drop the synthetic "(session start)" section — only real prompts are turns
    .filter((s) => messages[s.startMsgIdx]?.role === "user")
    .slice(-Math.max(1, n));

  return sections.map((s, i) => {
    const actions: string[] = [];
    const errors: string[] = [];
    let reply = "";
    for (let j = s.startMsgIdx; j <= s.endMsgIdx; j++) {
      const msg = messages[j]!;
      if (isAssistant(msg)) {
        for (const call of msg.toolCalls) {
          if (actions.length < ACTIONS_MAX)
            actions.push(formatActionLabel(call.name, call.arguments));
        }
        const t = msg.textContent.trim();
        if (t) reply = t;
      } else if (msg.role === "toolResult" && msg.is_error && errors.length < ERRORS_MAX) {
        errors.push(clip(`${msg.tool_name ?? "tool"}: ${msg.textContent}`, ERROR_CAP));
      }
    }
    return {
      index: i + 1,
      prompt: clip(messages[s.startMsgIdx]!.textContent, PROMPT_CAP),
      actions,
      errors,
      reply: clip(reply, REPLY_CAP),
      costUSD: s.usage.costUSD,
    };
  });
}

/** Deterministic render — both the fallback output and the summariser's input. */
export function formatDigest(turns: TurnDigest[]): string {
  return turns
    .map((t) => {
      const lines = [`${t.index}. ${t.prompt || "(empty prompt)"}  ~$${t.costUSD.toFixed(4)}`];
      for (const a of t.actions) lines.push(`   ↳ ${a}`);
      for (const e of t.errors) lines.push(`   ✗ ${e}`);
      if (t.reply) lines.push(`   = ${t.reply}`);
      return lines.join("\n");
    })
    .join("\n");
}

export const SUMMARISE_SYSTEM =
  "You summarise what an autonomous coding agent did over its last few turns. You get one " +
  "numbered block per turn: the user's prompt, the tools it ran, any tool failures, and its " +
  "closing reply. Reply with at most one bullet per turn, in the same order, each naming what " +
  "was done and whether it worked. End with a single line starting 'Open:' naming what is " +
  "still unresolved, or 'Open: nothing' if the work landed clean. Do not restate the prompts " +
  "verbatim, do not give advice, do not suggest next steps.";

export function buildSummarisePrompt(turns: TurnDigest[]): string {
  return `Turns to summarise:\n${sanitizeForObserver(formatDigest(turns))}`;
}

export interface SummariseOptions {
  metaModel: Model | null;
  turns: TurnDigest[];
  signal?: AbortSignal | null;
  /** Realized spend of the summariser call — the caller books it (meter + budget). */
  onCostUsd?: (usd: number) => void;
  /** Injectable for tests; defaults to the real ai/stream complete(). */
  completeFn?: typeof complete;
}

/** null = skipped/unusable (no model, no turns, abort, error) — caller falls back. */
export async function runSummarise(opts: SummariseOptions): Promise<string | null> {
  if (!opts.metaModel || opts.turns.length === 0 || opts.signal?.aborted) return null;
  const run = opts.completeFn ?? complete;
  try {
    const resp = await run(
      opts.metaModel,
      {
        system_prompt: SUMMARISE_SYSTEM,
        messages: [new Message({ role: "user", content: buildSummarisePrompt(opts.turns) })],
        tools: [],
      },
      { options: { timeout: 30, prompt_cache: false } },
    );
    try {
      const usd = resp.usage.cost.total;
      opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break the summary
    }
    if (resp.stop_reason === "error") return null;
    return resp.textContent.trim() || null;
  } catch {
    return null;
  }
}
