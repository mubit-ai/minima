/**
 * Wire schemas for the Minima recommender service (/v1/* contract).
 *
 * Field names are intentionally snake_case to match the FastAPI/Pydantic JSON
 * serialization byte-for-byte. These are transport DTOs; the harness consumes
 * them directly. (A future enhancement: codegen these from /openapi.json so the
 * TS client can never drift from the Python service.)
 *
 * Mirrors src/minima/schemas/*.py — the Python file is the source of truth.
 */

// ---------------------------------------------------------------------------
// Enums — src/minima/schemas/common.py
// ---------------------------------------------------------------------------

export const TASK_TYPES = [
  "code",
  "summarization",
  "extraction",
  "qa",
  "reasoning",
  "classification",
  "translation",
  "creative",
  "rag",
  "tool_use",
  "other",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const OUTCOME_LABELS = ["success", "partial", "failure"] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

export const DECISION_BASES = ["memory", "prior", "llm"] as const;
export type DecisionBasis = (typeof DECISION_BASES)[number];

// ---------------------------------------------------------------------------
// Constraints / TaskInput — common.py
// ---------------------------------------------------------------------------

export interface Constraints {
  allowed_providers?: string[];
  candidate_models?: string[];
  excluded_models?: string[];
  max_cost_per_call?: number;
  min_quality?: number;
  require_prompt_caching?: boolean;
  max_latency_ms?: number;
  require_context_window?: number;
}

export interface TaskInput {
  task: string;
  task_type?: TaskType;
  difficulty?: Difficulty;
  /** Caller's classifier confidence in its task_type/difficulty override [0,1];
   * diagnostic only — the override wins regardless. */
  task_type_confidence?: number;
  expected_input_tokens?: number;
  expected_output_tokens?: number;
  tags?: string[];
}

/** Accepts a raw string, a full TaskInput, or a partial dict — matches the Python client. */
export type TaskLike = string | TaskInput;

// ---------------------------------------------------------------------------
// Recommend — recommend.py
// ---------------------------------------------------------------------------

export interface RecommendRequest {
  task: TaskInput;
  cost_quality_tradeoff?: number;
  constraints?: Constraints;
  user_id?: string;
  namespace?: string;
  /**
   * The model currently holding this session's context/prompt cache. Its
   * estimate-basis input is priced partly at the cache-read rate (switching
   * forfeits the cache) — stickiness via honest cost accounting.
   */
  incumbent_model_id?: string;
  max_candidates?: number;
  allow_llm_escalation?: boolean;
  explain?: boolean;
  baseline_model_id?: string;
}

export interface EvidenceRef {
  entry_id: string;
  reference_id?: string;
  model_id: string;
  score: number;
  knowledge_confidence: number;
  observed_success: number;
  is_stale?: boolean;
}

export interface RankedModel {
  model_id: string;
  provider: string;
  predicted_success: number;
  est_cost_usd: number;
  est_cost_breakdown?: Record<string, number>;
  score: number;
  rationale?: string;
  decision_basis?: DecisionBasis;
  evidence?: EvidenceRef[];
  supports_prompt_caching?: boolean;
  context_window?: number;
  est_latency_ms?: number;
  latency_basis?: string;
  est_cost_low?: number;
  est_cost_high?: number;
  cost_band_basis?: string;
  success_interval_width?: number;
}

export interface RecommendResponse {
  recommendation_id: string;
  recommended_model: RankedModel;
  ranked?: RankedModel[];
  fallback_model?: RankedModel;
  confidence: number;
  decision_basis: DecisionBasis;
  threshold_used: number;
  classified_task_type: TaskType;
  classified_difficulty: Difficulty;
  catalog_version: string;
  catalog_stale?: boolean;
  latency_ms?: number;
  warnings?: string[];
  selection_policy?: string;
  recommended_actions?: string[];
}

// ---------------------------------------------------------------------------
// Feedback — feedback.py
// ---------------------------------------------------------------------------

/**
 * One plan step's objective verdict, relayed to Mubit as a process reward.
 * Send only deterministic verdicts (red->green gate results) — never model
 * self-assessment.
 */
export interface StepOutcome {
  step_id: string;
  step_name?: string;
  outcome: OutcomeLabel;
  /** Reinforcement signal in [-1, 1]; derived from outcome when omitted. */
  signal?: number;
  rationale?: string;
  /** Corrective directive for future attempts at this step. */
  directive_hint?: string;
}

export interface FeedbackRequest {
  recommendation_id: string;
  chosen_model_id: string;
  outcome: OutcomeLabel;
  quality_score?: number;
  input_tokens?: number;
  output_tokens?: number;
  actual_cost_usd?: number;
  latency_ms?: number;
  iterations?: number;
  /**
   * Provenance of the quality signal. gate = deterministic verification (the only
   * origin that may claim verified-in-production); judge = LLM judge; human =
   * caller-asserted; none = unjudged — cost/latency telemetry only, never a
   * success/reinforcement/calibration signal.
   */
  evidence_source?: "gate" | "judge" | "human" | "none";
  /** infra = provider/tooling fault (429/5xx/timeout) — telemetry only, never model quality. */
  error_cause?: "infra" | "quality";
  /** DEPRECATED: send evidence_source="gate" instead. */
  verified_in_production?: boolean;
  /** DEPRECATED: send evidence_source instead (true→judge, false→none). */
  judged?: boolean;
  /** Reasoning-effort tier the model ran at — raw material for (model x effort) arms. */
  chosen_effort?: string;
  /** rec_id of the immediately preceding recovery rung (preference-pair linkage). */
  parent_rec_id?: string;
  /** Why the parent rung failed (ladder cause; rides with parent_rec_id). */
  escalation_reason?: "gate_failed" | "judge_failed" | "transient" | "hard_error";
  /** Exact provider-reported model identifier (dated snapshot vs requested alias). */
  provider_model_snapshot?: string;
  /** P(this turn was selected for labeling); 1.0 for gate labels. */
  label_propensity?: number;
  notes?: string;
  idempotency_key?: string;
  /**
   * Per-step objective verdicts (gate results) relayed as process rewards.
   * Independent of the turn label: recorded even when the turn is unlabeled.
   */
  step_outcomes?: StepOutcome[];
}

export interface FeedbackResponse {
  accepted: boolean;
  record_id?: string;
  reinforced_entry_ids?: string[];
  updated_confidence?: number;
  reflection_triggered?: boolean;
  lesson_promoted?: boolean;
  step_outcomes_recorded?: number;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Models catalog — models_catalog.py
// ---------------------------------------------------------------------------

export interface ModelCard {
  model_id: string;
  provider: string;
  display_name?: string;
  input_cost_per_mtok: number;
  output_cost_per_mtok: number;
  cache_read_cost_per_mtok?: number;
  supports_prompt_caching?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  capability_priors?: Record<string, number>;
  capability_by_task_type?: Partial<Record<TaskType, number>>;
  cost_source?: string;
  cost_fetched_at?: string;
  cost_stale?: boolean;
  capability_source?: string;
}

export interface ModelsResponse {
  models: ModelCard[];
  catalog_version: string;
  refreshed_at?: string;
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Workflow — workflow.py
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  step_id: string;
  task: TaskInput;
  constraints?: Constraints;
  depends_on?: string[];
}

export interface WorkflowRequest {
  steps: WorkflowStep[];
  cost_quality_tradeoff?: number;
  constraints?: Constraints;
  user_id?: string;
  namespace?: string;
  allow_llm_escalation?: boolean;
}

export interface WorkflowResponse {
  workflow_recommendation_id: string;
  steps: { step_id: string; recommendation: RecommendResponse }[];
  total_est_cost_usd: number;
  total_est_cost_if_all_premium: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Savings / calibration / strategies — savings.py, strategies.py
// (The summary/report inner shapes are dynamic dicts from the metrics layer;
// we surface them as Record<string, unknown> rather than pinning every field.)
// ---------------------------------------------------------------------------

export interface SavingsResponse {
  org_id: string;
  since: number;
  days: number;
  namespace?: string;
  summary: Record<string, unknown>;
  health?: Record<string, number>;
  group_by?: string;
  groups?: { key: string; summary: Record<string, unknown>; health?: Record<string, number> }[];
}

export interface CalibrationResponse {
  org_id: string;
  since: number;
  days: number;
  namespace?: string;
  health?: Record<string, number>;
  reports?: Record<string, unknown>[];
  drift_flags?: Record<string, unknown>[];
}

export interface StrategiesResponse {
  namespace?: string;
  lane: string;
  strategies?: Strategy[];
  count?: number;
}

export interface Strategy {
  strategy_id?: string;
  description?: string;
  supporting_lesson_count?: number;
  avg_confidence?: number;
  avg_reinforcement?: number;
  dominant_lesson_type?: string;
  dominant_scope?: string;
  lesson_ids?: string[];
}

// ---------------------------------------------------------------------------
// Memory insight — insight.py
// ---------------------------------------------------------------------------

export interface DiagnoseRequest {
  error_text: string;
  error_type?: string;
  limit?: number;
  namespace?: string;
  user_id?: string;
}

export interface FailureLesson {
  lesson_id?: string;
  content?: string;
  lesson_type?: string;
  importance?: string;
  confidence?: number;
}

export interface DiagnoseResponse {
  namespace?: string;
  lane: string;
  failure_lessons?: FailureLesson[];
  summary?: string;
  total_failure_lessons?: number;
  warnings?: string[];
}

/** An active posterior reset epoch (CUSUM drift or provider snapshot change). */
export interface PosteriorReset {
  model: string;
  lane?: string | null;
  cluster?: string | null;
  at: number;
  cause: string;
}

export interface MemoryHealthResponse {
  namespace?: string;
  lane: string;
  entry_counts?: Record<string, number>;
  stale_entries?: number;
  contradictions?: number;
  low_confidence_count?: number;
  promotion_candidates?: number;
  section_health?: Record<string, unknown>;
  /** Evidence older than an epoch is zero-weighted at ranking time. */
  posterior_resets?: PosteriorReset[];
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Capabilities — capabilities.py
// ---------------------------------------------------------------------------

export interface CapabilitiesResponse {
  /** POST /v1/plan (goal → Delegation DAG) is available. */
  plan: boolean;
  /** POST /v1/recommend/workflow is available. */
  workflow: boolean;
  /** Running server version string. */
  api_version: string;
  /** Constraint fields the engine actively filters on. */
  honored_constraints: string[];
}

// ---------------------------------------------------------------------------
// Policy value / regret-vs-oracle — metrics/ope.py + savings.py router
// ---------------------------------------------------------------------------

export interface PolicyEstimate {
  policy: string;
  n: number;
  success_value: number;
  cost_value: number;
  /** Share of rows where this policy's pick equals the logged pick. */
  matched_share: number;
  /** Full estimator suite over the same rows: {dr, snips, switch, dr_shrunk}. */
  estimates?: Record<string, number>;
}

/** Replay-matched value of a logged shadow challenger policy. */
export interface ChallengerEstimate {
  policy: string;
  n: number;
  n_matched: number;
  success_value: number;
  cost_value: number;
}

export interface RegretReport {
  n_trusted: number;
  n_total_reconciled: number;
  /** Share of trusted rows logged with a non-degenerate propensity. */
  stochastic_share: number;
  policies: PolicyEstimate[];
  /** Model-based oracle success minus deployed success (honest upper bound). */
  regret_vs_oracle: number;
  /** True when the deployed policy's estimator suite disagrees beyond the margin. */
  estimator_disagreement?: boolean;
}

export interface PolicyValueResponse {
  org_id: string;
  since: number;
  days: number;
  namespace?: string | null;
  report: RegretReport;
  challengers?: ChallengerEstimate[];
  warnings?: string[];
}
