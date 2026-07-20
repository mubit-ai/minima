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
  /** Probability a judge-eligible (ungated) turn is actually graded. Sampling keeps the
   * default-on judge cheap while still yielding an unbiased labeled subset — enough to
   * fit calibration and posteriors on judged rows alone. 1 = grade every eligible turn,
   * 0 disables. MINIMA_JUDGE_SAMPLE overrides; MINIMA_LLM_JUDGE=1 forces 1 (legacy). */
  judgeSampleRate: number;
  baselineModelId: string | null;
  timeout: number;
  allowOffline: boolean;
  cacheEnabled: boolean;
  cacheThreshold: number;
  /** Ground-Truth ledger (default ON since 0.11): persist/project the plan, attribute file
   * changes, and record verification gates — gate verdicts are the harness's honest label
   * source. Opt out with MINIMA_TUI_GROUND_TRUTH=0. */
  groundTruth: boolean;
  /** Run-level stop-gate strikes (A2): how many times the harness may deny the agent's attempt to
   * END the run while the plan has incomplete/failing steps before it stops denying and asks the
   * user. `MINIMA_TUI_STOP_STRIKES`, default 3; 0 disables the stop-gate entirely (pure-nudge
   * behavior). Only consulted when `groundTruth` is on — inert on the default path. */
  stopStrikes: number;
  /** Anti-spiral (A3): the doom-loop ring-buffer trigger — how many times the SAME failing tool
   * call (tool+args) may repeat within the window before the harness injects a summary and steers
   * the model off the loop. `MINIMA_TUI_SPIRAL_REPEATS`, default 3; 0 disables the detector. Only
   * consulted when `groundTruth` is on. */
  spiralRepeats: number;
  /** Anti-spiral (A3): soft turn cap — after this many turns the harness injects a wrap-up summary
   * and stops gracefully (distinct from the hard `maxTurns` ceiling). `MINIMA_TUI_STEP_CAP`,
   * default 30; 0 disables the cap. Only consulted when `groundTruth` is on. */
  stepCap: number;
  /** Soft USD cap per plan-mode council round (MINIMA_PLAN_ROUND_BUDGET_USD). Read only by
   * the groundTruth /plan workflow — inert on the default path. */
  planRoundBudgetUsd: number;
  /** Failure-kind matchers (A4): classify WHY a recovery rung failed and pick the fitting
   * intervention (backoff transient / escalate capability / replan structural) instead of the
   * ladder's blunt always-escalate. `MINIMA_TUI_FAILURE_MATCHER`, default on (`0` disables →
   * classic escalate-only ladder). Only consulted when `groundTruth` is on — inert on the default
   * path. */
  failureMatcher: boolean;
  /** Per-step tool allowlist (A6): hard-block, at the dispatcher, any mutating tool a plan step did
   * not list in its `tools` allowlist while that step is in progress. `MINIMA_TUI_TOOL_ALLOWLIST`,
   * default on (`0` disables → no enforcement, steps' allowlists become advisory metadata only).
   * Only consulted when `groundTruth` is on — inert on the default path; a step with no authored
   * allowlist is unrestricted, so this never changes behavior for plans that don't use it. */
  toolAllowlist: boolean;
  /** Failure-kind matchers (A4): bounded delay (ms) before a `backoff` retry of the SAME model on a
   * transient/infra error. `MINIMA_TUI_BACKOFF_MS`, default **0** (no delay — hermetic tests); set
   * a small value (e.g. 500) in prod to space out a rate-limited retry. */
  backoffMs: number;
  /** Graded grounded outcome (A7): grade the DETERMINISTIC feedback label by the gate's confidence
   * tier instead of collapsing every verified pass to `success`. On: a 🟢 verified pass →
   * `success`, a 🟡/🔴-tier-but-verified pass (self-written test, no red→green evidence, or an A5
   * fabrication-floor red) → `partial`, a failed check → `failure` — so Minima learns weaker
   * positive evidence distinctly from clean ground truth. `MINIMA_TUI_GRADED_OUTCOME`, default on
   * (`0` disables → the M7.2 binary verified→success). Only consulted when `groundTruth` is on —
   * inert on the default path (the deterministic branch never runs without a gate). Never affects
   * the recovery-ladder trigger (a red still `failed`) nor `verified_in_production` (green-only). */
  gradedOutcome: boolean;
  /** Memory ledger (B1, default ON): project curated cross-session memories (SQLite
   * `memories` table, managed via /memory) into each turn's system prompt. Opt out with
   * MINIMA_TUI_MEMORY=0 — mirrors the groundTruth flag shape. Read path only: nothing
   * writes memories unless the user (or a later curator) does. */
  memoryLedger: boolean;
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
    judgeSampleRate: 0.15,
    baselineModelId: null,
    timeout: 30.0,
    allowOffline: true,
    cacheEnabled: false,
    cacheThreshold: 0.95,
    groundTruth: true,
    stopStrikes: 3,
    spiralRepeats: 3,
    stepCap: 30,
    planRoundBudgetUsd: 0.25,
    failureMatcher: true,
    toolAllowlist: true,
    backoffMs: 0,
    gradedOutcome: true,
    memoryLedger: true,
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
  cfg.groundTruth = process.env.MINIMA_TUI_GROUND_TRUTH !== "0";
  cfg.memoryLedger = process.env.MINIMA_TUI_MEMORY !== "0";
  const judgeSampleEnv = process.env.MINIMA_JUDGE_SAMPLE;
  if (judgeSampleEnv) {
    const s = Number(judgeSampleEnv);
    if (Number.isFinite(s) && s >= 0 && s <= 1) cfg.judgeSampleRate = s;
  } else if (process.env.MINIMA_LLM_JUDGE === "1") {
    cfg.judgeSampleRate = 1.0;
  }
  const strikesEnv = process.env.MINIMA_TUI_STOP_STRIKES;
  if (strikesEnv !== undefined) {
    const n = Number(strikesEnv);
    if (Number.isInteger(n) && n >= 0) cfg.stopStrikes = n;
  }
  const spiralEnv = process.env.MINIMA_TUI_SPIRAL_REPEATS;
  if (spiralEnv !== undefined) {
    const n = Number(spiralEnv);
    if (Number.isInteger(n) && n >= 0) cfg.spiralRepeats = n;
  }
  const stepCapEnv = process.env.MINIMA_TUI_STEP_CAP;
  if (stepCapEnv !== undefined) {
    const n = Number(stepCapEnv);
    if (Number.isInteger(n) && n >= 0) cfg.stepCap = n;
  }
  const roundBudgetEnv = process.env.MINIMA_PLAN_ROUND_BUDGET_USD;
  if (roundBudgetEnv) {
    const b = Number(roundBudgetEnv);
    if (Number.isFinite(b) && b > 0) cfg.planRoundBudgetUsd = b;
  }
  // MINIMA_JUDGE_MODEL repoints the judge AND the plan-council meta model (keeper/critic/
  // synth + ground-truth synthesis) — without it, a missing/limited key for the default
  // model silently degrades the whole planning pipeline with no way to choose another.
  const judgeEnv = process.env.MINIMA_JUDGE_MODEL?.trim();
  if (judgeEnv) cfg.judgeModel = judgeEnv;
  if (process.env.MINIMA_TUI_FAILURE_MATCHER === "0") cfg.failureMatcher = false;
  if (process.env.MINIMA_TUI_TOOL_ALLOWLIST === "0") cfg.toolAllowlist = false;
  if (process.env.MINIMA_TUI_GRADED_OUTCOME === "0") cfg.gradedOutcome = false;
  const backoffEnv = process.env.MINIMA_TUI_BACKOFF_MS;
  if (backoffEnv !== undefined) {
    const n = Number(backoffEnv);
    if (Number.isInteger(n) && n >= 0) cfg.backoffMs = n;
  }
  return { ...cfg, ...overrides };
}

/** Re-read the Minima endpoint + routing auth from the environment, in place. */
export function refreshRoutingEnv(cfg: HarnessConfig): void {
  cfg.minimaUrl = process.env.MINIMA_URL ?? cfg.minimaUrl;
  cfg.minimaApiKey = process.env.MINIMA_API_KEY ?? process.env.MUBIT_API_KEY ?? cfg.minimaApiKey;
}
