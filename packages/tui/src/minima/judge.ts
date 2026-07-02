/**
 * Quality judging for the Minima feedback loop.
 *
 * Port of minima_harness/minima/judge.py. A judge turns a model's output into a [0,1]
 * quality score. `grade` returns `number | null`: null means the judge ABSTAINS — it
 * could not produce a trustworthy score. Abstention is NOT a failure: feeding a
 * fabricated 0.0 or a neutral 0.5 into /v1/feedback poisons the learning loop, so the
 * caller records realized cost/latency but sends NO quality/outcome signal on abstention.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";

export const JUDGE_SYSTEM =
  "You grade an AI assistant's response to a task on a 0-10 scale: 10 excellent, " +
  "5 acceptable, 0 wrong. Judge correctness, completeness, and adherence to any rubric. " +
  "Reply with ONLY a single integer 0-10, nothing else.";

export interface QualityJudge {
  grade(
    task: string,
    output: string,
    opts?: { rubric?: string; expected?: string },
  ): Promise<number | null>;
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Wraps a qualityFn(output) -> number callable (the tasks/task_set convention). */
export class DeterministicJudge implements QualityJudge {
  constructor(private readonly fn: (output: string) => number) {}

  async grade(_task: string, output: string): Promise<number | null> {
    try {
      return clamp01(Number(this.fn(output)));
    } catch {
      return null;
    }
  }
}

/** Returns a fixed quality (or null to abstain). ConstJudge(null) = always abstain. */
export class ConstJudge implements QualityJudge {
  constructor(private readonly quality: number | null = 0.5) {}

  async grade(): Promise<number | null> {
    return this.quality !== null ? clamp01(this.quality) : null;
  }
}

/** Grades via a cheap independent model. 0-10 -> /10 -> clamp. */
export class LLMJudge implements QualityJudge {
  /** Why the last grade() abstained (null = it scored). Diagnostics only. */
  lastAbstainReason: string | null = null;

  constructor(
    private readonly model: Model,
    private readonly opts: { apiKey?: string; timeout?: number; retries?: number } = {},
  ) {}

  async grade(
    task: string,
    output: string,
    opts: { rubric?: string; expected?: string } = {},
  ): Promise<number | null> {
    let user = `TASK:\n${task.slice(0, 4000)}\n\nRESPONSE:\n${output.slice(0, 4000)}`;
    if (opts.rubric) user += `\n\nRUBRIC:\n${opts.rubric.slice(0, 1000)}`;
    if (opts.expected) user += `\n\nEXPECTED:\n${opts.expected.slice(0, 1000)}`;
    const options: Record<string, unknown> = {
      timeout: this.opts.timeout ?? 30,
      prompt_cache: false,
    };
    if (this.opts.apiKey) options.api_key = this.opts.apiKey;

    // A judge abstention drops a real learning signal, and single calls to a cheap model
    // flake (observed live: one transient failure -> judged=0 for the whole turn). Retry
    // transient failures once; NEVER retry a well-formed non-score reply (the model
    // declining to grade is a legitimate abstention, not noise).
    const attempts = 1 + Math.max(0, this.opts.retries ?? 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const resp = await complete(
          this.model,
          {
            system_prompt: JUDGE_SYSTEM,
            messages: [new Message({ role: "user", content: user })],
            tools: [],
          },
          { options },
        );
        if (resp.stop_reason === "error") {
          this.lastAbstainReason = resp.error_message || "judge provider error";
          continue; // transient-shaped: retry
        }
        const score = parseScore(resp.textContent);
        if (score === null) {
          this.lastAbstainReason = `unparseable judge reply: ${resp.textContent.slice(0, 60)}`;
          return null; // legitimate abstention — no retry
        }
        this.lastAbstainReason = null;
        return clamp01(score / 10);
      } catch (exc) {
        this.lastAbstainReason = exc instanceof Error ? exc.message : String(exc);
        // thrown = transport/timeout — retry
      }
    }
    return null;
  }
}

/** Extract a 0-10 integer score from the judge's reply; null when none is found. */
export function parseScore(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 0 && n <= 10) return n;
  }
  let m = t.match(/\b(\d+)\s*\/\s*10\b/);
  if (m && inRange(m[1])) return Number(m[1]);
  m = t.match(/(?:score|rating|grade)\D{0,5}(\d+)/i);
  if (m && inRange(m[1])) return Number(m[1]);
  const candidates = (t.match(/\d+/g) ?? []).map(Number).filter((x) => x >= 0 && x <= 10);
  return candidates.length ? candidates[candidates.length - 1]! : null;
}

function inRange(s: string | undefined): boolean {
  if (s === undefined) return false;
  const n = Number(s);
  return n >= 0 && n <= 10;
}
