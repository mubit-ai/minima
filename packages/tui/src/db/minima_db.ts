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
  CheckOrigin,
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

function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}

function tokenJaccard(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / (ta.size + tb.size - hit);
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
  // v6 — gate identity: rec_id scopes every gate row to the routed rung that minted it
  // (NULL = pre-identity/manual, invisible to the feedback join by construction);
  // session_id/agent_id are reporting/provenance only, never feedback inputs. plans.closed_at
  // records closure; plan_steps.verify_cwd carries a per-check working dir (writer added in v7
  // era — sticky through upsertPlanFromTodos, passed to runCheck); user_signals.note carries the
  // steer key's free text.
  [
    "ALTER TABLE gates ADD COLUMN rec_id TEXT",
    "ALTER TABLE gates ADD COLUMN session_id TEXT",
    "ALTER TABLE gates ADD COLUMN agent_id TEXT",
    "ALTER TABLE file_changes ADD COLUMN agent_id TEXT",
    "ALTER TABLE plans ADD COLUMN closed_at REAL",
    "ALTER TABLE plan_steps ADD COLUMN verify_cwd TEXT",
    "ALTER TABLE user_signals ADD COLUMN note TEXT",
    "CREATE INDEX IF NOT EXISTS ix_gates_rec ON gates(rec_id)",
    "CREATE INDEX IF NOT EXISTS ix_gates_session ON gates(session_id, created_at)",
  ],
  // v7 — check provenance: plan_steps.check_origin records who authored a step's check when it
  // is known up-front (currently 'user' — a check the user accepted at /plan finalize, i.e. NOT
  // agent-graded homework). NULL means "compute at gate time from the verify + file changes"
  // (classifyCheckOrigin); a non-NULL value overrides that computation. Provenance is a fact
  // about who wrote the check, so it persists across content edits (unlike verify/baseline).
  [
    "ALTER TABLE plan_steps ADD COLUMN check_origin TEXT", // pre_existing|agent_new|user (NULL=compute)
  ],
  // v8 — A6 per-step tool allowlist: plan_steps.tools holds a JSON array of the tool names a step
  // is permitted to call (e.g. ["read","edit","bash"]). NULL or an empty array means unrestricted
  // (the historical behavior — no enforcement). Sticky through upsertPlanFromTodos like verify:
  // omit to keep, resend to overwrite, never clear. The dispatcher (tool_permissions.ts) hard-
  // blocks a mutating tool call absent from the in-progress step's allowlist when it is non-empty.
  [
    "ALTER TABLE plan_steps ADD COLUMN tools TEXT", // JSON string[] (NULL/[] = unrestricted)
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
  closed_at: number | null;
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
  verify_cwd: string | null;
  check_origin: CheckOrigin | null;
  /** A6: JSON array of permitted tool names, or NULL/"[]" for unrestricted. See tool_permissions.ts. */
  tools: string | null;
}

export interface FileChangeRow {
  id: string;
  plan_id: string;
  step_id: string | null;
  path: string;
  kind: string | null;
  origin: string | null;
  created_at: string | null;
  agent_id: string | null;
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
  rec_id: string | null;
  session_id: string | null;
  agent_id: string | null;
}

export interface UserSignalRow {
  id: string;
  gate_id: string | null;
  action: UserAction | null;
  at: string | null;
  note: string | null;
}

/** One todo as handed to the ledger (a subset of the todowrite tool's TodoTask). */
export interface TodoInput {
  content: string;
  status: string;
  verify?: string | null;
  verify_cwd?: string | null;
  /** A6: per-step tool allowlist. Sticky like verify (omit to keep, resend to overwrite, never clear). */
  tools?: string[] | null;
}

/** M4.1: one step a todowrite would flip to completed — the done-gate's unit of work. */
export interface CompletionFlip {
  content: string;
  /** Matched existing step id; null for a brand-new todo inserted directly as completed. */
  stepId: string | null;
  /** Post-COALESCE effective verify: the todo's, else the matched step's, else null. */
  verify: string | null;
  /** The matched step's pre-work baseline (null for new steps or when never captured). */
  baseline: Baseline | null;
  /** Post-COALESCE working dir for the check (null → runCheck defaults to process.cwd()). */
  verify_cwd: string | null;
  /** Stored check provenance, when known up-front (else null → compute at gate time). */
  check_origin: CheckOrigin | null;
}

/**
 * A6: normalize a per-step tool allowlist to the DB representation. Trimmed non-empty strings only;
 * an empty/absent list serializes to NULL (unrestricted), never "[]" — so a NULL bind through
 * COALESCE in upsertPlanFromTodos preserves an existing allowlist (sticky, like verify). Total.
 */
function serializeToolList(tools: string[] | null | undefined): string | null {
  if (!Array.isArray(tools)) return null;
  const clean = tools.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

export class MinimaDb {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = defaultDbPath()) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout=5000");
    // The delete->WAL header flip needs a brief exclusive lock and does NOT honor the
    // busy handler, so a concurrent fresh open can see SQLITE_BUSY here.
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.db.exec("PRAGMA journal_mode=WAL");
        break;
      } catch (e) {
        if (attempt < 20 && isBusyError(e)) {
          Bun.sleepSync(25);
          continue;
        }
        throw e;
      }
    }
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
    const settled = this.db
      .query("SELECT COUNT(*) AS n, MAX(version) AS v FROM schema_meta")
      .get() as {
      n: number;
      v: number | null;
    };
    if (settled.n === 1 && settled.v !== null && settled.v >= MIGRATIONS.length) return;
    // One batch per IMMEDIATE transaction: the version re-read happens under the write
    // lock, so concurrent openers serialize instead of double-applying a batch.
    const step = this.db.transaction((): boolean => {
      this.db.exec(
        `DELETE FROM schema_meta WHERE rowid NOT IN
           (SELECT rowid FROM schema_meta ORDER BY version DESC, rowid ASC LIMIT 1)`,
      );
      this.db.exec(
        "INSERT INTO schema_meta (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_meta)",
      );
      const version = (
        this.db.query("SELECT version FROM schema_meta").get() as { version: number }
      ).version;
      if (version >= MIGRATIONS.length) return false;
      for (const ddl of MIGRATIONS[version]!) this.execStep(ddl);
      this.db.exec("UPDATE schema_meta SET version = ?", [version + 1]);
      return version + 1 < MIGRATIONS.length;
    });
    for (;;) {
      let more: boolean | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          more = step.immediate();
          break;
        } catch (e) {
          if (attempt < 2 && isBusyError(e)) continue;
          throw e;
        }
      }
      if (!more) break;
    }
  }

  // Self-heal for DBs wedged by the pre-fix race: version regressed while a later batch's
  // columns are already present, so re-applying ADD COLUMN throws forever.
  private execStep(ddl: string): void {
    try {
      this.db.exec(ddl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ADD COLUMN/i.test(ddl) && msg.includes("duplicate column name")) return;
      throw e;
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

  /**
   * Resolve a resume target (B1): exact display_name → case-insensitive name → exact run_id
   * → run_id prefix (only for queries ≥ 4 chars, so short strings don't match everything).
   * Names outrank id prefixes — they are the user-facing handle. Most-recent `updated` wins
   * at every stage. Scoped to projectKey.
   */
  findRunByName(projectKey: string, query: string): RunRow | null {
    const one = (sql: string, ...params: (string | number)[]) =>
      (this.db.query(sql).get(...params) as RunRow) ?? null;
    return (
      one(
        "SELECT * FROM runs WHERE project_key = ? AND display_name = ? ORDER BY updated DESC LIMIT 1",
        projectKey,
        query,
      ) ??
      one(
        "SELECT * FROM runs WHERE project_key = ? AND lower(display_name) = lower(?) ORDER BY updated DESC LIMIT 1",
        projectKey,
        query,
      ) ??
      one(
        "SELECT * FROM runs WHERE project_key = ? AND run_id = ? ORDER BY updated DESC LIMIT 1",
        projectKey,
        query,
      ) ??
      (query.length >= 4
        ? one(
            "SELECT * FROM runs WHERE project_key = ? AND run_id LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT 1",
            projectKey,
            `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
          )
        : null)
    );
  }

  /** Near-matches for a failed resolution (name substring OR id prefix), recency-ordered. */
  searchRuns(projectKey: string, query: string, limit = 5): RunRow[] {
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .query(
        "SELECT * FROM runs WHERE project_key = ? AND (display_name LIKE ? ESCAPE '\\' OR run_id LIKE ? ESCAPE '\\') ORDER BY updated DESC LIMIT ?",
      )
      .all(projectKey, `%${escaped}%`, `${escaped}%`, limit) as RunRow[];
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
    this.db.run(
      "INSERT INTO plans (id, session_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        id,
        opts.sessionId ?? null,
        opts.title ?? null,
        opts.status ?? "active",
        new Date().toISOString(),
      ],
    );
    return id;
  }

  /**
   * Seed a fresh active plan + its steps from an APPROVED ground-truth plan (the planner→ledger
   * bridge). Each step is inserted `pending` with its verify; a step that carries a check is
   * stamped `check_origin='user'` — the user accepted this plan at /plan finalize, so its checks
   * are user-trusted, not agent-graded homework. Once seeded this becomes the session's active
   * plan, so formatPlanProjection carries the verifiable steps into the first execution turn and
   * the agent's first todowrite reuses them (content-match preserves verify + check_origin).
   */
  seedPlanFromSteps(
    sessionId: string,
    title: string | null,
    steps: {
      content: string;
      verify?: string | null;
      verifyCwd?: string | null;
      tools?: string[] | null;
    }[],
  ): { planId: string; stepIds: string[] } {
    const planId = this.insertPlan({ sessionId, title, status: "active" });
    const stepIds: string[] = [];
    const tx = this.db.transaction(() => {
      steps.forEach((st, i) => {
        const verify = st.verify?.trim() ? st.verify.trim() : null;
        stepIds.push(
          this.insertStep({
            planId,
            idx: i,
            content: st.content,
            status: "pending",
            verify,
            verifyCwd: st.verifyCwd?.trim() ? st.verifyCwd.trim() : null,
            checkOrigin: verify ? "user" : null,
            tools: st.tools ?? null,
          }),
        );
      });
    });
    tx();
    return { planId, stepIds };
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
    this.db.run(
      "UPDATE plans SET status = ?, closed_at = CASE WHEN ? = 'active' THEN NULL ELSE COALESCE(closed_at, ?) END WHERE id = ?",
      [status, status, Date.now() / 1000, planId],
    );
  }

  /**
   * Re-key the old run's still-active plans onto the resuming run (MOVE semantics — the last
   * resumer wins on a single-user local DB). Everything plan_id-keyed (steps, file_changes,
   * gates) follows for free; the old run's session-keyed gate rows are deliberately NOT
   * adopted — historical verdicts of past prompts must not leak into the resumed run's
   * feedback. Returns the number of plans moved.
   */
  adoptActivePlans(fromSession: string, toSession: string): number {
    this.db.run("UPDATE plans SET session_id = ? WHERE session_id = ? AND status = 'active'", [
      toSession,
      fromSession,
    ]);
    return (this.db.query("SELECT changes() AS n").get() as { n: number }).n;
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
    verifyCwd?: string | null;
    checkOrigin?: CheckOrigin | null;
    tools?: string[] | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO plan_steps (id, plan_id, idx, content, status, verify, baseline, created_at, verify_cwd, check_origin, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.planId,
        opts.idx,
        opts.content ?? null,
        opts.status ?? "pending",
        opts.verify ?? null,
        opts.baseline ?? null,
        new Date().toISOString(),
        opts.verifyCwd ?? null,
        opts.checkOrigin ?? null,
        serializeToolList(opts.tools),
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
        .query(
          "SELECT * FROM plan_steps WHERE plan_id = ? AND status = 'in_progress' ORDER BY idx LIMIT 1",
        )
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
   * The step matcher SHARED by upsertPlanFromTodos and completionsForTodos — one
   * implementation, computed ONCE per todo list, so the done-gate's preview (M4.1) can never
   * match steps differently than the upsert it previews. Pass 1 is the historical exact
   * trimmed-content match (first-come queues on duplicates). Pass 2 rescues reworded steps:
   * still-unmatched todos adopt a still-unmatched row when their token-set Jaccard is >= 0.6
   * (ties broken by smallest position distance) — so an accidental rewording keeps the step's
   * id, sticky verify, and gate history instead of shedding them. Deterministic, zero deps.
   */
  private matchStepsToTodos(
    existing: PlanStepRow[],
    tasks: TodoInput[],
  ): (PlanStepRow | undefined)[] {
    const out: (PlanStepRow | undefined)[] = new Array(tasks.length).fill(undefined);
    const byContent = new Map<string, PlanStepRow[]>();
    for (const s of existing) {
      const key = (s.content ?? "").trim();
      const queue = byContent.get(key);
      if (queue) queue.push(s);
      else byContent.set(key, [s]);
    }
    const taken = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      const s = byContent.get(tasks[i]!.content.trim())?.shift();
      if (s) {
        out[i] = s;
        taken.add(s.id);
      }
    }
    for (let i = 0; i < tasks.length; i++) {
      if (out[i]) continue;
      let best: PlanStepRow | undefined;
      let bestScore = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const s of existing) {
        if (taken.has(s.id)) continue;
        const score = tokenJaccard(tasks[i]!.content, s.content ?? "");
        if (score < 0.6) continue;
        const dist = Math.abs(s.idx - i);
        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          best = s;
          bestScore = score;
          bestDist = dist;
        }
      }
      if (best) {
        out[i] = best;
        taken.add(best.id);
      }
    }
    return out;
  }

  /**
   * M4.1 preview: which steps WOULD flip to completed if `tasks` were applied via
   * upsertPlanFromTodos. READ-ONLY — writes nothing — and reuses the upsert's exact matching
   * (stepMatcher above). A flip is a todo proposed as completed whose matched step is not
   * already completed, including a brand-new todo inserted directly as completed (stepId
   * null). With no active plan every completed todo is a flip. Each flip carries the
   * post-COALESCE effective verify and the matched step's baseline so the gate can run the
   * right check and score red→green. The preview is only valid against the CURRENT rows:
   * it cannot see other todowrites queued in the same batch, which is why the done-gate
   * enforces one todowrite per assistant message (ground_truth.ts same-batch guard).
   */
  completionsForTodos(sessionId: string, tasks: TodoInput[]): CompletionFlip[] {
    const plan = this.planForTodos(sessionId, tasks);
    const matched = this.matchStepsToTodos(plan ? this.getPlanSteps(plan.id) : [], tasks);
    const flips: CompletionFlip[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      const prev = matched[i];
      if (t.status !== "completed" || prev?.status === "completed") continue;
      // A verify swap invalidates the old baseline: red→green evidence is only meaningful
      // against the check that produced the red, so the flip carries NULL instead.
      const verifyChanged = t.verify != null && prev?.verify != null && t.verify !== prev.verify;
      flips.push({
        content: t.content,
        stepId: prev?.id ?? null,
        verify: t.verify ?? prev?.verify ?? null,
        baseline: verifyChanged ? null : (prev?.baseline ?? null),
        verify_cwd: t.verify_cwd ?? prev?.verify_cwd ?? null,
        check_origin: prev?.check_origin ?? null,
      });
    }
    return flips;
  }

  /**
   * M1.1 + M3.3: upsert the agent's todo list as a plan + steps for `sessionId`. Reuses the
   * active plan (once per task) and matches steps by *content* (trimmed, first-come on
   * duplicates), so step ids — and everything keyed to them: verify, baseline, file_changes —
   * follow the logical step across inserts and reorders instead of binding to whatever row
   * happens to sit at each idx. Rows whose content no longer appears in the list (removed or
   * reworded steps) are dropped, detaching their file_changes/gates first; a reworded step
   * therefore re-enters fresh with NULL verify/baseline — ground truth is lost, never
   * misattributed. A matched step's `verify` is preserved unless a new value is supplied.
   *
   * M3.3: `started` reports the steps whose pre-work baseline should be captured now — a step
   * entering in_progress, a fresh step inserted directly as in_progress, or an in_progress
   * step gaining its first `verify` — always gated on baseline still NULL (capture is
   * once-only). Each entry carries the post-COALESCE effective `verify` (may be null —
   * filtering verify-less steps is the caller's job).
   */
  /**
   * The plan a todowrite would apply to — the active plan, else (reopen over resurrect) the
   * session's latest DONE plan when the incoming contents overlap it, so sticky verify/baseline
   * survive a reopen-after-completion cycle while a disjoint list starts fresh. SHARED by
   * completionsForTodos and upsertPlanFromTodos: the done-gate's preview must resolve the same
   * plan the upsert will, or resends of a completed list would preview as brand-new flips.
   */
  private planForTodos(sessionId: string, tasks: TodoInput[]): PlanRow | null {
    const active = this.getActivePlan(sessionId);
    if (active) return active;
    const latest = this.getLatestPlan(sessionId);
    if (latest && latest.status === "done") {
      const contents = new Set(this.getPlanSteps(latest.id).map((s) => (s.content ?? "").trim()));
      if (tasks.some((t) => contents.has(t.content.trim()))) return latest;
    }
    return null;
  }

  upsertPlanFromTodos(
    sessionId: string,
    tasks: TodoInput[],
    title?: string | null,
  ): {
    planId: string;
    stepIds: string[];
    started: { id: string; verify: string | null; verify_cwd: string | null }[];
  } {
    const existingPlan = this.planForTodos(sessionId, tasks);
    if (existingPlan && existingPlan.status === "done") {
      this.setPlanStatus(existingPlan.id, "active");
    }
    const planId =
      existingPlan?.id ??
      this.insertPlan({ sessionId, title: title ?? tasks[0]?.content ?? null, status: "active" });
    const existing = this.getPlanSteps(planId);
    const matchedSteps = this.matchStepsToTodos(existing, tasks);
    const stepIds: string[] = [];
    const started: { id: string; verify: string | null; verify_cwd: string | null }[] = [];
    const tx = this.db.transaction(() => {
      const matched = new Set<string>();
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        const prev = matchedSteps[i];
        if (prev) {
          matched.add(prev.id);
          // baseline resets whenever the effective verify CHANGES: red→green evidence must
          // always be scoped to the check that produced the red (a swapped-in check crediting
          // the old check's red would fabricate verified_in_production).
          this.db.run(
            "UPDATE plan_steps SET idx = ?, content = ?, status = ?, baseline = CASE WHEN ? IS NOT NULL AND verify IS NOT NULL AND ? <> verify THEN NULL ELSE baseline END, verify = COALESCE(?, verify), verify_cwd = COALESCE(?, verify_cwd), tools = COALESCE(?, tools) WHERE id = ?",
            [
              i,
              t.content,
              t.status,
              t.verify ?? null,
              t.verify ?? null,
              t.verify ?? null,
              t.verify_cwd ?? null,
              serializeToolList(t.tools),
              prev.id,
            ],
          );
          stepIds.push(prev.id);
          const entered = t.status === "in_progress" && prev.status !== "in_progress";
          const gainedVerify =
            t.status === "in_progress" && prev.verify === null && t.verify != null;
          const changedVerify =
            t.status === "in_progress" &&
            t.verify != null &&
            prev.verify !== null &&
            t.verify !== prev.verify;
          if (changedVerify || ((entered || gainedVerify) && prev.baseline === null)) {
            started.push({
              id: prev.id,
              verify: t.verify ?? prev.verify ?? null,
              verify_cwd: t.verify_cwd ?? prev.verify_cwd ?? null,
            });
          }
        } else {
          const id = this.insertStep({
            planId,
            idx: i,
            content: t.content,
            status: t.status,
            verify: t.verify ?? null,
            verifyCwd: t.verify_cwd ?? null,
            tools: t.tools ?? null,
          });
          stepIds.push(id);
          if (t.status === "in_progress")
            started.push({ id, verify: t.verify ?? null, verify_cwd: t.verify_cwd ?? null });
        }
      }
      for (const s of existing) {
        if (matched.has(s.id)) continue;
        this.db.run("UPDATE file_changes SET step_id = NULL WHERE step_id = ?", [s.id]);
        this.db.run("UPDATE gates SET step_id = NULL WHERE step_id = ?", [s.id]);
        this.db.run("DELETE FROM plan_steps WHERE id = ?", [s.id]);
      }
    });
    tx();
    return { planId, stepIds, started };
  }

  // ---------------------------------------------------------------- file changes (M2.1/M2.2)
  insertFileChange(opts: {
    id?: string;
    planId: string;
    stepId?: string | null;
    path: string;
    kind?: string | null;
    origin?: string | null;
    agentId?: string | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO file_changes (id, plan_id, step_id, path, kind, origin, created_at, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.planId,
        opts.stepId ?? null,
        opts.path,
        opts.kind ?? null,
        opts.origin ?? null,
        new Date().toISOString(),
        opts.agentId ?? null,
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
    recId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO gates (id, plan_id, step_id, kind, outcome, confidence, verified_by, factors_json, created_at, rec_id, session_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        opts.recId ?? null,
        opts.sessionId ?? null,
        opts.agentId ?? null,
      ],
    );
    return id;
  }

  getGates(planId: string): GateRow[] {
    return this.db
      .query("SELECT * FROM gates WHERE plan_id = ? ORDER BY created_at, rowid")
      .all(planId) as GateRow[];
  }

  /** The run's commands for one tool (lead + children), oldest first — blind-factor input. */
  getRunToolCommands(runId: string, toolName: string): string[] {
    const rows = this.db
      .query("SELECT args FROM tool_calls WHERE run_id = ? AND tool_name = ? ORDER BY ts, rowid")
      .all(runId, toolName) as { args: string | null }[];
    const out: string[] = [];
    for (const r of rows) {
      if (!r.args) continue;
      try {
        const parsed = JSON.parse(r.args) as Record<string, unknown> | null;
        const cmd = parsed?.command;
        if (typeof cmd === "string" && cmd.trim()) out.push(cmd);
      } catch {
        // unparsable args carry no command
      }
    }
    return out;
  }

  /** Blocked-attempt rows written before any plan existed — reachable only by session. */
  getSessionOrphanGates(sessionId: string): GateRow[] {
    return this.db
      .query(
        "SELECT * FROM gates WHERE session_id = ? AND plan_id IS NULL ORDER BY created_at, rowid",
      )
      .all(sessionId) as GateRow[];
  }

  /** Every gate minted under one routed rung (rec_id), oldest first — the feedback join. */
  getGatesForRec(recId: string): GateRow[] {
    return this.db
      .query("SELECT * FROM gates WHERE rec_id = ? ORDER BY created_at, rowid")
      .all(recId) as GateRow[];
  }

  /** M6.3: record a user override against a gate (accept|reject|steer). */
  recordUserSignal(gateId: string, action: UserAction, note?: string | null): string {
    const id = newId();
    this.db.run("INSERT INTO user_signals (id, gate_id, action, at, note) VALUES (?, ?, ?, ?, ?)", [
      id,
      gateId,
      action,
      new Date().toISOString(),
      note ?? null,
    ]);
    return id;
  }

  /** M6.3: the overrides recorded against a gate, oldest first. Empty when never answered. */
  getUserSignals(gateId: string): UserSignalRow[] {
    return this.db
      .query("SELECT * FROM user_signals WHERE gate_id = ? ORDER BY at, rowid")
      .all(gateId) as UserSignalRow[];
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
