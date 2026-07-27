/**
 * Read-only queries over the harness ledger — the dashboard's ONLY read path.
 *
 * Opens its own `readonly` SQLite handle: the dashboard can never migrate, write, or take
 * the write lock on a DB a live session owns (WAL readers never block the harness's single
 * writer). Because the handle is readonly it also cannot run migrations, so the dashboard
 * refuses to start against a ledger older than the harness that would own it.
 *
 * Every query takes a `Scope` — a project_key, or null for "every project in the ledger".
 * Rows come back as plain records; all aggregation lives in `stats.ts` so it stays testable
 * without a DB.
 */

import { Database } from "bun:sqlite";
import type { DecisionRowLike } from "../db/metrics.ts";
import { type GateRow, defaultDbPath } from "../db/minima_db.ts";

/** A project_key to scope to, or null for the whole ledger. */
export type Scope = string | null;

export interface ProjectSummary {
  project_key: string;
  namespace: string | null;
  created: number;
  runs: number;
  last_activity: number | null;
}

export interface RunSummary {
  run_id: string;
  project_key: string;
  display_name: string | null;
  /** The STORED status. Never render this as liveness — see `last_event`. */
  status: string;
  created: number;
  updated: number;
  decisions: number;
  cost_usd: number;
  tool_calls: number;
  tool_errors: number;
  /**
   * MAX(events.ts) — the only trustworthy recency signal in the ledger. `runs.updated` is
   * written at create and close and never per turn (134 of 135 'active' runs on a real
   * ledger had updated-created < 1s while events landed up to 5.5h later), and
   * `runs.status` never closes when a session crashes.
   */
  last_event: number | null;
  /** Event count. 0 means an empty shell — a run row that never recorded any activity. */
  events: number;
}

export interface DecisionRecord extends DecisionRowLike {
  rec_id: string;
  run_id: string;
  task_label: string | null;
  task_type: string | null;
  difficulty: string | null;
  chosen_model: string | null;
  selection_policy: string | null;
  confidence: number | null;
  latency_ms: number | null;
  turns: number | null;
  ts: number;
}

export interface ModelMixRow {
  model: string;
  n: number;
  cost_usd: number;
  judged_n: number;
  quality_sum: number;
  latency_sum: number;
  latency_n: number;
}

export interface DayRow {
  day: string;
  n: number;
  cost_usd: number;
}

export interface ScoreboardRow {
  task_type: string;
  model: string;
  confidence: string | null;
  verified_by: string | null;
  cost: number | null;
}

export interface ToolRow {
  tool: string;
  n: number;
  errors: number;
}

export interface PlanSummary {
  id: string;
  session_id: string | null;
  title: string | null;
  /** The STORED plan status. 10 plans read 'active' on a real ledger whose runs are done. */
  status: string | null;
  created_at: string | null;
  closed_at: number | null;
  steps: number;
  done: number;
  in_progress: number;
  gates: number;
  /** Steps carrying a `verify` command, and of those how many captured a red baseline. */
  verify_steps: number;
  baseline_steps: number;
  /** The run this plan belongs to — the root every relative file path resolves against. */
  project_key: string | null;
  last_event: number | null;
  changes: number;
}

/** A plan step, verbatim. `verify` is the command; its OUTPUT is never captured anywhere. */
export interface PlanStepRow {
  id: string;
  plan_id: string;
  idx: number;
  content: string | null;
  status: string | null;
  verify: string | null;
  baseline: string | null;
  check_origin: string | null;
  verify_cwd: string | null;
}

/**
 * A recorded write. `origin` is the FROZEN write-time classification — computed against only
 * the then-in-progress step by a bare-basename substring match, and short-circuited straight
 * to 'off_plan' whenever no step was in progress. `stats.ts` recomputes it; do not render
 * this column directly.
 */
export interface FileChangeRow {
  id: string;
  plan_id: string;
  step_id: string | null;
  path: string;
  kind: string;
  origin: string;
  created_at: string | null;
}

export interface PlanDetail {
  plan: PlanSummary;
  steps: PlanStepRow[];
  gates: GateRow[];
  changes: FileChangeRow[];
  /** Realized $ per step from the step_id stamp. Absent = no attribution, render "—" not $0. */
  stepCosts: { step_id: string; cost_usd: number }[];
  /** Run-wide routed $, so the gap against Σ(stepCosts) is reportable rather than hidden. */
  runRoutedUsd: number;
}

