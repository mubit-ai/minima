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
  PREMIUM_CANDIDATES,
  type HarnessConfig,
} from "./config.ts";
export { planModeRoutingOpts, resolvePlanModels, type ResolvedPlanModels } from "./premium.ts";
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
export {
  parseProfileCandidates,
  perTaskTypeEntry,
  resolveProfilePool,
  minDefinedCap,
} from "./routing_profile.ts";
export {
  MinimaAgent,
  gradeOutcome,
  stepOutcomesFromGates,
  type BeforeRoute,
  type MinimaAgentOptions,
} from "./runtime.ts";
export { redoLastRouted, REDO_NOTE_CAP, type RedoOutcome } from "./redo.ts";
export {
  TaskClassifier,
  parseClassification,
  CLASSIFY_CONFIDENCE_FLOOR,
  CLASSIFY_SYSTEM,
  type TaskClassification,
} from "./classify.ts";
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
  type MineOptions,
  type ScribeCandidate,
  type ScribeReport,
  type ScribePassDeps,
  type ExtractFn,
} from "./memory_scribe.ts";
export {
  ObserverFeed,
  ObserverController,
  makeObserverListener,
  attachObserver,
  maybeAttachObserver,
  observerWhySection,
  sanitizeForObserver,
  buildObserverPrompt,
  parseObserverRefutations,
  runObserverPass,
  estimatedPassCostUsd,
  extractDoneClaims,
  patchPaths,
  OBSERVER_SYSTEM,
  OBSERVER_QUEUE_CAP,
  OBSERVER_STEER_CAP,
  OBSERVER_PASS_EVERY,
  OBSERVER_PASS_CAP_USD,
  OBSERVER_BUDGET_FLOOR,
  OBSERVER_ESCALATION_REPEATS,
  type ObserverHandle,
  type ObserverQueueEvent,
  type ObserverRefutation,
  type TrajectoryDigest,
  type AttachObserverOptions,
  type ObserverControllerDeps,
} from "./observer.ts";
export {
  runTripwires,
  testEditTripwire,
  doneClaimTripwire,
  offPlanBurstTripwire,
  antiStubTripwire,
  isStubContent,
  DONE_CLAIM_RE,
  TEST_PATH_RE,
  OFF_PLAN_BURST_MIN,
  type ObserverTurn,
  type ObserverPlanStep,
  type TripwireVerdict,
  type TripwireInput,
} from "./observer_tripwires.ts";
export { PlanSessionStore, buildPlannerSystemPrompt } from "./plan_session.ts";
export type {
  PlanDecision,
  OpenQuestion,
  CouncilFinding,
  PlanConstraint,
  PlanFact,
  SurfacedQuestion,
  CouncilRoundResult,
  BigPlanSynthesis,
  PlanSession,
} from "./plan_session.ts";
export {
  runCouncilRound,
  runKeeperMiniUpdate,
  answerOpenQuestions,
  synthesizeBigPlan,
  Critic,
  shouldConveneCouncil,
  shouldConveneFullCouncil,
  isPlanStakesTurn,
} from "./plan_council.ts";
export type { CouncilOptions, CouncilEvent, ResolvedQuestion } from "./plan_council.ts";
export { runPlanTurn } from "./plan_turn.ts";
export type { PlanTurnDeps } from "./plan_turn.ts";
export { finalizePlan, buildPlanTranscript, applyUserVerifies } from "./plan_finalize.ts";
export {
  runPlanInterview,
  newInterviewState,
  draftHasVerifies,
  parseBudgetAnswer,
  INTERVIEW_MAX_QUESTIONS,
  type InterviewState,
  type PlanInterviewDeps,
} from "./plan_interview.ts";
export {
  taskTypeScoreboard,
  runTaskTypes,
  renderScoreboardTable,
  renderScoreboardContext,
  scoreboardAdvisories,
  SCOREBOARD_MIN_N,
  SCOREBOARD_CONTEXT_CAP_CHARS,
  type ScoreboardCell,
} from "./scoreboard.ts";
export {
  createPreferenceProbe,
  probeDirection,
  boundedCandidate,
  projectTradeoffStats,
  TUNER_STEP,
  TUNER_SLIDER_MIN,
  TUNER_SLIDER_MAX,
  TUNER_MIN_RECONCILED_DECISIONS,
  TUNER_COOLDOWN_SECONDS,
  TUNER_CHEAPER_GREEN_RATE,
  type ProbeDirection,
  type ProbeResult,
  type ProbeSkip,
  type PreferenceProbeDeps,
  type TradeoffStats,
} from "./preference_probe.ts";
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
