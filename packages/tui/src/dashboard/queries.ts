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
import { defaultDbPath } from "../db/minima_db.ts";

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
  status: string;
  created: number;
  updated: number;
  decisions: number;
  cost_usd: number;
  tool_calls: number;
  tool_errors: number;
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

export interface TierRow {
  tier: string | null;
  n: number;
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
  status: string | null;
  created_at: string | null;
  closed_at: number | null;
  steps: number;
  done: number;
  gates: number;
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
           WHERE t.run_id = r.run_id) AS tool_errors
  FROM runs r
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY r.updated DESC
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

const GATE_TIERS_SQL = `
  SELECT g.confidence AS tier, COUNT(*) AS n
  FROM gates g
  LEFT JOIN plans p ON p.id = g.plan_id
  LEFT JOIN runs r ON r.run_id = p.session_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  GROUP BY g.confidence`;

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
         (SELECT COUNT(*) FROM gates g WHERE g.plan_id = p.id) AS gates
  FROM plans p
  LEFT JOIN runs r ON r.run_id = p.session_id
  WHERE (?1 IS NULL OR r.project_key = ?1)
  ORDER BY p.created_at DESC
  LIMIT ?2`;

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

  gateTiers(scope: Scope): TierRow[] {
    return this.db.query(GATE_TIERS_SQL).all(scope) as TierRow[];
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