export interface MemorySummary {
  id: string;
  project_key: string;
  kind: string;
  status: string;
  origin: string;
  evidence_source: string;
  content: string;
  trigger: string | null;
  updated: number;
}

export interface BudgetSummary {
  scope_key: string;
  limit_usd: number;
  spent_usd: number;
  reserved_usd: number;
  mode: string;
  updated: number;
}

export interface RunDetail {
  run: RunSummary;
  decisions: DecisionRecord[];
  tools: ToolRow[];
  plans: PlanSummary[];
}

/** Thrown when the ledger is missing or unreadable — the CLI turns this into a clean exit. */
export class LedgerUnavailableError extends Error {}

const RUNS_SQL = `
  SELECT r.run_id, r.project_key, r.display_name, r.status, r.created, r.updated,
         (SELECT COUNT(*) FROM routing_decisions d WHERE d.run_id = r.run_id) AS decisions,
         (SELECT COALESCE(SUM(d.actual_cost_usd), 0) FROM routing_decisions d
           WHERE d.run_id = r.run_id) AS cost_usd,
         (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.run_id) AS tool_calls,
         (SELECT COALESCE(SUM(t.is_error), 0) FROM tool_calls t
           WHERE t.run_id = r.run_id) AS tool_errors,
         (SELECT MAX(e.ts) FROM events e WHERE e.run_id = r.run_id) AS last_event,
         (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id) AS events
  FROM runs r
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY COALESCE(last_event, r.updated) DESC
  LIMIT ?2`;

const DECISIONS_SQL = `
  SELECT d.rec_id, d.run_id, d.task_label, d.task_type, d.difficulty, d.chosen_model,
         d.decision_basis, d.selection_policy, d.confidence, d.threshold_used, d.ranked,
         d.est_cost_usd, d.all_premium_cost_usd, d.configured_baseline_cost_usd,
         d.actual_cost_usd, d.quality, d.judged, d.outcome, d.routed, d.turns,
         d.latency_ms, d.ts
  FROM routing_decisions d
  JOIN runs r ON r.run_id = d.run_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY d.ts DESC
  LIMIT ?2`;

const MODEL_MIX_SQL = `
  SELECT d.chosen_model AS model,
         COUNT(*) AS n,
         COALESCE(SUM(d.actual_cost_usd), 0) AS cost_usd,
         COALESCE(SUM(CASE WHEN d.judged = 1 AND d.quality IS NOT NULL THEN 1 ELSE 0 END), 0)
           AS judged_n,
         COALESCE(SUM(CASE WHEN d.judged = 1 AND d.quality IS NOT NULL THEN d.quality ELSE 0 END), 0)
           AS quality_sum,
         COALESCE(SUM(COALESCE(d.latency_ms, 0)), 0) AS latency_sum,
         COALESCE(SUM(CASE WHEN d.latency_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS latency_n
  FROM routing_decisions d
  JOIN runs r ON r.run_id = d.run_id
  WHERE (?1 IS NULL OR r.project_key = ?1) AND d.chosen_model IS NOT NULL
  GROUP BY d.chosen_model
  ORDER BY n DESC`;

const SPEND_BY_DAY_SQL = `
  SELECT strftime('%Y-%m-%d', d.ts, 'unixepoch') AS day,
         COUNT(*) AS n,
         COALESCE(SUM(d.actual_cost_usd), 0) AS cost_usd
  FROM routing_decisions d
  JOIN runs r ON r.run_id = d.run_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  GROUP BY day
  ORDER BY day ASC`;

// Full rows, NOT a GROUP BY on `confidence`: a step_check gate is written with
// confidence=NULL on purpose (the stored tier is a milestone-level rollup), so its tier has
// to be derived from factors_json the way /why does it. Grouping on the raw column reports
// every step check as "ungraded".
const GATE_ROWS_SQL = `
  SELECT g.*
  FROM gates g
  LEFT JOIN plans p ON p.id = g.plan_id
  LEFT JOIN runs r ON r.run_id = p.session_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY g.created_at DESC
  LIMIT 5000`;

// Each decision labeled once, by its LATEST gate — the same newest-gate semantics the
// scoreboard and /why use, so the dashboard cannot disagree with the TUI.
const SCOREBOARD_SQL = `
  SELECT d.task_type AS task_type, d.chosen_model AS model, d.actual_cost_usd AS cost,
         g.confidence AS confidence, g.verified_by AS verified_by
  FROM routing_decisions d
  JOIN runs r ON r.run_id = d.run_id
  JOIN gates g ON g.rowid = (
    SELECT g2.rowid FROM gates g2 WHERE g2.rec_id = d.rec_id
    ORDER BY g2.created_at DESC, g2.rowid DESC LIMIT 1
  )
  WHERE (?1 IS NULL OR r.project_key = ?1)
    AND d.task_type IS NOT NULL AND d.chosen_model IS NOT NULL
  ORDER BY d.ts DESC
  LIMIT 5000`;

