/**
 * Planning Critic (E1) — one cheap completion at plan approval that reviews the finalized
 * steps' verify commands for discriminative power (would the check have been RED before
 * the work?) and hidden inter-step dependencies. Flags only: it never edits the plan,
 * never blocks finalize (the deterministic plan_lint audit owns blockers) — its findings
 * ride the same advisory note. Fail-open everywhere: no model, an abort, an unusable
 * reply, or a thrown call all mean "no flags", never a broken finalize.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";

export const PLAN_CRITIC_SYSTEM =
  "You review an engineering plan's acceptance checks before work starts. For each step " +
  "you get its action and its `verify` shell command. Hunt for exactly two defect kinds: " +
  "(1) NON-DISCRIMINATIVE checks — commands that would already pass BEFORE the work is " +
  "done (a bare build/lint on an already-green repo, `echo ok`, a test file the plan " +
  "does not create or change), so a pass proves nothing about the step; " +
  "(2) HIDDEN DEPENDENCIES — a step whose check can only pass after a LATER step runs, " +
  "or two steps that silently edit the same artifact. Do not restate the plan, do not " +
  "invent style feedback. Reply EXACTLY one of: the single word OK (no findings), or a " +
  'line "FLAGS:" followed by one "- step N: finding" bullet per defect (at most 6).';

/** The critic's user message: numbered steps with their checks. */
export function buildCriticPrompt(steps: { action: string; verify?: string | null }[]): string {
  const lines = steps.map(
    (s, i) => `${i + 1}. ${s.action.trim()}\n   verify: ${s.verify?.trim() || "(none)"}`,
  );
  return `Plan steps and their acceptance checks:\n${lines.join("\n")}`;
}

/**
 * Parse the critic's reply. [] = explicit OK; a bullet list = flags; null = unusable
 * (skip silently — an unparseable critic must never inject noise into the audit note).
 */
export function parseCriticFlags(text: string): string[] | null {
  const trimmed = text.trim();
  if (/^OK\b/i.test(trimmed)) return [];
  if (!/^\s*FLAGS:/im.test(trimmed)) return null;
  const flags: string[] = [];
  let inFlags = false;
  for (const line of trimmed.split(/\r?\n/)) {
    if (/^\s*FLAGS:\s*$/i.test(line) || /^\s*FLAGS:\s*\S/.test(line)) {
      inFlags = true;
      const inline = line.replace(/^\s*FLAGS:\s*/i, "").trim();
      if (inline) flags.push(inline.slice(0, 200));
      continue;
    }
    const bullet = /^\s*[-•]\s+(.*\S)/.exec(line);
    if (inFlags && bullet) flags.push(bullet[1]!.slice(0, 200));
    if (flags.length >= 6) break;
  }
  return flags;
}

export interface PlanCriticOptions {
  metaModel: Model | null;
  steps: { action: string; verify?: string | null }[];
  signal?: AbortSignal | null;
  /** Realized spend of the critic call — the caller books it (meter + budget). */
  onCostUsd?: (usd: number) => void;
  /** Injectable for tests; defaults to the real ai/stream complete(). */
  completeFn?: typeof complete;
}

/** Run the critic. null = skipped/unusable (no model, abort, error); [] = explicit OK. */
export async function runPlanCritic(opts: PlanCriticOptions): Promise<string[] | null> {
  if (!opts.metaModel || opts.steps.length === 0 || opts.signal?.aborted) return null;
  const run = opts.completeFn ?? complete;
  try {
    const resp = await run(
      opts.metaModel,
      {
        system_prompt: PLAN_CRITIC_SYSTEM,
        messages: [new Message({ role: "user", content: buildCriticPrompt(opts.steps) })],
        tools: [],
      },
      { options: { timeout: 30, prompt_cache: false } },
    );
    try {
      const usd = resp.usage.cost.total;
      opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break the critique
    }
    if (resp.stop_reason === "error") return null;
    return parseCriticFlags(resp.textContent);
  } catch {
    return null;
  }
}

/** Format flags for the finalize note ("" when nothing to say). */
export function formatCriticNote(flags: string[] | null): string {
  if (!flags || flags.length === 0) return "";
  return `\n\n🧭 Planning critic (advisory — checks reviewed before work starts):\n${flags
    .map((f) => `  - ${f}`)
    .join("\n")}`;
}
