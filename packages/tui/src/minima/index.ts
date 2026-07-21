/**
 * Minima integration layer — port of the Python harness's minima/.
 *
 * The seam between the TS harness/agent and the Python FastAPI recommender service.
 */

export * from "./schemas.ts";
export { MinimaClient, asOutcome } from "./client.ts";
export type { MinimaClientOptions, FetchLike } from "./client.ts";
export { MinimaError, isBudgetInfeasible, raiseForStatus } from "./errors.ts";
export {
  harnessConfig,
  configFromEnv,
  refreshRoutingEnv,
  DEFAULT_MINIMA_URL,
  DEFAULT_CANDIDATES,
  PREMIUM_CANDIDATES,
  type HarnessConfig,
} from "./config.ts";
export { resolvePlanModels, type ResolvedPlanModels } from "./premium.ts";
export { ModelMapping, syncCatalog } from "./mapping.ts";
export { CostMeter, emptyTotals, type CostRow, type CostTotals } from "./meter.ts";
export {
  DeterministicJudge,
  ConstJudge,
  LLMJudge,
  applyJudgeCommand,
  clamp01,
  parseScore,
  JUDGE_SYSTEM,
} from "./judge.ts";
export type { QualityJudge, JudgeToggleState } from "./judge.ts";
export { MinimaRouter, type RoutingResult, type Ranking } from "./router.ts";
export {
  MinimaAgent,
  gradeOutcome,
  stepOutcomesFromGates,
  type BeforeRoute,
  type MinimaAgentOptions,
} from "./runtime.ts";
export {
  buildMemoryProjection,
  memoryProjectionFor,
  memoryProjectionCap,
  MEMORY_PROJECTION_CAP_CHARS,
  type MemoryProjection,
} from "./memory_ledger.ts";
export {
  mineSignals,
  applyRecurrenceGate,
  buildScribePrompt,
  parseCandidates,
  makeRoutedExtractor,
  runScribePass,
  sweepStaleMemories,
  drainMemoryJobs,
  similarity,
  normalizePattern,
  SCRIBE_SYSTEM,
  SCRIBE_PASS_CAP_USD,
  SCRIBE_BUDGET_FLOOR,
  type ScribeSignal,
  type ScribeSignalKind,
  type ScribeCandidate,
  type ScribeReport,
  type ScribePassDeps,
  type ExtractFn,
} from "./memory_scribe.ts";
export { PlanSessionStore, buildPlannerSystemPrompt } from "./plan_session.ts";
export type {
  PlanDecision,
  OpenQuestion,
  CouncilFinding,
  PlanConstraint,
  PlanFact,
  SurfacedQuestion,
  CouncilRoundResult,
  GroundTruthSynthesis,
  PlanSession,
} from "./plan_session.ts";
export {
  runCouncilRound,
  runKeeperMiniUpdate,
  answerOpenQuestions,
  synthesizeGroundTruth,
  Critic,
  shouldConveneCouncil,
  shouldConveneFullCouncil,
  isPlanStakesTurn,
} from "./plan_council.ts";
export type { CouncilOptions, CouncilEvent, ResolvedQuestion } from "./plan_council.ts";
export { runPlanTurn } from "./plan_turn.ts";
export type { PlanTurnDeps } from "./plan_turn.ts";
export { finalizePlan, buildPlanTranscript } from "./plan_finalize.ts";
export {
  runPlanCritic,
  parseCriticFlags,
  buildCriticPrompt,
  formatCriticNote,
  PLAN_CRITIC_SYSTEM,
  type PlanCriticOptions,
} from "./plan_critic.ts";
export {
  mineRepoGates,
  attachAutoGates,
  fastGate,
  fullGate,
  formatAutoGateNote,
  type RepoGate,
  type AutoGateResult,
} from "./repo_gates.ts";
export {
  mineGreenEpisodes,
  distillWorkflow,
  runDream,
  formatDreamReport,
  knownProcedureFor,
  type GreenEpisode,
  type DreamReport,
} from "./memory_dream.ts";
export {
  runDiffReview,
  parseDiffReviewVerdict,
  collectRunDiff,
  DIFF_REVIEW_SYSTEM,
  DIFF_REVIEW_CAP_CHARS,
  type DiffReviewVerdict,
  type DiffReviewOutcome,
  type DiffReviewOptions,
} from "./diff_review.ts";
export type { PlanFinalizeDeps, PlanFinalizeOutcome, PlanFinalizeDb } from "./plan_finalize.ts";
