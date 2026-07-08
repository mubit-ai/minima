/**
 * Harness configuration: where Minima lives, the candidate pool, and judge policy.
 *
 * Port of the Python harness's minima/config.py. Defaults target the hosted Minima so a
 * fresh install works once MUBIT_API_KEY + a provider key are set; for local dev set
 * MINIMA_URL=http://localhost:8080.
 */

export const DEFAULT_MINIMA_URL = "https://api.minima.sh";
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

// Candidate set mirrors examples/agent_warmup.py so cold-start routing matches.
export const DEFAULT_CANDIDATES: string[] = [
  "gemini-2.5-flash",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "gemini-2.5-pro",
  "claude-opus-4-8",
];

export interface HarnessConfig {
  minimaUrl: string;
  minimaApiKey: string | null;
  /** Model ids Minima is allowed to pick from (-> Constraints.candidate_models). */
  candidates: string[];
  /** True when the user pinned a single model via /model: routing is bypassed. */
  pinned: boolean;
  /** Memory isolation lane (-> namespace). null = default lane. */
  namespace: string | null;
  /** Stable per-actor recall id (-> recommend user_id). Prod memory recall is scoped by
   * user_id; without it the server surfaces nothing, so decision_basis never leaves
   * `prior`. Set to the same stable id as the memory session (namespace ?? repo identity)
   * so a run recalls its own prior outcomes. null = omit (recall stays empty). */
  memorySession: string | null;
  /** cost/quality slider: 0=cheapest acceptable, 10=highest quality. */
  costQualityTradeoff: number;
  judgeModel: string;
  /** Judge every Nth terminal turn (1 = every turn). 0 disables judging. */
  judgeEvery: number;
  baselineModelId: string | null;
  timeout: number;
  allowOffline: boolean;
  cacheEnabled: boolean;
  cacheThreshold: number;
}

export function harnessConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    minimaUrl: DEFAULT_MINIMA_URL,
    minimaApiKey: null,
    candidates: [...DEFAULT_CANDIDATES],
    pinned: false,
    namespace: null,
    memorySession: null,
    costQualityTradeoff: 5.0,
    judgeModel: DEFAULT_JUDGE_MODEL,
    judgeEvery: 1,
    baselineModelId: null,
    timeout: 30.0,
    allowOffline: true,
    cacheEnabled: false,
    cacheThreshold: 0.95,
    ...overrides,
  };
}

/** Build a config from the environment + optional overrides. */
export function configFromEnv(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const cfg = harnessConfig();
  refreshRoutingEnv(cfg);
  const timeoutEnv = process.env.MINIMA_TIMEOUT;
  if (timeoutEnv) {
    const t = Number(timeoutEnv);
    if (Number.isFinite(t)) cfg.timeout = t;
  }
  return { ...cfg, ...overrides };
}

/** Re-read the Minima endpoint + routing auth from the environment, in place. */
export function refreshRoutingEnv(cfg: HarnessConfig): void {
  cfg.minimaUrl = process.env.MINIMA_URL ?? cfg.minimaUrl;
  cfg.minimaApiKey = process.env.MINIMA_API_KEY ?? process.env.MUBIT_API_KEY ?? cfg.minimaApiKey;
}