const TOOLS_SQL = `
  SELECT t.tool_name AS tool, COUNT(*) AS n, COALESCE(SUM(t.is_error), 0) AS errors
  FROM tool_calls t
  JOIN runs r ON r.run_id = t.run_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  GROUP BY t.tool_name
  ORDER BY n DESC
  LIMIT ?2`;

const PLANS_SQL = `
  SELECT p.id, p.session_id, p.title, p.status, p.created_at, p.closed_at,
         (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.id) AS steps,
         (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.id
           AND s.status = 'completed') AS done,
         (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.id
           AND s.status = 'in_progress') AS in_progress,
         (SELECT COUNT(*) FROM gates g WHERE g.plan_id = p.id) AS gates,
         (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.id
           AND s.verify IS NOT NULL AND TRIM(s.verify) <> '') AS verify_steps,
         (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.id
           AND s.verify IS NOT NULL AND TRIM(s.verify) <> ''
           AND s.baseline IS NOT NULL) AS baseline_steps,
         r.project_key AS project_key,
         (SELECT MAX(e.ts) FROM events e WHERE e.run_id = p.session_id) AS last_event,
         (SELECT COUNT(*) FROM file_changes f WHERE f.plan_id = p.id) AS changes
  FROM plans p
  LEFT JOIN runs r ON r.run_id = p.session_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.run_id = p.session_id), 0) DESC,
           p.created_at DESC
  LIMIT ?2`;

const PLAN_STEPS_SQL = `
  SELECT id, plan_id, idx, content, status, verify, baseline, check_origin, verify_cwd
  FROM plan_steps WHERE plan_id = ?1 ORDER BY idx ASC`;

// Every gate for the plan, oldest first, so a step's evidence reads as a history and the
// newest verdict is simply the last one. Tiers are derived in stats.ts via gateVerdictFor.
const PLAN_GATES_SQL = `
  SELECT * FROM gates WHERE plan_id = ?1 ORDER BY created_at ASC, rowid ASC`;

const PLAN_CHANGES_SQL = `
  SELECT id, plan_id, step_id, path, kind, origin, created_at
  FROM file_changes WHERE plan_id = ?1 ORDER BY created_at ASC`;

const STEP_COSTS_SQL = `
  SELECT step_id, SUM(COALESCE(actual_cost_usd, 0)) AS cost_usd
  FROM routing_decisions
  WHERE step_id IN (SELECT id FROM plan_steps WHERE plan_id = ?1)
  GROUP BY step_id`;

const MEMORIES_SQL = `
  SELECT id, project_key, kind, status, origin, evidence_source, content, trigger, updated
  FROM memories
  WHERE (?1 IS NULL OR project_key = ?1) AND invalidated_at IS NULL
  ORDER BY updated DESC
  LIMIT ?2`;

