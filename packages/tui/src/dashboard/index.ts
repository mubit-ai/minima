/**
 * Public surface of the localhost dashboard. Imported lazily by `minima dashboard` so the
 * normal TUI startup path never pays for it.
 */

export { DashboardStore, LedgerUnavailableError } from "./queries.ts";
export type {
  BudgetSummary,
  DayRow,
  DecisionRecord,
  MemorySummary,
  ModelMixRow,
  PlanSummary,
  ProjectSummary,
  RunDetail,
  RunSummary,
  Scope,
  ScoreboardRow,
  ToolRow,
} from "./queries.ts";
export { DEFAULT_PORT, createDashboard, createHandler, startDashboard } from "./server.ts";
export type { DashboardHandle, DashboardOptions } from "./server.ts";
export { gateTiers, kpis, modelStats, overview, scoreboardCells } from "./stats.ts";
export type {
  GateReason,
  GateTiers,
  Kpi,
  ModelStat,
  OverviewPayload,
  ScoreboardCell,
} from "./stats.ts";
