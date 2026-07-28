/**
 * Expected output-token estimate for a routed prompt.
 *
 * The server prices every candidate as `input_cost * expected_input + output_cost *
 * expected_output` and then picks the CHEAPEST candidate clearing tau. The harness has always
 * sent a real `expected_input_tokens` but never an output figure, so the server fell back to
 * `MINIMA_DEFAULT_OUTPUT_TOKENS (500) * difficulty_multiplier` — and because agent traffic
 * classifies as `medium` almost every time (multiplier 1.0), that fallback was a CONSTANT.
 * A constant output term makes the cost ordering identical on every turn, which is a large
 * part of why the pick never varied.
 *
 * The quantity estimated here is deliberately the same one feedback reports: run-TOTAL output
 * tokens summed over every turn of a rung (runtime.ts `usageSince`). That matters because turn
 * count, not per-turn verbosity, is the dominant term — a one-shot answer and a 24-turn tool
 * loop differ by ~100x, and the flat 500 modelled both identically.
 *
 * Estimate = winsorized mean of recent realized runs for this project. The MEAN (not the
 * median) is correct because cost is linear in tokens, so the expected cost is driven by the
 * mean; winsorizing at the p90 keeps a long multi-turn tail counted at a bounded value instead
 * of letting one runaway run dominate a short window.
 */

/** Realized runs consulted, newest first. */
export const ESTIMATE_WINDOW = 20;
/** Below this the sample is too thin to beat the cold-start constant. */
export const MIN_SAMPLES = 3;
/** Upper winsorization quantile — the tail is counted, but capped. */
export const WINSOR_Q = 0.9;
/**
 * Estimate used until this project has `MIN_SAMPLES` realized runs.
 *
 * Above the server's flat 500 on purpose: this estimates a run TOTAL across turns, whereas
 * 500 was calibrated as a single completion. It is a starting point only — three real runs
 * replace it with observed behaviour.
 */
export const COLD_START_OUTPUT_TOKENS = 700;
/** Clamp: guards against a degenerate sample driving a nonsense estimate either way. */
export const MIN_OUTPUT_TOKENS = 128;
export const MAX_OUTPUT_TOKENS = 32_768;

/** Value at quantile `q` of an ASCENDING-sorted array (nearest-rank). */
function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Winsorized mean of realized run-total output tokens, or the cold-start constant when the
 * sample is too thin. Always clamped to [MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS].
 */
export function estimateOutputTokens(
  samples: readonly number[],
  coldStart: number = COLD_START_OUTPUT_TOKENS,
): number {
  const usable = samples.filter((n) => Number.isFinite(n) && n > 0);
  if (usable.length < MIN_SAMPLES) return clamp(coldStart);
  const sorted = [...usable].sort((a, b) => a - b);
  const cap = quantile(sorted, WINSOR_Q);
  const total = sorted.reduce((acc, n) => acc + Math.min(n, cap), 0);
  return clamp(Math.round(total / sorted.length));
}

function clamp(n: number): number {
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, Math.round(n)));
}

/** Ledger reader shape the estimator needs (MinimaDb.recentOutputTokens). */
export interface OutputTokenSource {
  recentOutputTokens(projectKey: string, limit: number, taskType?: string | null): number[];
}

/**
 * Project-scoped estimate, preferring same-task-type history when it is thick enough and
 * falling back to the project's overall turn shape otherwise.
 *
 * Fail-open: any ledger error yields the cold-start constant — an estimate is an optimization,
 * never a reason to fail a turn.
 */
export function estimateOutputTokensFor(
  db: OutputTokenSource,
  projectKey: string,
  taskType?: string | null,
): number {
  try {
    if (taskType) {
      const typed = db.recentOutputTokens(projectKey, ESTIMATE_WINDOW, taskType);
      if (typed.length >= MIN_SAMPLES) return estimateOutputTokens(typed);
    }
    return estimateOutputTokens(db.recentOutputTokens(projectKey, ESTIMATE_WINDOW));
  } catch {
    return COLD_START_OUTPUT_TOKENS;
  }
}
