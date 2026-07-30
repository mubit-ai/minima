/**
 * Client-side task classification (MINIMA_TUI_CLASSIFY=1, default OFF).
 *
 * One cheap completion labels an interactive lead prompt with task_type / difficulty /
 * confidence before routing. The label rides the caller-override wire seam (the server's
 * classify.py honors caller task_type/difficulty absolutely), plus a diagnostic
 * task_type_confidence so caller-labeled rows can be segmented server-side. Everything
 * fails open: unparseable reply, low confidence, timeout, or a thrown provider error all
 * mean NO override — the server's heuristic applies unchanged. Results are cached
 * in-memory per session keyed by a hash of the task text (deliberately no SQLite
 * migration — v15/v16 are owned by the unmerged observer stack). Spend books to the
 * session wallet like judge spend, never into feedback's actual_cost_usd.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model, type StopReason } from "../ai/types.ts";
import { DIFFICULTIES, type Difficulty, TASK_TYPES, type TaskType } from "./schemas.ts";

/** Overrides below this confidence are dropped (the server heuristic applies).
 * Raised 0.6 -> 0.75 (classifier program PR-7): with the server embed head shipping,
 * a caller override stomps a calibrated classifier — only high-confidence client
 * labels should win. */
export const CLASSIFY_CONFIDENCE_FLOOR = 0.75;

/** Bounded: a slow classifier must never stall the routing phase. */
const CLASSIFY_TIMEOUT_S = 5;

export const CLASSIFY_SYSTEM = [
  "You label a task for LLM model routing. Reply with ONLY one line of minified JSON,",
  'no prose: {"task_type":<type>,"difficulty":<difficulty>,"confidence":<0-1>}.',
  `task_type is one of: ${TASK_TYPES.join(", ")}.`,
  `difficulty is one of: ${DIFFICULTIES.join(", ")}.`,
  "confidence is how sure you are of BOTH labels.",
].join(" ");

export interface TaskClassification {
  taskType: TaskType;
  difficulty: Difficulty;
  confidence: number;
}

/**
 * Admit three loose parts as a classification, or refuse them.
 *
 * Exported because a DURABLE cache of classifications has to re-admit its own rows on the way out
 * (MUB-218): `TASK_TYPES` and `DIFFICULTIES` can change, and a row written under an older taxonomy
 * would otherwise reconstitute as a task type that no longer exists and be scored against a
 * reference label as merely wrong. Re-admitting through THIS function rather than a second copy of
 * its rules is what keeps the stored form and the parsed form the same thing.
 */
export function classificationFromParts(
  t: unknown,
  d: unknown,
  c: unknown,
): TaskClassification | null {
  const taskType =
    typeof t === "string" && (TASK_TYPES as readonly string[]).includes(t) ? (t as TaskType) : null;
  const difficulty =
    typeof d === "string" && (DIFFICULTIES as readonly string[]).includes(d)
      ? (d as Difficulty)
      : null;
  const confidence = typeof c === "number" ? c : typeof c === "string" ? Number(c) : Number.NaN;
  if (!taskType || !difficulty) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { taskType, difficulty, confidence };
}

const fromParts = classificationFromParts;

/**
 * What one classify call amounted to, for a caller that needs to tell the causes apart.
 *
 * `classify()` returns `TaskClassification | null` and that is the right shape for routing, where
 * every non-answer means the same thing: fail open, no override. It is the wrong shape for anything
 * that CACHES the answer, because a null has three causes and they cache differently — a reply that
 * would not parse is deterministic for this (model, prompt) and can be stored, while a provider
 * error and a transport failure are transient and must be retried. Collapsing them writes a
 * permanent non-answer for a prompt that was merely unlucky.
 *
 * `stopReason` rides along on the two arms that saw a complete response, because a durable cache may
 * additionally refuse to store an answer the model was cut off part-way through — `length` reaches
 * this class through a `max_tokens` a caller set, and a truncated reply is not evidence about the
 * model's opinion.
 */
