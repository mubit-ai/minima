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
  "claude-sonnet-5",
  "gemini-3.6-flash",
  "deepseek-v4-flash",
  "gpt-5.6-luna",
];

/** Premium allowlist for plan-mode routed + plan-shaping calls (MINIMA_PLAN_PREMIUM_MODELS).
 * Ids must exist in BOTH the TUI seed registry and the server catalog; order = preference. */
export const PREMIUM_CANDIDATES: string[] = ["claude-fable-5", "claude-opus-4-8", "gemini-2.5-pro"];

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
  /** Stream inactivity watchdog (ms): abort a turn whose model stream goes silent for
   * this long (MINIMA_STREAM_IDLE_TIMEOUT_MS, default 5 min; 0 disables). Guardrail for
   * the pinned-busy leak: a silent stream kept `busy` true forever while the spinner
   * pumped frames into a possibly non-draining stdout, growing RSS without bound. */
  streamIdleTimeoutMs: number;
  allowOffline: boolean;
  /** Plan ledger (default ON since 0.11): persist/project the plan, attribute file
   * changes, and record verification gates — gate verdicts are the harness's honest label
   * source. Opt out with MINIMA_TUI_BIG_PLAN=0. */
  bigPlan: boolean;
  /** Run-level stop-gate strikes (A2): how many times the harness may deny the agent's attempt to
   * END the run while the plan has incomplete/failing steps before it stops denying and asks the
   * user. `MINIMA_TUI_STOP_STRIKES`, default 3; 0 disables the stop-gate entirely (pure-nudge
   * behavior). Only consulted when `bigPlan` is on — inert on the default path. */
  stopStrikes: number;
  /** Anti-spiral (A3): the doom-loop ring-buffer trigger — how many times the SAME failing tool
   * call (tool+args) may repeat within the window before the harness injects a summary and steers
   * the model off the loop. `MINIMA_TUI_SPIRAL_REPEATS`, default 3; 0 disables the detector. Only
   * consulted when `bigPlan` is on. */
  spiralRepeats: number;
  /** Anti-spiral (A3): soft turn cap — after this many turns the harness injects a wrap-up summary
   * and stops gracefully (distinct from the hard `maxTurns` ceiling). `MINIMA_TUI_STEP_CAP`,
   * default 30; 0 disables the cap. Only consulted when `bigPlan` is on. */
  stepCap: number;
  /** Soft USD cap per plan-mode council round (MINIMA_PLAN_ROUND_BUDGET_USD). Read only by
   * the bigPlan /plan workflow — inert on the default path. Defaults to 0.25, bumped to
   * 1.00 when `planPremium` is on and the env var is unset — premium meta spend reconciles
   * into the round, so the base reservation chronically under-reserves. */
  planRoundBudgetUsd: number;
  /** Plan-premium (default ON): while plan mode is active, the plan-DECIDING calls — the
   * routed lead-planner turn (hard `constraints.candidate_models` pin, pre-request candidate
   * assembly) and the council's plan-shaping meta calls (draft/revise/critic-attack/synth +
   * finalize question-resolution and plan synthesis) — are restricted to the premium
   * allowlist. The sessionless plan-mode fallback (plan verification off / no live council) is pinned
   * to the same pool — the restriction is a property of the MODE, not of the council. Keeper
   * bookkeeping, researchers, the E1 critic, and the diff reviewer keep their cheap/normal
   * models. Hard constraint: no
   * runnable premium model fails loudly (an explicit /model pin wins over the policy). Opt
   * out with MINIMA_TUI_PLAN_PREMIUM=0 — mirrors the bigPlan flag shape. */
  planPremium: boolean;
  /** Premium model ids for plan mode (MINIMA_PLAN_PREMIUM_MODELS, comma-separated).
   * Order = preference order; the first runnable entry becomes the plan-shaping model. */
  planPremiumModels: string[];
  /** Explicit plan-shaping model override (MINIMA_PLAN_MODEL). Decouples the plan council
   * from MINIMA_JUDGE_MODEL. null = first runnable entry of `planPremiumModels`. */
  planModel: string | null;
  /** Failure-kind matchers (A4): classify WHY a recovery rung failed and pick the fitting
   * intervention (backoff transient / escalate capability / replan structural) instead of the
   * ladder's blunt always-escalate. `MINIMA_TUI_FAILURE_MATCHER`, default on (`0` disables →
   * classic escalate-only ladder). Only consulted when `bigPlan` is on — inert on the default
   * path. */
  failureMatcher: boolean;
  /** Per-step tool allowlist (A6): hard-block, at the dispatcher, any mutating tool a plan step did
   * not list in its `tools` allowlist while that step is in progress. `MINIMA_TUI_TOOL_ALLOWLIST`,
   * default on (`0` disables → no enforcement, steps' allowlists become advisory metadata only).
   * Only consulted when `bigPlan` is on — inert on the default path; a step with no authored
   * allowlist is unrestricted, so this never changes behavior for plans that don't use it. */
  toolAllowlist: boolean;
  /** Failure-kind matchers (A4): bounded delay (ms) before a `backoff` retry of the SAME model on a
   * transient/infra error. `MINIMA_TUI_BACKOFF_MS`, default **0** (no delay — hermetic tests); set
   * a small value (e.g. 500) in prod to space out a rate-limited retry. */
  backoffMs: number;
  /** Graded verified outcome (A7): grade the DETERMINISTIC feedback label by the gate's confidence
   * tier instead of collapsing every verified pass to `success`. On: a 🟢 verified pass →
   * `success`, a 🟡/🔴-tier-but-verified pass (self-written test, no red→green evidence, or an A5
   * fabrication-floor red) → `partial`, a failed check → `failure` — so Minima learns weaker
   * positive evidence distinctly from verified evidence. `MINIMA_TUI_GRADED_OUTCOME`, default on
   * (`0` disables → the M7.2 binary verified→success). Only consulted when `bigPlan` is on —
   * inert on the default path (the deterministic branch never runs without a gate). Never affects
   * the recovery-ladder trigger (a red still `failed`) nor `verified_in_production` (green-only). */
  gradedOutcome: boolean;
  /** Memory ledger (B1, default ON): project curated cross-session memories (SQLite
   * `memories` table, managed via /memory) into each turn's system prompt. Opt out with
   * MINIMA_TUI_MEMORY=0 — mirrors the bigPlan flag shape. Read path only: nothing
   * writes memories unless the user (or a later curator) does. */
  memoryLedger: boolean;
  /** Artifact spill store (P1, default ON): truncated tool output is content-addressed
   * to artifacts/<sha256>.txt beside the DB and the truncation notice names the absolute
   * path so the model can page it back via read. Opt out with MINIMA_TUI_ARTIFACTS=0 —
   * mirrors the memoryLedger flag shape. */
  artifacts: boolean;
  /** Loop-robustness steer (P2, default ON): block the shell spellings of the native
   * tools (cat/head/tail/grep/find/sed -i) at the dispatcher with a steer message naming
   * the replacement, and never erase-and-replay a recovery-ladder rung that dispatched
   * tool calls. Opt out with MINIMA_TUI_STEER=0 — mirrors the bigPlan flag shape. */
  steer: boolean;
  /** Experimental umbrella (MINIMA_TUI_EXPERIMENTAL=1, default off): turns on every
   * default-off opt-in FEATURE flag at once via `optInFlag`. Explicit per-flag values
   * always win; consent gates and diagnostic switches are never covered. */
  experimental: boolean;
  /** Effort routing Phase A (MINIMA_AUTO_EFFORT, default off, umbrella-covered): the
   * server's classified difficulty picks each prompt's thinking level. */
  autoEffort: boolean;
  /** Client-side task classification (MINIMA_TUI_CLASSIFY, default off, umbrella-covered):
   * one cheap completion labels each interactive lead prompt with task_type/difficulty
   * before routing, sent as the caller override (which the server honors absolutely) plus
   * a diagnostic task_type_confidence. Fail-open: unparseable/low-confidence → the
   * server's heuristic applies unchanged. */
  classify: boolean;
  /** Explicit classifier model override (MINIMA_CLASSIFY_MODEL). null = the cheap
   * fallback ladder starting at claude-haiku-4-5. */
  classifyModel: string | null;
  /** Plan interview (MINIMA_TUI_INTERVIEW, default off, umbrella-covered): after a
   * /plan council round, ask up to 3 gated questions (verification commands,
   * budget/quality profile) and persist the answers (routing profile
   * source='interview', user-origin verifies, preference memories). Completely inert
   * when off. */
  interview: boolean;
  /** Preference probes (MINIMA_TUI_TUNER, default off, umbrella-covered): after a plan
   * closes fully completed, ask ONE bounded A/B question that may nudge the per-repo
   * profile slider one hill-climb step (±1.5 clamped to [2, 8]; ≤1 probe per session;
   * 7-day cooldown via profile_events). Question-asking features ship opt-in. */
  tuner: boolean;
  /** Observer agent (PR-E; MINIMA_TUI_OBSERVER, default off, umbrella-covered): a
   * non-blocking watcher fed by the agent event stream that flags suspect trajectories
   * (test edits mid-step, done-claims over unchecked steps, off-plan bursts, stubbed
   * implementations) via advisory steers, audit-only verdicts, and — after repeated
   * ignored call-outs — at most one yellow milestone gate. Never blocks a tool, never
   * feeds a feedback label. */
  observer: boolean;
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
    streamIdleTimeoutMs: 300_000,
    allowOffline: true,
    bigPlan: true,
    stopStrikes: 3,
    spiralRepeats: 3,
    stepCap: 30,
    planRoundBudgetUsd: 0.25,
    planPremium: true,
    planPremiumModels: [...PREMIUM_CANDIDATES],
    planModel: null,
    failureMatcher: true,
    toolAllowlist: true,
    backoffMs: 0,
    gradedOutcome: true,
    memoryLedger: true,
    artifacts: true,
    steer: true,
    experimental: false,
    autoEffort: false,
    classify: false,
    classifyModel: null,
    interview: false,
    tuner: false,
    observer: false,
    ...overrides,
  };
}

