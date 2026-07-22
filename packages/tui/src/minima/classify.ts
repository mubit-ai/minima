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
import { Message, type Model } from "../ai/types.ts";
import { DIFFICULTIES, type Difficulty, TASK_TYPES, type TaskType } from "./schemas.ts";

/** Overrides below this confidence are dropped (the server heuristic applies). */
export const CLASSIFY_CONFIDENCE_FLOOR = 0.6;

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

function fromParts(t: unknown, d: unknown, c: unknown): TaskClassification | null {
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
    } = {},
  ) {}

  private bookCost(usd: number): void {
    try {
      this.opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hook must never break classification
    }
  }

  async classify(task: string): Promise<TaskClassification | null> {
    const key = Bun.hash(task).toString(36);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    try {
      const resp = await complete(
        this.model,
        {
          system_prompt: CLASSIFY_SYSTEM,
          messages: [new Message({ role: "user", content: task.slice(0, 8000) })],
          tools: [],
        },
        { options: { timeout: this.opts.timeout ?? CLASSIFY_TIMEOUT_S, prompt_cache: false } },
      );
      this.bookCost(resp.usage.cost.total);
      if (resp.stop_reason === "error") return null; // transient — not cached, retryable
      const cls = parseClassification(resp.textContent);
      this.cache.set(key, cls);
      return cls;
    } catch {
      this.bookCost(0);
      return null; // transport/timeout — fail-open, not cached
    }
  }
}
