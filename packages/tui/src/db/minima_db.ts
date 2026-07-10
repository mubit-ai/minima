/**
 * MinimaDb — the durable, queryable record of every run (the persistence spine).
 *
 * Event-sourced SQLite (bun:sqlite, WAL): `events` is the append-only source of truth for
 * one run; `routing_decisions` is one row per routed prompt — the replay buffer for
 * regret-vs-oracle metrics AND the provenance substrate for the (later) signed work
 * record. `rec_id` (the server's recommendation_id) is the JOIN KEY linking a local row to
 * the hosted decision log, `/v1/feedback`, and Mubit `recordOutcome`.
 *
 * Identity: `{project_key = repoIdentity(cwd), run_id = newId()}` — the DB owns run_id;
 * the provider prompt-cache key (`agent.sessionId`) is stored as a plain column, never a
 * PK. Payloads are JSON (never pickle/msgpack). Writes are fail-open at the RUN boundary:
 * a failed write marks the run `degraded`, it never breaks the turn.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Baseline,
  ConfidenceTier,
  GateKind,
  GateOutcome,
  UserAction,
  VerifiedBy,
} from "../minima/gt_contract.ts";

export function defaultDbPath(): string {
  return process.env.MINIMA_DB_PATH?.trim() || join(homedir(), ".minima-harness", "minima.db");
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Ordered, idempotent migrations. schema_meta.version = index of the last applied + 1. */
const MIGRATIONS: string[][] = [
  // v1 — core spine
  [
    `CREATE TABLE IF NOT EXISTS projects (
       project_key TEXT PRIMARY KEY,
       namespace   TEXT,
       created     REAL NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS runs (
       run_id              TEXT PRIMARY KEY,  -- DB-owned; NOT the provider session id
       project_key         TEXT NOT NULL REFERENCES projects(project_key),
       provider_session_id TEXT,
       display_name        TEXT,
       parent_run_id       TEXT REFERENCES runs(run_id),
       forked_from_event_id TEXT,
       git_base_sha        TEXT,
       status              TEXT NOT NULL DEFAULT 'active',
       created REAL NOT NULL,
       updated REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_runs_project ON runs(project_key, updated DESC)",
    `CREATE TABLE IF NOT EXISTS events (
       id        TEXT PRIMARY KEY,
       run_id    TEXT NOT NULL REFERENCES runs(run_id),
       parent_id TEXT,
       agent_id  TEXT,             -- NULL = lead; child id for sub-agents
       type      TEXT NOT NULL,    -- user|assistant|tool|system|routing
       ts        REAL NOT NULL,
       payload   TEXT NOT NULL     -- JSON only
     )`,
    "CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id, ts)",
    `CREATE TABLE IF NOT EXISTS routing_decisions (
       rec_id   TEXT PRIMARY KEY,  -- recommendationId: local <-> hosted <-> Mubit join key
       run_id   TEXT NOT NULL REFERENCES runs(run_id),
       event_id TEXT,
       agent_id TEXT,
       parent_rec_id TEXT,
       task_label TEXT, task_type TEXT, difficulty TEXT,
       chosen_model TEXT, decision_basis TEXT,
       selection_policy TEXT,
       confidence REAL, threshold_used REAL,
       ranked TEXT,                -- JSON Ranking[]
       est_cost_usd REAL, est_cost_low REAL, est_cost_high REAL,
       all_premium_cost_usd REAL,  -- max over ranked[].est_cost (true all-premium anchor)
       configured_baseline_cost_usd REAL,
       actual_cost_usd REAL,
       quality REAL,
       judged INTEGER NOT NULL DEFAULT 0,  -- 0 = cadence-skip/abstain
       outcome TEXT,               -- success|partial|failure|abstain|aborted
       routed  TEXT NOT NULL DEFAULT 'server',  -- server|offline|pinned
       turns INTEGER, latency_ms INTEGER,
       ts REAL NOT NULL,
       schema_v INTEGER NOT NULL DEFAULT 1,
       synced INTEGER NOT NULL DEFAULT 0
     )`,
    "CREATE INDEX IF NOT EXISTS ix_decisions_run ON routing_decisions(run_id, ts)",
    `CREATE TABLE IF NOT EXISTS tool_calls (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL REFERENCES runs(run_id),
       event_id TEXT,
       agent_id TEXT,
       tool_name TEXT NOT NULL,
       args TEXT,                  -- JSON
       result TEXT,                -- first text block, truncated
       is_error INTEGER NOT NULL DEFAULT 0,
       ts REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_tool_calls_run ON tool_calls(run_id, ts)",
  ],
  // v2 — budget ledger + feedback provenance
  [
    // One row per budget scope. Cross-process safety: reserve/reconcile run inside a
    // BEGIN IMMEDIATE transaction (single writer) with a guarded UPDATE, so two
    // concurrent sessions sharing a scope can never jointly overshoot.
    `CREATE TABLE IF NOT EXISTS budgets (
       scope_key   TEXT PRIMARY KEY,   -- e.g. "session:<run_id>" | "project:<key>"
       limit_usd   REAL NOT NULL,
       spent_usd   REAL NOT NULL DEFAULT 0,
       reserved_usd REAL NOT NULL DEFAULT 0,
       mode        TEXT NOT NULL DEFAULT 'warn',  -- shadow|warn|enforce
       created REAL NOT NULL, updated REAL NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS budget_events (
       id TEXT PRIMARY KEY,
       scope_key TEXT NOT NULL,
       run_id TEXT,
       rec_id TEXT,
       kind TEXT NOT NULL,             -- reserve|reconcile|release|threshold|deny
       amount_usd REAL,
       spent_usd REAL NOT NULL,
       reserved_usd REAL NOT NULL,
       limit_usd REAL NOT NULL,
       note TEXT,
       ts REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_budget_events_scope ON budget_events(scope_key, ts)",
    // Mubit-side provenance ids from FeedbackResponse (previously discarded).
    "ALTER TABLE routing_decisions ADD COLUMN reinforced_entry_ids TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN lesson_promoted INTEGER",
  ],
  // v3 — Ground-Truth ledger: the plan + its steps (behind MINIMA_TUI_GROUND_TRUTH).
  // `verify` (M3.1) and `baseline` (M3.3) are carried from the start so the red→green
  // machinery can fill them without another migration.
  [
    `CREATE TABLE IF NOT EXISTS plans (
       id         TEXT PRIMARY KEY,
       session_id TEXT,              -- the run this plan belongs to (runs.run_id)
       title      TEXT,
       status     TEXT,              -- active|done
       created_at TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_plans_session ON plans(session_id, created_at)",
    `CREATE TABLE IF NOT EXISTS plan_steps (
       id         TEXT PRIMARY KEY,
       plan_id    TEXT NOT NULL REFERENCES plans(id),
       idx        INTEGER NOT NULL,  -- 0-based position within the plan
       content    TEXT,
       status     TEXT,              -- pending|in_progress|completed
       verify     TEXT,              -- M3.1: proposed check command (NULL until attached)
       baseline   TEXT,              -- M3.3: red|green|unrunnable (NULL until captured)
       created_at TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_plan_steps_plan ON plan_steps(plan_id, idx)",
  ],
  // v4 — file_changes: every agent write/edit attributed to the in-progress step, with a
  // drift marker (origin) when the path was not claimed by that step.
  [
    `CREATE TABLE IF NOT EXISTS file_changes (
       id         TEXT PRIMARY KEY,
       plan_id    TEXT NOT NULL REFERENCES plans(id),
       step_id    TEXT REFERENCES plan_steps(id),  -- NULL when no step is in progress
       path       TEXT NOT NULL,
       kind       TEXT,              -- created|modified|deleted
       origin     TEXT,              -- on_plan|off_plan (drift)
       created_at TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_file_changes_plan ON file_changes(plan_id, created_at)",
  ],
  // v5 — verification records: gate rows, user overrides, and the grounded outcome stamped
  // back onto the routing decision (distinct GT columns so they never clobber the
  // judge/feedback `outcome`/`confidence`).
  [
    `CREATE TABLE IF NOT EXISTS gates (
       id           TEXT PRIMARY KEY,
       plan_id      TEXT REFERENCES plans(id),
       step_id      TEXT REFERENCES plan_steps(id),
       kind         TEXT,            -- step_check|milestone
       outcome      TEXT,            -- verified|failed|unrunnable
       confidence   TEXT,            -- green|yellow|red (NULL until computed)
       verified_by  TEXT,            -- deterministic|judge|user
       factors_json TEXT,            -- JSON of the raw factors
       created_at   TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_gates_plan ON gates(plan_id, created_at)",
    `CREATE TABLE IF NOT EXISTS user_signals (
       id      TEXT PRIMARY KEY,
       gate_id TEXT REFERENCES gates(id),
       action  TEXT,                 -- accept|reject|steer
       at      TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_user_signals_gate ON user_signals(gate_id, at)",
    "ALTER TABLE routing_decisions ADD COLUMN gt_outcome TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN gt_verified_by TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN gt_confidence TEXT",
  ],
];

export interface RunRow {
  run_id: string;
  project_key: string;
  provider_session_id: string | null;
  display_name: string | null;
  parent_run_id: string | null;
  git_base_sha: string | null;
  status: string;
  created: number;
  updated: number;
}

export interface EventRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  agent_id: string | null;
  type: string;
  ts: number;
  payload: string;
}

export interface DecisionWrite {
  recId: string;
  runId: string;
  eventId?: string | null;
  agentId?: string | null;
  parentRecId?: string | null;
  taskLabel: string;
  taskType?: string | null;
  difficulty?: string | null;
  chosenModel: string | null;
  decisionBasis: string;
  selectionPolicy?: string | null;
  confidence: number;
  thresholdUsed: number;
  ranked: unknown[];
  estCostUsd: number;
  estCostLow?: number | null;
  estCostHigh?: number | null;
  allPremiumCostUsd?: number | null;
  configuredBaselineCostUsd?: number | null;
  actualCostUsd: number;
  quality: number | null;
  judged: boolean;
  outcome: string;
  routed?: "server" | "offline" | "pinned";
  turns: number;
  latencyMs: number;
  /** Mubit-side provenance from FeedbackResponse (v2 columns). */
  reinforcedEntryIds?: string[] | null;
  lessonPromoted?: boolean | null;
}

// ---------------------------------------------------------------- ground-truth rows
export interface PlanRow {
  id: string;
  session_id: string | null;
  title: string | null;
  status: string | null;
  created_at: string | null;
}

export interface PlanStepRow {
  id: string;
  plan_id: string;
  idx: number;
  content: string | null;
  status: string | null;
  verify: string | null;
  baseline: Baseline | null;
  created_at: string | null;
}

export interface FileChangeRow {
  id: string;
  plan_id: string;
  step_id: string | null;
  path: string;
  kind: string | null;
  origin: string | null;
  created_at: string | null;
}

export interface GateRow {
  id: string;
  plan_id: string | null;
  step_id: string | null;
  kind: GateKind | null;
  outcome: GateOutcome | null;
  confidence: ConfidenceTier | null;
  verified_by: VerifiedBy | null;
  factors_json: string | null;
  created_at: string | null;
}

/** One todo as handed to the ledger (a subset of the todowrite tool's TodoTask). */
export interface TodoInput {
  content: string;
  status: string;
  verify?: string | null;
}

export class MinimaDb {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = defaultDbPath()) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
    const row = this.db.query("SELECT version FROM schema_meta").get() as {
      version: number;
    } | null;
    let version = row?.version ?? 0;
    if (!row) this.db.exec("INSERT INTO schema_meta VALUES (0)");
    while (version < MIGRATIONS.length) {
      const steps = MIGRATIONS[version]!;
      const apply = this.db.transaction(() => {
        for (const ddl of steps) this.db.exec(ddl);
        this.db.exec("UPDATE schema_meta SET version = ?", [version + 1]);
      });
      apply();
      version += 1;
    }
  }

  get schemaVersion(): number {
    return (this.db.query("SELECT version FROM schema_meta").get() as { version: number }).version;
  }

  // ---------------------------------------------------------------- projects / runs
  ensureProject(projectKey: string, namespace?: string | null): void {
    this.db.run(
      `INSERT INTO projects (project_key, namespace, created) VALUES (?, ?, ?)
       ON CONFLICT(project_key) DO UPDATE SET namespace = COALESCE(excluded.namespace, namespace)`,
      [projectKey, namespace ?? null, Date.now() / 1000],
    );
  }

  startRun(opts: {
    runId?: string;
    projectKey: string;
    providerSessionId?: string | null;
    parentRunId?: string | null;
    forkedFromEventId?: string | null;
    gitBaseSha?: string | null;
  }): string {
    const runId = opts.runId ?? newId();
    const now = Date.now() / 1000;
    this.db.run(
      `INSERT INTO runs (run_id, project_key, provider_session_id, parent_run_id,
                         forked_from_event_id, git_base_sha, status, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        runId,
        opts.projectKey,
        opts.providerSessionId ?? null,
        opts.parentRunId ?? null,
        opts.forkedFromEventId ?? null,
        opts.gitBaseSha ?? null,
        now,
        now,
      ],
    );
    return runId;
  }

  finishRun(runId: string, status: "done" | "aborted" | "degraded" = "done"): void {
    // Never downgrade a degraded run back to done — degraded means "rows may be missing".
    this.db.run(
      `UPDATE runs SET status = CASE WHEN status = 'degraded' AND ?1 = 'done' THEN 'degraded' ELSE ?1 END,
                       updated = ?2 WHERE run_id = ?3`,
      [status, Date.now() / 1000, runId],
    );
  }

  markDegraded(runId: string): void {
    this.db.run("UPDATE runs SET status = 'degraded', updated = ? WHERE run_id = ?", [
      Date.now() / 1000,
      runId,
    ]);
  }

  setRunName(runId: string, name: string): void {
    this.db.run("UPDATE runs SET display_name = ?, updated = ? WHERE run_id = ?", [
      name,
      Date.now() / 1000,
      runId,
    ]);
  }

  getRun(runId: string): RunRow | null {
    return (this.db.query("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow) ?? null;
  }

  /** Record resume/fork lineage: this run continues from `parentRunId`. */
  setRunParent(runId: string, parentRunId: string, forkedFromEventId?: string | null): void {
    this.db.run(
      "UPDATE runs SET parent_run_id = ?, forked_from_event_id = ?, updated = ? WHERE run_id = ?",
      [parentRunId, forkedFromEventId ?? null, Date.now() / 1000, runId],
    );
  }

  countEvents(runId: string): number {
    const row = this.db.query("SELECT count(*) AS n FROM events WHERE run_id = ?").get(runId) as {
      n: number;
    };
    return row.n;
  }

  listRuns(projectKey: string, limit = 25): RunRow[] {
    return this.db
      .query("SELECT * FROM runs WHERE project_key = ? ORDER BY updated DESC LIMIT ?")
      .all(projectKey, limit) as RunRow[];
  }

  // ---------------------------------------------------------------- events / tools
  appendEvent(opts: {
    id?: string;
    runId: string;
    parentId?: string | null;
    agentId?: string | null;
    type: string;
    payload: unknown;
    ts?: number;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO events (id, run_id, parent_id, agent_id, type, ts, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.runId,
        opts.parentId ?? null,
        opts.agentId ?? null,
        opts.type,
        opts.ts ?? Date.now() / 1000,
        JSON.stringify(opts.payload),
      ],
    );
    return id;
  }

  getRunEvents(runId: string): EventRow[] {
    return this.db
      .query("SELECT * FROM events WHERE run_id = ? ORDER BY ts, rowid")
      .all(runId) as EventRow[];
  }

  writeToolCall(opts: {
    id?: string;
    runId: string;
    eventId?: string | null;
    agentId?: string | null;
    toolName: string;
    args: unknown;
    result: string;
    isError: boolean;
    ts?: number;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      `INSERT INTO tool_calls (id, run_id, event_id, agent_id, tool_name, args, result, is_error, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.runId,
        opts.eventId ?? null,
        opts.agentId ?? null,
        opts.toolName,
        JSON.stringify(opts.args ?? null),
        opts.result.slice(0, 4000),
        opts.isError ? 1 : 0,
        opts.ts ?? Date.now() / 1000,
      ],
    );
    return id;
  }

  /** Run a batch of writes in one transaction (per-turn atomicity for the sink). */
  transact(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- routing decisions
  /**
   * One row per routed prompt — idempotent on rec_id (a retried write updates in place,
   * never duplicates the hosted join key).
   */
  writeDecision(d: DecisionWrite): void {
    this.db.run(
      `INSERT INTO routing_decisions (
         rec_id, run_id, event_id, agent_id, parent_rec_id, task_label, task_type, difficulty,
         chosen_model, decision_basis, selection_policy, confidence, threshold_used, ranked,
         est_cost_usd, est_cost_low, est_cost_high, all_premium_cost_usd,
         configured_baseline_cost_usd, actual_cost_usd, quality, judged, outcome, routed,
         turns, latency_ms, reinforced_entry_ids, lesson_promoted, ts, schema_v, synced
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 0)
       ON CONFLICT(rec_id) DO UPDATE SET
         actual_cost_usd = excluded.actual_cost_usd,
         quality = excluded.quality, judged = excluded.judged, outcome = excluded.outcome,
         turns = excluded.turns, latency_ms = excluded.latency_ms,
         reinforced_entry_ids = excluded.reinforced_entry_ids,
         lesson_promoted = excluded.lesson_promoted`,
      [
        d.recId,
        d.runId,
        d.eventId ?? null,
        d.agentId ?? null,
        d.parentRecId ?? null,
        d.taskLabel,
        d.taskType ?? null,
        d.difficulty ?? null,
        d.chosenModel,
        d.decisionBasis,
        d.selectionPolicy ?? null,
        d.confidence,
        d.thresholdUsed,
        JSON.stringify(d.ranked),
        d.estCostUsd,
        d.estCostLow ?? null,
        d.estCostHigh ?? null,
        d.allPremiumCostUsd ?? null,
        d.configuredBaselineCostUsd ?? null,
        d.actualCostUsd,
        d.quality,
        d.judged ? 1 : 0,
        d.outcome,
        d.routed ?? "server",
        d.turns,
        d.latencyMs,
        d.reinforcedEntryIds?.length ? JSON.stringify(d.reinforcedEntryIds) : null,
        d.lessonPromoted === null || d.lessonPromoted === undefined
          ? null
          : d.lessonPromoted
            ? 1
            : 0,
        Date.now() / 1000,
      ],
    );
  }

  getRunDecisions(runId: string): Record<string, unknown>[] {
    return this.db
      .query("SELECT * FROM routing_decisions WHERE run_id = ? ORDER BY ts")
      .all(runId) as Record<string, unknown>[];
  }

  // ================================================================ ground-truth ledger
  // Writers/readers behind MINIMA_TUI_GROUND_TRUTH. Fail-open at the call site (a broken
  // write must never break a turn); these throw only on genuine DB errors.

  /** M0.2: create a plan row. Returns its id. */
  insertPlan(opts: {
    id?: string;
    sessionId?: string | null;
    title?: string | null;
    status?: string;
  }): string {
    const id = opts.id ?? newId();
    this.db.run("INSERT INTO plans (id, session_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)", [
      id,
      opts.sessionId ?? null,
      opts.title ?? null,
      opts.status ?? "active",
      new Date().toISOString(),
    ]);
    return id;
  }

  /** The newest still-active plan for a session (run), or null. */
  getActivePlan(sessionId: string): PlanRow | null {
    return (
      (this.db
        .query(
          "SELECT * FROM plans WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(sessionId) as PlanRow) ?? null
    );
  }

  getLatestPlan(sessionId: string): PlanRow | null {
    return (
      (this.db
        .query(
          "SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(sessionId) as PlanRow) ?? null
    );
  }

  getPlan(planId: string): PlanRow | null {
    return (this.db.query("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow) ?? null;
  }

  setPlanStatus(planId: string, status: string): void {
    this.db.run("UPDATE plans SET status = ? WHERE id = ?", [status, planId]);
  }

  /** M0.3: insert one step. Returns its id. */
  insertStep(opts: {
    id?: string;
    planId: string;
    idx: number;
    content?: string | null;
    status?: string;
    verify?: string | null;
    baseline?: Baseline | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO plan_steps (id, plan_id, idx, content, status, verify, baseline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.planId,
        opts.idx,
        opts.content ?? null,
        opts.status ?? "pending",
        opts.verify ?? null,
        opts.baseline ?? null,
        new Date().toISOString(),
      ],
    );
    return id;
  }

  getPlanSteps(planId: string): PlanStepRow[] {
    return this.db
      .query("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY idx")
      .all(planId) as PlanStepRow[];
  }

  /** The first in-progress step of a plan (the one file changes attribute to), or null. */
  getInProgressStep(planId: string): PlanStepRow | null {
    return (
      (this.db
        .query("SELECT * FROM plan_steps WHERE plan_id = ? AND status = 'in_progress' ORDER BY idx LIMIT 1")
        .get(planId) as PlanStepRow) ?? null
    );
  }

  setStepStatus(stepId: string, status: string): void {
    this.db.run("UPDATE plan_steps SET status = ? WHERE id = ?", [status, stepId]);
  }

  /** M3.3: record the pre-work baseline (red|green|unrunnable) for a step. */
  setStepBaseline(stepId: string, baseline: Baseline): void {
    this.db.run("UPDATE plan_steps SET baseline = ? WHERE id = ?", [baseline, stepId]);
  }

  /**
   * M1.1: upsert the agent's todo list as a plan + steps for `sessionId`. Reuses the active
   * plan (once per task) and matches steps by `idx`, so step ids stay stable across
   * todowrite calls (file_changes / baselines keep pointing at the same step). Trailing
   * steps are dropped when the list shrinks. A step's `verify` is preserved unless a new
   * value is supplied.
   */
  upsertPlanFromTodos(
    sessionId: string,
    tasks: TodoInput[],
    title?: string | null,
  ): { planId: string; stepIds: string[] } {
    const existingPlan = this.getActivePlan(sessionId);
    const planId =
      existingPlan?.id ??
      this.insertPlan({ sessionId, title: title ?? tasks[0]?.content ?? null, status: "active" });
    const byIdx = new Map(this.getPlanSteps(planId).map((s) => [s.idx, s]));
    const stepIds: string[] = [];
    const tx = this.db.transaction(() => {
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const prev = byIdx.get(i);
        if (prev) {
          this.db.run("UPDATE plan_steps SET content = ?, status = ?, verify = COALESCE(?, verify) WHERE id = ?", [
            t.content,
            t.status,
            t.verify ?? null,
            prev.id,
          ]);
          stepIds.push(prev.id);
        } else {
          stepIds.push(
            this.insertStep({ planId, idx: i, content: t.content, status: t.status, verify: t.verify ?? null }),
          );
        }
      }
      this.db.run("DELETE FROM plan_steps WHERE plan_id = ? AND idx >= ?", [planId, tasks.length]);
    });
    tx();
    return { planId, stepIds };
  }

  // ---------------------------------------------------------------- file changes (M2.1/M2.2)
  insertFileChange(opts: {
    id?: string;
    planId: string;
    stepId?: string | null;
    path: string;
    kind?: string | null;
    origin?: string | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO file_changes (id, plan_id, step_id, path, kind, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.planId,
        opts.stepId ?? null,
        opts.path,
        opts.kind ?? null,
        opts.origin ?? null,
        new Date().toISOString(),
      ],
    );
    return id;
  }

  getFileChanges(planId: string): FileChangeRow[] {
    return this.db
      .query("SELECT * FROM file_changes WHERE plan_id = ? ORDER BY created_at, rowid")
      .all(planId) as FileChangeRow[];
  }

  /** M2.3: how many off-plan (drift) file changes exist for a plan. */
  countOffPlanChanges(planId: string): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM file_changes WHERE plan_id = ? AND origin = 'off_plan'")
      .get(planId) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------- gates / signals (M4.3/M6.3)
  insertGate(opts: {
    id?: string;
    planId?: string | null;
    stepId?: string | null;
    kind?: GateKind;
    outcome?: GateOutcome;
    confidence?: ConfidenceTier | null;
    verifiedBy?: VerifiedBy | null;
    factors?: unknown;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO gates (id, plan_id, step_id, kind, outcome, confidence, verified_by, factors_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.planId ?? null,
        opts.stepId ?? null,
        opts.kind ?? "step_check",
        opts.outcome ?? null,
        opts.confidence ?? null,
        opts.verifiedBy ?? null,
        opts.factors === undefined ? null : JSON.stringify(opts.factors),
        new Date().toISOString(),
      ],
    );
    return id;
  }

  getGates(planId: string): GateRow[] {
    return this.db
      .query("SELECT * FROM gates WHERE plan_id = ? ORDER BY created_at, rowid")
      .all(planId) as GateRow[];
  }

  /** M6.3: record a user override against a gate (accept|reject|steer). */
  recordUserSignal(gateId: string, action: UserAction): string {
    const id = newId();
    this.db.run("INSERT INTO user_signals (id, gate_id, action, at) VALUES (?, ?, ?, ?)", [
      id,
      gateId,
      action,
      new Date().toISOString(),
    ]);
    return id;
  }

  // ---------------------------------------------------------------- grounded outcome (M7.1)
  /** Stamp the step's real (deterministic) result onto its routing decision. */
  attachGroundedOutcome(
    recId: string,
    o: { outcome: GateOutcome; verifiedBy: VerifiedBy; confidence?: ConfidenceTier | null },
  ): void {
    this.db.run(
      "UPDATE routing_decisions SET gt_outcome = ?, gt_verified_by = ?, gt_confidence = ? WHERE rec_id = ?",
      [o.outcome, o.verifiedBy, o.confidence ?? null, recId],
    );
  }

  close(): void {
    this.db.close();
  }
}