/** Resolve a default-off opt-in FEATURE flag against the experimental umbrella:
 * explicit "1" → on; explicit "0" → off (even under experimental); unset → on iff
 * experimental. Convention: every future default-off feature flag MUST resolve through
 * this helper so MINIMA_TUI_EXPERIMENTAL reaches it; consent gates (e.g.
 * MINIMA_TUI_ALLOW_VERIFY) and diagnostic switches are exempt. */
export function optInFlag(value: string | undefined, experimental: boolean): boolean {
  return value === "1" || (experimental && value !== "0");
}

/** Build a config from the environment + optional overrides. */
export function configFromEnv(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const cfg = harnessConfig();
  refreshRoutingEnv(cfg);
  cfg.experimental = process.env.MINIMA_TUI_EXPERIMENTAL === "1";
  cfg.autoEffort = optInFlag(process.env.MINIMA_AUTO_EFFORT, cfg.experimental);
  const timeoutEnv = process.env.MINIMA_TIMEOUT;
  if (timeoutEnv) {
    const t = Number(timeoutEnv);
    if (Number.isFinite(t)) cfg.timeout = t;
  }
  const idleEnv = process.env.MINIMA_STREAM_IDLE_TIMEOUT_MS;
  if (idleEnv) {
    const v = Number(idleEnv);
    if (Number.isFinite(v) && v >= 0) cfg.streamIdleTimeoutMs = v;
  }
  cfg.bigPlan = process.env.MINIMA_TUI_BIG_PLAN !== "0";
  cfg.memoryLedger = process.env.MINIMA_TUI_MEMORY !== "0";
  cfg.artifacts = process.env.MINIMA_TUI_ARTIFACTS !== "0";
  cfg.steer = process.env.MINIMA_TUI_STEER !== "0";
  cfg.interview = optInFlag(process.env.MINIMA_TUI_INTERVIEW, cfg.experimental);
  cfg.tuner = optInFlag(process.env.MINIMA_TUI_TUNER, cfg.experimental);
  cfg.observer = optInFlag(process.env.MINIMA_TUI_OBSERVER, cfg.experimental);
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
  let roundBudgetFromEnv = false;
  if (roundBudgetEnv) {
    const b = Number(roundBudgetEnv);
    if (Number.isFinite(b) && b > 0) {
      cfg.planRoundBudgetUsd = b;
      roundBudgetFromEnv = true;
    }
  }
  cfg.planPremium = process.env.MINIMA_TUI_PLAN_PREMIUM !== "0";
  const premiumEnv = process.env.MINIMA_PLAN_PREMIUM_MODELS;
  if (premiumEnv !== undefined) {
    const ids = premiumEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) cfg.planPremiumModels = [...new Set(ids)];
  }
  const planModelEnv = process.env.MINIMA_PLAN_MODEL?.trim();
  if (planModelEnv) cfg.planModel = planModelEnv;
  if (cfg.planPremium && !roundBudgetFromEnv) cfg.planRoundBudgetUsd = 1.0;
  // MINIMA_JUDGE_MODEL repoints the judge AND the plan-council meta model (keeper/critic/
  // synth + plan synthesis) — without it, a missing/limited key for the default
  // model silently degrades the whole planning pipeline with no way to choose another.
  const judgeEnv = process.env.MINIMA_JUDGE_MODEL?.trim();
  if (judgeEnv) cfg.judgeModel = judgeEnv;
  cfg.classify = optInFlag(process.env.MINIMA_TUI_CLASSIFY, cfg.experimental);
  const classifyModelEnv = process.env.MINIMA_CLASSIFY_MODEL?.trim();
  if (classifyModelEnv) cfg.classifyModel = classifyModelEnv;
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
