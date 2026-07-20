/**
 * Minima integration layer — port of the Python harness's minima/.
 *
 * The seam between the TS harness/agent and the Python FastAPI recommender service.
 */

export * from "./schemas.ts";
export { MinimaClient, asOutcome } from "./client.ts";
export type { MinimaClientOptions, FetchLike } from "./client.ts";
export { MinimaError, raiseForStatus } from "./errors.ts";
export {
  harnessConfig,
  configFromEnv,
  refreshRoutingEnv,
  DEFAULT_MINIMA_URL,
  DEFAULT_CANDIDATES,
  type HarnessConfig,
} from "./config.ts";
export { ModelMapping, syncCatalog } from "./mapping.ts";
export { CostMeter, emptyTotals, type CostRow, type CostTotals } from "./meter.ts";
export {
  DeterministicJudge,
  ConstJudge,
  LLMJudge,
  clamp01,
  parseScore,
  JUDGE_SYSTEM,
} from "./judge.ts";
export type { QualityJudge } from "./judge.ts";
export { MinimaRouter, type RoutingResult, type Ranking } from "./router.ts";
export { MinimaAgent, gradeOutcome, type BeforeRoute, type MinimaAgentOptions } from "./runtime.ts";
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
export type { PlanFinalizeDeps, PlanFinalizeOutcome, PlanFinalizeDb } from "./plan_finalize.ts";
