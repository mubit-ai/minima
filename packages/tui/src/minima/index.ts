/**
 * Minima integration layer — port of minima_harness/minima/.
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