export type ClassifyOutcome =
  | {
      readonly kind: "labelled";
      readonly classification: TaskClassification;
      readonly stopReason: StopReason;
    }
  /** A complete reply that would not parse. Deterministic — `classify` memoizes this. */
  | { readonly kind: "unusable"; readonly stopReason: StopReason }
  /** The provider reported an error. Transient — `classify` does NOT memoize it. */
  | { readonly kind: "provider-error" }
  /** The call threw: transport failure, or the timeout. Transient, and not memoized either. */
  | { readonly kind: "transport-error" };

/** Parse the classifier's reply — tiny JSON first, three labeled lines as a fallback.
 * Fail-closed: anything unparseable → null (no override). */
export function parseClassification(raw: string): TaskClassification | null {
  const text = raw.trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const cls = fromParts(obj.task_type, obj.difficulty, obj.confidence);
      if (cls) return cls;
    } catch {
      // fall through to the line format
    }
  }
  const line = (label: string): string | null => {
    const m = text.match(new RegExp(`${label}\\s*[:=]\\s*([\\w.\\-]+)`, "i"));
    return m ? m[1]! : null;
  };
  return fromParts(line("task_type"), line("difficulty"), line("confidence"));
}

export class TaskClassifier {
  /** Per-session memo: task-text hash → result (null = a deliberate non-answer). */
  private readonly cache = new Map<string, TaskClassification | null>();

  constructor(
    private readonly model: Model,
    private readonly opts: {
      timeout?: number;
      /** Realized spend of each classify complete() (0 on throw) — the caller books it
       * to the wallet (meter overhead + budget), like judge spend. */
      onCostUsd?: (usd: number) => void;
      /** What the call amounted to, for a caller that must not collapse the causes of a
       * null (MUB-218). Same shape and same guarantees as `onCostUsd`: purely observational,
       * never consulted, and a throw from it cannot break classification. Fires once per call
       * that was actually made — a memo hit reports nothing, because nothing happened. */
      onOutcome?: (outcome: ClassifyOutcome) => void;
      /** Output cap for the completion. Undefined — the default, and what routing uses — is
       * passed straight through, so providers fall back to `model.max_tokens` exactly as before.
       * A BATCH caller sets it: this classifier is bounded by nothing but the model's own
       * ceiling (8192+ tokens against a ~40-token label), which is a rounding error on one
       * interactive turn and real money over a few hundred. See MUB-218's replay. */
      maxTokens?: number;
    } = {},
  ) {}

  private bookCost(usd: number): void {
    try {
      this.opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hook must never break classification
    }
  }

  private report(outcome: ClassifyOutcome): void {
    try {
      this.opts.onOutcome?.(outcome);
    } catch {
      // observability must never break classification
    }
  }

  async classify(task: string, contextTokens?: number): Promise<TaskClassification | null> {
    const key = Bun.hash(task).toString(36);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const sizeHint =
      contextTokens && contextTokens > 0
        ? `\n\n[session context: ~${contextTokens} tokens already in play — scope, not prompt length, drives difficulty]`
        : "";
    try {
      const resp = await complete(
        this.model,
        {
          system_prompt: CLASSIFY_SYSTEM,
          messages: [new Message({ role: "user", content: task.slice(0, 8000) + sizeHint })],
          tools: [],
        },
        {
          options: {
            timeout: this.opts.timeout ?? CLASSIFY_TIMEOUT_S,
            prompt_cache: false,
            // Undefined by default, and every provider reads it as `options.max_tokens ??
            // model.max_tokens` — so the routing path's request is byte-identical to before.
            max_tokens: this.opts.maxTokens,
          },
        },
      );
      this.bookCost(resp.usage.cost.total);
      if (resp.stop_reason === "error") {
        this.report({ kind: "provider-error" });
        return null; // transient — not cached, retryable
      }
      const cls = parseClassification(resp.textContent);
      this.report(
        cls
          ? { kind: "labelled", classification: cls, stopReason: resp.stop_reason }
          : { kind: "unusable", stopReason: resp.stop_reason },
      );
      this.cache.set(key, cls);
      return cls;
    } catch {
      this.bookCost(0);
      this.report({ kind: "transport-error" });
      return null; // transport/timeout — fail-open, not cached
    }
  }
}