export class DashboardStore {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = defaultDbPath()) {
    this.path = path;
    try {
      this.db = new Database(path, { readonly: true });
      this.db.exec("PRAGMA busy_timeout=5000");
    } catch (e) {
      throw new LedgerUnavailableError(
        `cannot open the harness ledger at ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Ledger schema version, or 0 when the DB predates schema_meta. */
  schemaVersion(): number {
    try {
      const row = this.db.query("SELECT version FROM schema_meta LIMIT 1").get() as {
        version: number;
      } | null;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  projects(): ProjectSummary[] {
    return this.db
      .query(
        `SELECT p.project_key, p.namespace, p.created,
                (SELECT COUNT(*) FROM runs r WHERE r.project_key = p.project_key) AS runs,
                (SELECT MAX(r.updated) FROM runs r WHERE r.project_key = p.project_key)
                  AS last_activity
         FROM projects p
         ORDER BY last_activity DESC`,
      )
      .all() as ProjectSummary[];
  }

  runs(scope: Scope, limit = 50): RunSummary[] {
    return this.db.query(RUNS_SQL).all(scope, limit) as RunSummary[];
  }

  decisions(scope: Scope, limit = 2000): DecisionRecord[] {
    return this.db.query(DECISIONS_SQL).all(scope, limit) as DecisionRecord[];
  }

  modelMix(scope: Scope): ModelMixRow[] {
    return this.db.query(MODEL_MIX_SQL).all(scope) as ModelMixRow[];
  }

  spendByDay(scope: Scope): DayRow[] {
    return this.db.query(SPEND_BY_DAY_SQL).all(scope) as DayRow[];
  }

  gateRows(scope: Scope): GateRow[] {
    return this.db.query(GATE_ROWS_SQL).all(scope) as GateRow[];
  }

  scoreboardRows(scope: Scope): ScoreboardRow[] {
    return this.db.query(SCOREBOARD_SQL).all(scope) as ScoreboardRow[];
  }

  tools(scope: Scope, limit = 20): ToolRow[] {
    return this.db.query(TOOLS_SQL).all(scope, limit) as ToolRow[];
  }

  plans(scope: Scope, limit = 50): PlanSummary[] {
    return this.db.query(PLANS_SQL).all(scope, limit) as PlanSummary[];
  }

  /**
   * Look up ONE recorded write by (plan, exact recorded path), with the run's project root.
   *
   * This is the whole basis of the file viewer's safety: a request references a ledger row, not
   * a filesystem path, so no caller-supplied string ever reaches the disk. A path that was
   * never recorded simply has no row and the viewer 404s.
   */
  recordedFile(
    planId: string,
    path: string,
  ): { path: string; project_key: string | null; kind: string; step_id: string | null } | null {
    return this.db
      .query(
        `SELECT f.path, f.kind, f.step_id, r.project_key
         FROM file_changes f
         JOIN plans p ON p.id = f.plan_id
         LEFT JOIN runs r ON r.run_id = p.session_id
         WHERE f.plan_id = ?1 AND f.path = ?2
         LIMIT 1`,
      )
      .get(planId, path) as {
      path: string;
      project_key: string | null;
      kind: string;
      step_id: string | null;
    } | null;
  }

  /** One plan and everything attached to it. null = no such plan. */
  planDetail(planId: string): PlanDetail | null {
    const plan = this.db
      .query(PLANS_SQL.replace("(?1 IS NULL OR r.project_key = ?1)", "p.id = ?1"))
      .get(planId, 1) as PlanSummary | null;
    if (!plan) return null;
    const routed = plan.session_id
      ? (this.db
          .query(
            `SELECT COALESCE(SUM(actual_cost_usd), 0) AS total
             FROM routing_decisions WHERE run_id = ?1`,
          )
          .get(plan.session_id) as { total: number } | null)
      : null;
    return {
      plan,
      steps: this.db.query(PLAN_STEPS_SQL).all(planId) as PlanStepRow[],
      gates: this.db.query(PLAN_GATES_SQL).all(planId) as GateRow[],
      changes: this.db.query(PLAN_CHANGES_SQL).all(planId) as FileChangeRow[],
      stepCosts: this.db.query(STEP_COSTS_SQL).all(planId) as {
        step_id: string;
        cost_usd: number;
      }[],
      runRoutedUsd: routed?.total ?? 0,
    };
  }

  memories(scope: Scope, limit = 100): MemorySummary[] {
    return this.db.query(MEMORIES_SQL).all(scope, limit) as MemorySummary[];
  }

  budgets(limit = 50): BudgetSummary[] {
    return this.db
      .query(
        `SELECT scope_key, limit_usd, spent_usd, reserved_usd, mode, updated
         FROM budgets ORDER BY updated DESC LIMIT ?1`,
      )
      .all(limit) as BudgetSummary[];
  }

  runDetail(runId: string): RunDetail | null {
    const run = this.db
      .query(`${RUNS_SQL.replace("(?1 IS NULL OR r.project_key = ?1)", "r.run_id = ?1")}`)
      .get(runId, 1) as RunSummary | null;
    if (!run) return null;
    const decisions = this.db
      .query(DECISIONS_SQL.replace("(?1 IS NULL OR r.project_key = ?1)", "r.run_id = ?1"))
      .all(runId, 500) as DecisionRecord[];
    const tools = this.db
      .query(TOOLS_SQL.replace("(?1 IS NULL OR r.project_key = ?1)", "r.run_id = ?1"))
      .all(runId, 20) as ToolRow[];
    const plans = this.db
      .query(PLANS_SQL.replace("(?1 IS NULL OR r.project_key = ?1)", "p.session_id = ?1"))
      .all(runId, 20) as PlanSummary[];
    return { run, decisions, tools, plans };
  }

  close(): void {
    this.db.close();
  }
}
