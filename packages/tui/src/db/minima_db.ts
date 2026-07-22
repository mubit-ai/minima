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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} from "../minima/big_plan_contract.ts";

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
  // v3 — Big Plan ledger: the plan + its steps.
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
  // v5 — verification records: gate rows, user overrides, and the verified outcome stamped
  // back onto the routing decision (distinct legacy columns so they never clobber the
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
  // v9 — per-step cost attribution (U3): the in-progress plan step at routing time, stamped by
  // the DecisionRecord writer when Big Plan is on. This is provenance for reporting (U3
  // sidebar / J1 /why), never a feedback input. NULL = pre-v8 row or no step in progress.
  [
    "ALTER TABLE routing_decisions ADD COLUMN step_id TEXT REFERENCES plan_steps(id)",
    "CREATE INDEX IF NOT EXISTS ix_decisions_step ON routing_decisions(step_id)",
  ],
  // v10 — git-shadow checkpoints (B3): one row per worktree snapshot, keyed to the run and
  // the replay-space prompt ordinal (count of lead user events persisted BEFORE the prompt
  // that triggered the snapshot — the sink flushes at turn_end, so mid-turn the current
  // prompt is not yet counted). kind 'turn' = pre-mutation snapshot · 'safety' = auto
  // snapshot taken just before a restore (so /undo is itself undoable). The git objects
  // live under refs/minima/ckpt/<run_id>/<checkpoint_id>; this table is the mapping ledger.
  [
    `CREATE TABLE IF NOT EXISTS checkpoints (
       id             TEXT PRIMARY KEY,
       run_id         TEXT NOT NULL REFERENCES runs(run_id),
       ref            TEXT NOT NULL,
       commit_sha     TEXT NOT NULL,
       tree_sha       TEXT NOT NULL,
       prompt_ordinal INTEGER NOT NULL,
       step_id        TEXT REFERENCES plan_steps(id),
       kind           TEXT NOT NULL DEFAULT 'turn',  -- turn|safety
       created        REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_checkpoints_run ON checkpoints(run_id, created DESC)",
  ],
  // v11 — lineage convergence (TrackA/TrackB merge): both feature branches shipped a batch at
  // index 7 (TrackA: plan_steps.tools · TrackB: routing_decisions.step_id), so a DB migrated on
  // the TrackB lineage sits at version 9 having never seen the tools ALTER that now lives at
  // index 7. Re-running it here converges every lineage; execStep's duplicate-column self-heal
  // makes it a no-op for fresh and TrackA-lineage DBs. Append-only discipline holds — no shipped
  // batch string was edited.
  [
    "ALTER TABLE plan_steps ADD COLUMN tools TEXT", // JSON string[] (NULL/[] = unrestricted)
  ],
  // v12 — memory ledger (B1): curated cross-session memory. `memories` holds the durable rows
  // (bi-temporal — invalidation stamps, never DELETE); `memory_events` is the append-only audit
  // trail (every op, including each projection injection, so "what the model saw" is replayable);
  // `memory_jobs` is the persisted curation queue the (later) scribe drains — created now so its
  // writers need no further migration. Only the harness/user writes these tables: the model has
  // no memory-write tool by design (Letta split — curation is never the primary agent's job).
  [
    `CREATE TABLE IF NOT EXISTS memories (
       id              TEXT PRIMARY KEY,
       project_key     TEXT NOT NULL,
       kind            TEXT NOT NULL,    -- note|workflow|lesson|guardrail
       trigger         TEXT,             -- when to surface it (Devin {trigger,content} shape)
       content         TEXT NOT NULL,
       citations       TEXT,             -- JSON rec_ids/gate_ids/plan_ids backing the claim
       evidence_source TEXT NOT NULL,    -- gate|judge|human|none (provenance discipline)
       origin          TEXT NOT NULL,    -- scribe|agent|user
       status          TEXT NOT NULL,    -- pending|active|pinned|rejected|invalidated
       valid_at        REAL,
       invalidated_at  REAL,             -- bi-temporal tombstone, never DELETE
       watermark_ts    REAL,             -- newest events.ts consumed when written (freshness)
       author_model    TEXT,
       created REAL NOT NULL,
       updated REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_memories_project ON memories(project_key, status, updated DESC)",
    `CREATE TABLE IF NOT EXISTS memory_events (
       id        TEXT PRIMARY KEY,
       memory_id TEXT,                   -- NULL for set-level ops (inject)
       op        TEXT NOT NULL,          -- add|update|confirm|pin|reject|invalidate|inject|noop
       payload   TEXT,                   -- JSON
       actor     TEXT,                   -- user|scribe|system
       ts        REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_memory_events_memory ON memory_events(memory_id, ts)",
    `CREATE TABLE IF NOT EXISTS memory_jobs (
       id         TEXT PRIMARY KEY,
       kind       TEXT NOT NULL,         -- reflect|consolidate|dream
       session_id TEXT,
       payload    TEXT,
       status     TEXT NOT NULL,         -- queued|running|done|failed
       not_before REAL,
       created REAL NOT NULL,
       updated REAL NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS ix_memory_jobs_status ON memory_jobs(status, not_before)",
  ],
  // v13 — durable-execution stamps + blob tier (D1). Restate lesson: "your code is the
  // manual the LLM uses to interpret its own history" — Homebrew guarantees version skew
  // across resumes, so decisions and gates record WHICH harness + tool schema produced
  // them (resume warns on mismatch, never blocks). tool_calls.result_ref points a >16KB
  // result at a content-addressed blob file so WAL checkpoints stay fast as the memory
  // features add read load; the row keeps the truncated text as before.
  [
    "ALTER TABLE routing_decisions ADD COLUMN harness_version TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN tool_schema_hash TEXT",
    "ALTER TABLE gates ADD COLUMN harness_version TEXT",
    "ALTER TABLE gates ADD COLUMN tool_schema_hash TEXT",
    "ALTER TABLE tool_calls ADD COLUMN result_ref TEXT", // sha256 blob file, NULL = inline only
  ],
  // v14 — canonical Big Plan outcome columns. Legacy gt_* columns remain populated for one
  // compatibility release so older binaries can still read decisions written by this version.
  [
    "ALTER TABLE routing_decisions ADD COLUMN big_plan_outcome TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN big_plan_verified_by TEXT",
    "ALTER TABLE routing_decisions ADD COLUMN big_plan_confidence TEXT",
    `UPDATE routing_decisions
       SET big_plan_outcome = gt_outcome,
           big_plan_verified_by = gt_verified_by,
           big_plan_confidence = gt_confidence
       WHERE big_plan_outcome IS NULL
         AND big_plan_verified_by IS NULL
         AND big_plan_confidence IS NULL`,
  ],
  // per-repo routing profiles (batch position may shift at rebase if other migration PRs
  // land first — append-only discipline: renumber unmerged, never edit shipped batches).
  // `routing_profiles` is one row of learned/asked routing preferences per project — the
  // knobs applied at route time with precedence explicit opts > profile > config default.
  // `profile_events` is the append-only audit trail, one row PER CHANGED FIELD, mirroring
  // the memories/memory_events pattern.
  [
    `CREATE TABLE IF NOT EXISTS routing_profiles (
       project_key       TEXT PRIMARY KEY,
       slider            REAL,             -- cost/quality tradeoff (NULL = config default)
       min_quality       REAL,
       max_cost_per_call REAL,
       candidates        TEXT,             -- JSON string[]: the default candidate pool
       per_task_type     TEXT,             -- JSON map taskType -> {candidates, minQuality?}
       source            TEXT CHECK(source IN ('interview','user','tuner')),
       updated_at        INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS profile_events (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       project_key TEXT NOT NULL,
       ts          INTEGER,
       source      TEXT,
       field       TEXT,
       old_value   TEXT,
       new_value   TEXT
     )`,
    "CREATE INDEX IF NOT EXISTS ix_profile_events_project ON profile_events(project_key, ts)",
  ],
  // per-step candidate pools — batch index may shift at rebase (parallel unmerged stacks
  // also append here; append-only discipline: renumber unmerged, never edit shipped).
  [
    "ALTER TABLE plan_steps ADD COLUMN candidates TEXT", // JSON string[] (NULL = inherit the session pool)
  ],
];

/** Tool results larger than this spill to a content-addressed blob file (v13). */
export const BLOB_SPILL_BYTES = 16_384;

/**
 * Stable digest of the CURRENT toolset: sorted (name + parameter JSON-schema) pairs,
 * sha256'd. Structural on purpose — the db layer never imports agent types.
 */
export function toolSchemaHash(
  tools: readonly { name: string; parameters?: { jsonSchema?: unknown } }[],
): string {
  const entries = [...tools]
    .map((t) => `${t.name}:${JSON.stringify(t.parameters?.jsonSchema ?? null)}`)
    .sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(entries.join("\n"));
  return hasher.digest("hex");
}

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
  /** In-progress Big Plan step at routing time (v9) — reporting provenance, not feedback. */
  stepId?: string | null;
}

// ---------------------------------------------------------------- Big Plan rows
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
  /** JSON array of exact model ids this step's delegated work routes among; NULL = inherit the session pool. */
  candidates: string | null;
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

// ---------------------------------------------------------------- memory ledger rows (B1)
// Kinds are app-level (no SQL CHECK on memories.kind — the shipped v12 batch string is
// never edited): `preference` = a durable user preference about how work happens here.
export type MemoryKind = "note" | "workflow" | "lesson" | "guardrail" | "preference";
export type MemoryStatus = "pending" | "active" | "pinned" | "rejected" | "invalidated";
export type MemoryOrigin = "scribe" | "agent" | "user";

export interface MemoryRow {
  id: string;
  project_key: string;
  kind: MemoryKind;
  trigger: string | null;
  content: string;
  citations: string | null;
  evidence_source: string;
  origin: MemoryOrigin;
  status: MemoryStatus;
  valid_at: number | null;
  invalidated_at: number | null;
  watermark_ts: number | null;
  author_model: string | null;
  created: number;
  updated: number;
}

export interface MemoryEventRow {
  id: string;
  memory_id: string | null;
  op: string;
  payload: string | null;
  actor: string | null;
  ts: number;
}

export interface MemoryJobRow {
  id: string;
  kind: "reflect" | "consolidate" | "dream";
  session_id: string | null;
  payload: string | null;
  status: "queued" | "running" | "done" | "failed";
  not_before: number | null;
  created: number;
  updated: number;
}

// ---------------------------------------------------------------- routing profiles
export type RoutingProfileSource = "interview" | "user" | "tuner";

export interface RoutingProfileRow {
  project_key: string;
  slider: number | null;
  min_quality: number | null;
  max_cost_per_call: number | null;
  /** JSON string[] — the default candidate pool (NULL = config default). */
  candidates: string | null;
  /** JSON map taskType -> { candidates: string[], minQuality?: number }. */
  per_task_type: string | null;
  source: RoutingProfileSource | null;
  updated_at: number | null;
}

export interface ProfileEventRow {
  id: number;
  project_key: string;
  ts: number | null;
  source: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
}

/** One per-task-type override inside a profile's per_task_type map. */
export interface PerTaskTypePool {
  candidates: string[];
  minQuality?: number;
}

/** Partial-patch input: only provided fields change; explicit null clears a field. */
export interface RoutingProfilePatch {
  slider?: number | null;
  minQuality?: number | null;
  maxCostPerCall?: number | null;
  candidates?: string[] | null;
  perTaskType?: Record<string, PerTaskTypePool> | null;
}

/** One gate row joined to its step + owning run — the scribe's mining substrate. */
export interface GateHistoryRow extends GateRow {
  step_content: string | null;
  step_verify: string | null;
  run_id: string | null;
}

/** One user override joined back to its gate's step + run — a correction signal. */
export interface UserSignalHistoryRow extends UserSignalRow {
  step_content: string | null;
  run_id: string | null;
}

/** One git-shadow worktree snapshot (B3, v10) — the ref ↔ run ↔ prompt ↔ step mapping. */
export interface CheckpointRow {
  id: string;
  run_id: string;
  ref: string;
  commit_sha: string;
  tree_sha: string;
  /** Lead user events persisted before the triggering prompt (replay space). */
  prompt_ordinal: number;
  step_id: string | null;
  kind: "turn" | "safety";
  created: number;
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
  /** Where >16KB tool results spill (v13). Null (":memory:" without an override) = no spill. */
  readonly blobDir: string | null;
  /** v13 stamps, set once at startup (setVersionStamp); every subsequent decision/gate
   * write carries them. Null until set — pre-stamp rows stay NULL, like historical rows. */
  private stampHarnessVersion: string | null = null;
  private stampToolSchemaHash: string | null = null;

  constructor(path: string = defaultDbPath(), opts: { blobDir?: string | null } = {}) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.blobDir =
      opts.blobDir !== undefined
        ? opts.blobDir
        : path !== ":memory:"
          ? join(dirname(path), "blobs")
          : null;
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
    // Mark the file as a Minima harness DB ("MNMA") — file(1)-style identification.
    this.db.exec("PRAGMA application_id=0x4D4E4D41");
    this.migrate();
    this.reconcileSchema();
  }

  /** v13: record the running harness + toolset once at startup; all later decision/gate
   * writes carry the stamps. Resume compares against a run's recorded stamps (warn-only). */
  setVersionStamp(stamp: { harnessVersion: string; toolSchemaHash: string }): void {
    this.stampHarnessVersion = stamp.harnessVersion;
    this.stampToolSchemaHash = stamp.toolSchemaHash;
  }

  get versionStamp(): { harnessVersion: string | null; toolSchemaHash: string | null } {
    return {
      harnessVersion: this.stampHarnessVersion,
      toolSchemaHash: this.stampToolSchemaHash,
    };
  }

  /** The newest recorded tooling stamp among a run's decisions and gates (v13), or nulls. */
  lastRecordedStamp(runId: string): {
    harnessVersion: string | null;
    toolSchemaHash: string | null;
  } {
    const dec = this.db
      .query(
        `SELECT harness_version, tool_schema_hash FROM routing_decisions
         WHERE run_id = ? AND tool_schema_hash IS NOT NULL ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as { harness_version: string | null; tool_schema_hash: string | null } | null;
    if (dec) return { harnessVersion: dec.harness_version, toolSchemaHash: dec.tool_schema_hash };
    const gate = this.db
      .query(
        `SELECT harness_version, tool_schema_hash FROM gates
         WHERE session_id = ? AND tool_schema_hash IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as { harness_version: string | null; tool_schema_hash: string | null } | null;
    if (gate)
      return { harnessVersion: gate.harness_version, toolSchemaHash: gate.tool_schema_hash };
    return { harnessVersion: null, toolSchemaHash: null };
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

  /**
   * Divergent-lineage self-heal, run on EVERY open after the version runner. Parallel
   * branches have twice shipped DIFFERENT batches under the same version index (the
   * TrackA/TrackB index-7 fork healed by v11, and a v6-index fork found in the field:
   * a DB stamped version 11 with check_origin present but verify_cwd/gates.rec_id
   * missing — its writers then crash on "no column named verify_cwd"). The version
   * stamp cannot be trusted to imply THIS lineage's batch contents, so this pass
   * replays every migration statement idempotently: CREATE ... IF NOT EXISTS as-is,
   * ALTER ... ADD COLUMN only when pragma table_info lacks the column. One-off
   * convergence batches (v11) fix an instance; this fixes the class. Concurrent
   * openers may race an ALTER — execStep's duplicate-column swallow absorbs it.
   */
  private reconcileSchema(): void {
    for (const batch of MIGRATIONS) {
      for (const ddl of batch) {
        const alter = ddl.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
        if (alter) {
          const cols = this.db.query(`PRAGMA table_info(${alter[1]})`).all() as { name: string }[];
          if (!cols.some((c) => c.name === alter[2])) this.execStep(ddl);
          continue;
        }
        if (/^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(ddl.trim())) this.execStep(ddl);
      }
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

  /** D2: keep the run row honest after resume adopts the ORIGINAL provider session id. */
  setProviderSessionId(runId: string, providerSessionId: string): void {
    this.db.run("UPDATE runs SET provider_session_id = ?, updated = ? WHERE run_id = ?", [
      providerSessionId,
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
    // v13 blob tier: a big result spills (content-addressed) so the row — and every WAL
    // checkpoint over it — stays small; the row keeps the same truncated text as before.
    // Fail-open: a blob write failure just means no ref (inline truncation still stands).
    let resultRef: string | null = null;
    if (this.blobDir && opts.result.length > BLOB_SPILL_BYTES) {
      try {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(opts.result);
        const sha = hasher.digest("hex");
        mkdirSync(this.blobDir, { recursive: true });
        const file = join(this.blobDir, sha);
        if (!existsSync(file)) writeFileSync(file, opts.result, "utf8");
        resultRef = sha;
      } catch {
        resultRef = null;
      }
    }
    this.db.run(
      `INSERT INTO tool_calls (id, run_id, event_id, agent_id, tool_name, args, result, is_error, ts, result_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        resultRef,
      ],
    );
    return id;
  }

  /** Rehydrate a spilled tool result by its content hash (v13). Null when absent. */
  readBlob(ref: string): string | null {
    if (!this.blobDir || !/^[0-9a-f]{64}$/.test(ref)) return null;
    try {
      const file = join(this.blobDir, ref);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  }

  /** Run a batch of writes in one transaction (per-turn atomicity for the sink). */
  transact(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- routing decisions
  /**
   * One row per routed prompt — idempotent on rec_id (a retried write updates in place,
   * never duplicates the hosted join key).
   *
   * `synced` is RESERVED (memory-spine open decision #6, resolved F1): always written 0,
   * never read — kept for a possible future decision-upload path; do not build on it.
   */
  writeDecision(d: DecisionWrite): void {
    this.db.run(
      `INSERT INTO routing_decisions (
         rec_id, run_id, event_id, agent_id, parent_rec_id, task_label, task_type, difficulty,
         chosen_model, decision_basis, selection_policy, confidence, threshold_used, ranked,
         est_cost_usd, est_cost_low, est_cost_high, all_premium_cost_usd,
         configured_baseline_cost_usd, actual_cost_usd, quality, judged, outcome, routed,
         turns, latency_ms, step_id, reinforced_entry_ids, lesson_promoted,
         harness_version, tool_schema_hash, ts, schema_v, synced
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 0)
       ON CONFLICT(rec_id) DO UPDATE SET
         actual_cost_usd = excluded.actual_cost_usd,
         quality = excluded.quality, judged = excluded.judged, outcome = excluded.outcome,
         turns = excluded.turns, latency_ms = excluded.latency_ms,
         step_id = COALESCE(routing_decisions.step_id, excluded.step_id),
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
        d.stepId ?? null,
        d.reinforcedEntryIds?.length ? JSON.stringify(d.reinforcedEntryIds) : null,
        d.lessonPromoted === null || d.lessonPromoted === undefined
          ? null
          : d.lessonPromoted
            ? 1
            : 0,
        this.stampHarnessVersion,
        this.stampToolSchemaHash,
        Date.now() / 1000,
      ],
    );
  }

  getRunDecisions(runId: string): Record<string, unknown>[] {
    return this.db
      .query("SELECT * FROM routing_decisions WHERE run_id = ? ORDER BY ts")
      .all(runId) as Record<string, unknown>[];
  }

  /**
   * U3: realized $ per plan step, from the v9 step_id stamp. Realized cost only
   * (actual_cost_usd) — estimates never masquerade as spend. Steps with no stamped
   * decisions are absent from the map (the UI renders them as "—", not $0.00).
   */
  stepCosts(planId: string): { perStep: Map<string, number>; totalUsd: number } {
    const rows = this.db
      .query(
        `SELECT step_id, SUM(COALESCE(actual_cost_usd, 0)) AS cost
         FROM routing_decisions
         WHERE step_id IN (SELECT id FROM plan_steps WHERE plan_id = ?)
         GROUP BY step_id`,
      )
      .all(planId) as { step_id: string; cost: number }[];
    const perStep = new Map<string, number>();
    let totalUsd = 0;
    for (const r of rows) {
      perStep.set(r.step_id, r.cost);
      totalUsd += r.cost;
    }
    return { perStep, totalUsd };
  }

  // ================================================================ checkpoints (B3)

  insertCheckpoint(opts: {
    id?: string;
    runId: string;
    ref: string;
    commitSha: string;
    treeSha: string;
    promptOrdinal: number;
    stepId?: string | null;
    kind?: "turn" | "safety";
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      `INSERT INTO checkpoints (id, run_id, ref, commit_sha, tree_sha, prompt_ordinal, step_id, kind, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.runId,
        opts.ref,
        opts.commitSha,
        opts.treeSha,
        opts.promptOrdinal,
        opts.stepId ?? null,
        opts.kind ?? "turn",
        Date.now() / 1000,
      ],
    );
    return id;
  }

  // ================================================================ memory ledger (B1)

  /**
   * Insert one curated memory + its `add` audit event in a single transaction. Only the
   * harness/user calls this — the model has no memory-write tool (Letta split).
   */
  insertMemory(opts: {
    id?: string;
    projectKey: string;
    kind: MemoryKind;
    content: string;
    trigger?: string | null;
    citations?: string[] | null;
    evidenceSource: "gate" | "judge" | "human" | "none";
    origin: MemoryOrigin;
    status?: MemoryStatus;
    watermarkTs?: number | null;
    authorModel?: string | null;
    actor?: string;
  }): string {
    const id = opts.id ?? newId();
    const now = Date.now() / 1000;
    const status = opts.status ?? "pending";
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO memories (id, project_key, kind, trigger, content, citations,
           evidence_source, origin, status, valid_at, invalidated_at, watermark_ts,
           author_model, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          id,
          opts.projectKey,
          opts.kind,
          opts.trigger ?? null,
          opts.content,
          opts.citations?.length ? JSON.stringify(opts.citations) : null,
          opts.evidenceSource,
          opts.origin,
          status,
          now,
          opts.watermarkTs ?? null,
          opts.authorModel ?? null,
          now,
          now,
        ],
      );
      this.writeMemoryEvent({
        memoryId: id,
        op: "add",
        payload: { status, kind: opts.kind, evidence_source: opts.evidenceSource },
        actor: opts.actor ?? opts.origin,
      });
    })();
    return id;
  }

  getMemory(id: string): MemoryRow | null {
    return (this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow) ?? null;
  }

  /**
   * A project's memories, newest-updated first. Invalidated rows are excluded unless asked
   * for — they are tombstones, visible only to audits.
   */
  listMemories(
    projectKey: string,
    opts: { statuses?: MemoryStatus[]; includeInvalidated?: boolean; limit?: number } = {},
  ): MemoryRow[] {
    const limit = opts.limit ?? 100;
    if (opts.statuses?.length) {
      const marks = opts.statuses.map(() => "?").join(", ");
      return this.db
        .query(
          `SELECT * FROM memories WHERE project_key = ? AND status IN (${marks})
           AND (invalidated_at IS NULL OR ?) ORDER BY updated DESC LIMIT ?`,
        )
        .all(projectKey, ...opts.statuses, opts.includeInvalidated ? 1 : 0, limit) as MemoryRow[];
    }
    return this.db
      .query(
        `SELECT * FROM memories WHERE project_key = ?
         AND (invalidated_at IS NULL OR ?) ORDER BY updated DESC LIMIT ?`,
      )
      .all(projectKey, opts.includeInvalidated ? 1 : 0, limit) as MemoryRow[];
  }

  /** Resolve a /memory target: exact id, then id prefix (≥ 4 chars, unique-match only). */
  findMemoryByPrefix(projectKey: string, query: string): MemoryRow | null {
    const exact = this.db
      .query("SELECT * FROM memories WHERE project_key = ? AND id = ?")
      .get(projectKey, query) as MemoryRow | null;
    if (exact) return exact;
    if (query.length < 4) return null;
    const rows = this.db
      .query("SELECT * FROM memories WHERE project_key = ? AND id LIKE ? ESCAPE '\\' LIMIT 2")
      .all(projectKey, `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as MemoryRow[];
    return rows.length === 1 ? (rows[0] ?? null) : null;
  }

  /**
   * Move a memory between curation states (confirm→active, pin, reject, back to pending) and
   * audit the op. Invalidated rows are immutable tombstones — refused. Returns false when the
   * row is missing or immutable.
   */
  setMemoryStatus(
    id: string,
    status: Exclude<MemoryStatus, "invalidated">,
    actor: string,
  ): boolean {
    const opByStatus: Record<string, string> = {
      active: "confirm",
      pinned: "pin",
      rejected: "reject",
      pending: "update",
    };
    let changed = false;
    this.db.transaction(() => {
      const row = this.getMemory(id);
      if (!row || row.status === "invalidated" || row.invalidated_at !== null) return;
      this.db.run("UPDATE memories SET status = ?, updated = ? WHERE id = ?", [
        status,
        Date.now() / 1000,
        id,
      ]);
      this.writeMemoryEvent({
        memoryId: id,
        op: opByStatus[status] ?? "update",
        payload: { from: row.status, to: status },
        actor,
      });
      changed = true;
    })();
    return changed;
  }

  /** Bi-temporal delete: stamp invalidated_at (never DELETE) + audit. Idempotent. */
  invalidateMemory(id: string, actor: string): boolean {
    let changed = false;
    this.db.transaction(() => {
      const row = this.getMemory(id);
      if (!row || row.invalidated_at !== null) return;
      this.db.run(
        "UPDATE memories SET status = 'invalidated', invalidated_at = ?, updated = ? WHERE id = ?",
        [Date.now() / 1000, Date.now() / 1000, id],
      );
      this.writeMemoryEvent({ memoryId: id, op: "invalidate", payload: null, actor });
      changed = true;
    })();
    return changed;
  }

  /** Append one memory audit event (op `inject` uses memory_id NULL + the id set in payload). */
  writeMemoryEvent(opts: {
    id?: string;
    memoryId?: string | null;
    op: string;
    payload?: unknown;
    actor?: string | null;
    ts?: number;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO memory_events (id, memory_id, op, payload, actor, ts) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id,
        opts.memoryId ?? null,
        opts.op,
        opts.payload === undefined || opts.payload === null ? null : JSON.stringify(opts.payload),
        opts.actor ?? null,
        opts.ts ?? Date.now() / 1000,
      ],
    );
    return id;
  }

  /** A memory's audit trail (or all set-level events for memoryId null), oldest first. */
  listMemoryEvents(memoryId: string | null, limit = 100): MemoryEventRow[] {
    if (memoryId === null) {
      return this.db
        .query("SELECT * FROM memory_events WHERE memory_id IS NULL ORDER BY ts, rowid LIMIT ?")
        .all(limit) as MemoryEventRow[];
    }
    return this.db
      .query("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY ts, rowid LIMIT ?")
      .all(memoryId, limit) as MemoryEventRow[];
  }

  // ---------------------------------------------------------------- memory jobs (B2)

  /** Insert a curation job (queued). Triggers only ever enqueue; a drain loop runs them. */
  enqueueMemoryJob(opts: {
    id?: string;
    kind: MemoryJobRow["kind"];
    sessionId?: string | null;
    payload?: unknown;
    notBefore?: number | null;
  }): string {
    const id = opts.id ?? newId();
    const now = Date.now() / 1000;
    this.db.run(
      `INSERT INTO memory_jobs (id, kind, session_id, payload, status, not_before, created, updated)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [
        id,
        opts.kind,
        opts.sessionId ?? null,
        opts.payload === undefined || opts.payload === null ? null : JSON.stringify(opts.payload),
        opts.notBefore ?? null,
        now,
        now,
      ],
    );
    return id;
  }

  /**
   * Claim the oldest runnable queued job (FIFO, not_before-respecting) by flipping it to
   * `running` inside one IMMEDIATE transaction — two concurrent drainers can never claim
   * the same job. Null when nothing is runnable.
   */
  claimNextMemoryJob(now: number = Date.now() / 1000): MemoryJobRow | null {
    let claimed: MemoryJobRow | null = null;
    this.db
      .transaction(() => {
        const row = this.db
          .query(
            `SELECT * FROM memory_jobs WHERE status = 'queued'
             AND (not_before IS NULL OR not_before <= ?)
             ORDER BY created, rowid LIMIT 1`,
          )
          .get(now) as MemoryJobRow | null;
        if (!row) return;
        this.db.run("UPDATE memory_jobs SET status = 'running', updated = ? WHERE id = ?", [
          now,
          row.id,
        ]);
        claimed = { ...row, status: "running" };
      })
      .immediate();
    return claimed;
  }

  finishMemoryJob(id: string, status: "done" | "failed"): void {
    this.db.run("UPDATE memory_jobs SET status = ?, updated = ? WHERE id = ?", [
      status,
      Date.now() / 1000,
      id,
    ]);
  }

  /**
   * Crash recovery, run once at startup: a job still `running` belongs to a process that
   * died mid-drain — requeue it so the pass is retried, not lost (persisted-queue lesson).
   */
  requeueRunningMemoryJobs(): number {
    this.db.run("UPDATE memory_jobs SET status = 'queued', updated = ? WHERE status = 'running'", [
      Date.now() / 1000,
    ]);
    return (this.db.query("SELECT changes() AS n").get() as { n: number }).n;
  }

  listMemoryJobs(status?: MemoryJobRow["status"], limit = 100): MemoryJobRow[] {
    if (status) {
      return this.db
        .query("SELECT * FROM memory_jobs WHERE status = ? ORDER BY created, rowid LIMIT ?")
        .all(status, limit) as MemoryJobRow[];
    }
    return this.db
      .query("SELECT * FROM memory_jobs ORDER BY created, rowid LIMIT ?")
      .all(limit) as MemoryJobRow[];
  }

  /** A project's closed (done) plans, newest first — the dream pass's episode source. */
  listClosedPlans(projectKey: string, limit = 50): PlanRow[] {
    return this.db
      .query(
        `SELECT * FROM plans WHERE status = 'done'
         AND session_id IN (SELECT run_id FROM runs WHERE project_key = ?)
         ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectKey, limit) as PlanRow[];
  }

  /** Scribe UPDATE reconciliation: refresh content/citations/watermark + audit. */
  updateMemory(
    id: string,
    patch: { content?: string; citations?: string[] | null; watermarkTs?: number | null },
    actor: string,
  ): boolean {
    let changed = false;
    this.db.transaction(() => {
      const row = this.getMemory(id);
      if (!row || row.invalidated_at !== null) return;
      this.db.run(
        `UPDATE memories SET content = COALESCE(?, content),
           citations = COALESCE(?, citations),
           watermark_ts = COALESCE(?, watermark_ts),
           updated = ? WHERE id = ?`,
        [
          patch.content ?? null,
          patch.citations?.length ? JSON.stringify(patch.citations) : null,
          patch.watermarkTs ?? null,
          Date.now() / 1000,
          id,
        ],
      );
      this.writeMemoryEvent({
        memoryId: id,
        op: "update",
        payload: { content: patch.content ?? null },
        actor,
      });
      changed = true;
    })();
    return changed;
  }

  // -------------------------------------------------- scribe mining joins (B2, read-only)

  /** A project's gate history joined to step content/verify + run id, oldest first. */
  getProjectGateHistory(projectKey: string, limit = 500): GateHistoryRow[] {
    return this.db
      .query(
        `SELECT g.*, ps.content AS step_content, ps.verify AS step_verify,
                COALESCE(g.session_id, p.session_id) AS run_id
         FROM gates g
         LEFT JOIN plan_steps ps ON ps.id = g.step_id
         LEFT JOIN plans p ON p.id = g.plan_id
         WHERE COALESCE(g.session_id, p.session_id) IN
               (SELECT run_id FROM runs WHERE project_key = ?)
         ORDER BY g.created_at, g.rowid LIMIT ?`,
      )
      .all(projectKey, limit) as GateHistoryRow[];
  }

  /** A project's reject/steer overrides joined to their gate's step + run, oldest first. */
  getProjectUserCorrections(projectKey: string, limit = 200): UserSignalHistoryRow[] {
    return this.db
      .query(
        `SELECT us.*, ps.content AS step_content,
                COALESCE(g.session_id, p.session_id) AS run_id
         FROM user_signals us
         JOIN gates g ON g.id = us.gate_id
         LEFT JOIN plan_steps ps ON ps.id = g.step_id
         LEFT JOIN plans p ON p.id = g.plan_id
         WHERE us.action IN ('reject', 'steer')
           AND COALESCE(g.session_id, p.session_id) IN
               (SELECT run_id FROM runs WHERE project_key = ?)
         ORDER BY us.at, us.rowid LIMIT ?`,
      )
      .all(projectKey, limit) as UserSignalHistoryRow[];
  }

  /**
   * Judged turns whose LLM grade contradicts the deterministic gate verdict — a judge
   * blind spot worth remembering (high grade over a failed gate, or the inverse).
   */
  getProjectJudgeGateDisagreements(projectKey: string, limit = 200): Record<string, unknown>[] {
    return this.db
      .query(
        `SELECT rec_id, task_type, chosen_model, quality, big_plan_outcome, ts
         FROM routing_decisions
         WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)
           AND judged = 1 AND quality IS NOT NULL AND big_plan_outcome IS NOT NULL
           AND ((quality >= 0.8 AND big_plan_outcome = 'failure')
             OR (quality < 0.4 AND big_plan_outcome = 'success'))
         ORDER BY ts LIMIT ?`,
      )
      .all(projectKey, limit) as Record<string, unknown>[];
  }

  /** Distinct models this project's decisions actually chose (staleness-guard input). */
  getProjectChosenModels(projectKey: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT chosen_model FROM routing_decisions
         WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)
           AND chosen_model IS NOT NULL`,
      )
      .all(projectKey) as { chosen_model: string }[];
    return rows.map((r) => r.chosen_model);
  }

  /** Newest file_changes ts (epoch s) among toolchain manifests for a project, or null. */
  latestToolchainChangeTs(projectKey: string): number | null {
    const row = this.db
      .query(
        `SELECT MAX(fc.created_at) AS latest
         FROM file_changes fc
         JOIN plans p ON p.id = fc.plan_id
         WHERE p.session_id IN (SELECT run_id FROM runs WHERE project_key = ?)
           AND (fc.path LIKE '%package.json' OR fc.path LIKE '%pyproject.toml'
             OR fc.path LIKE '%bun.lock' OR fc.path LIKE '%uv.lock')`,
      )
      .get(projectKey) as { latest: string | null };
    if (!row?.latest) return null;
    const ms = Date.parse(row.latest);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }

  /** All of a run's checkpoints, oldest first. */
  listCheckpoints(runId: string): CheckpointRow[] {
    return this.db
      .query("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created, id")
      .all(runId) as CheckpointRow[];
  }

  /**
   * Newest checkpoint of the run — optionally only rows strictly older than `beforeCreated`
   * (the /undo walk-back cursor) and/or of one kind ('turn' skips safety snapshots).
   */
  latestCheckpoint(
    runId: string,
    opts?: { beforeCreated?: number; kind?: "turn" | "safety" },
  ): CheckpointRow | null {
    const conds = ["run_id = ?"];
    const params: (string | number)[] = [runId];
    if (opts?.beforeCreated !== undefined) {
      conds.push("created < ?");
      params.push(opts.beforeCreated);
    }
    if (opts?.kind) {
      conds.push("kind = ?");
      params.push(opts.kind);
    }
    const row = this.db
      .query(
        `SELECT * FROM checkpoints WHERE ${conds.join(" AND ")} ORDER BY created DESC, id DESC LIMIT 1`,
      )
      .get(...params) as CheckpointRow | null;
    return row ?? null;
  }

  /**
   * B5 code-rewind target: the checkpoint capturing the worktree AS OF prompt
   * `promptOrdinal`+1's submission — i.e. the smallest prompt_ordinal >= promptOrdinal
   * (snapshots are taken BEFORE a mutating prompt's changes, so the state after prompt k
   * lives in the NEXT mutating prompt's snapshot). Null = no changes since that prompt.
   */
  earliestCheckpointAtOrAfter(runId: string, promptOrdinal: number): CheckpointRow | null {
    const row = this.db
      .query(
        `SELECT * FROM checkpoints WHERE run_id = ? AND prompt_ordinal >= ?
         ORDER BY prompt_ordinal ASC, created ASC LIMIT 1`,
      )
      .get(runId, promptOrdinal) as CheckpointRow | null;
    return row ?? null;
  }

  /** Delete a run's checkpoint rows (GC companion — the caller deletes the git refs). */
  deleteCheckpoints(runId: string): void {
    this.db.run("DELETE FROM checkpoints WHERE run_id = ?", [runId]);
  }

  /** Distinct run_ids holding checkpoints, most recently snapshotted first (GC policy input). */
  checkpointRuns(): string[] {
    const rows = this.db
      .query(
        "SELECT run_id, MAX(created) AS latest FROM checkpoints GROUP BY run_id ORDER BY latest DESC",
      )
      .all() as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  /** Lead user events persisted for the run — the replay-space prompt ordinal (B3/B4). */
  countLeadUserEvents(runId: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND agent_id IS NULL AND type = 'user'",
      )
      .get(runId) as { n: number };
    return row.n;
  }

  // ================================================================ routing profiles

  getRoutingProfile(projectKey: string): RoutingProfileRow | null {
    return (
      (this.db
        .query("SELECT * FROM routing_profiles WHERE project_key = ?")
        .get(projectKey) as RoutingProfileRow) ?? null
    );
  }

  /**
   * Partial-patch upsert: only fields PRESENT on the patch change (explicit null clears);
   * every changed field writes one profile_events audit row and stamps source/updated_at.
   * An all-noop patch writes nothing (and creates no empty row — a row's existence is a
   * signal, e.g. the interview's budget-question skip-gate). Returns the resulting row.
   */
  upsertRoutingProfile(
    projectKey: string,
    patch: RoutingProfilePatch,
    source: RoutingProfileSource,
  ): RoutingProfileRow | null {
    const serializeList = (v: string[] | null): string | null =>
      v && v.length > 0 ? JSON.stringify(v) : null;
    const serializeMap = (v: Record<string, PerTaskTypePool> | null): string | null =>
      v && Object.keys(v).length > 0 ? JSON.stringify(v) : null;
    this.db.transaction(() => {
      const prev = this.getRoutingProfile(projectKey);
      const next = {
        slider: patch.slider !== undefined ? patch.slider : (prev?.slider ?? null),
        min_quality:
          patch.minQuality !== undefined ? patch.minQuality : (prev?.min_quality ?? null),
        max_cost_per_call:
          patch.maxCostPerCall !== undefined
            ? patch.maxCostPerCall
            : (prev?.max_cost_per_call ?? null),
        candidates:
          patch.candidates !== undefined
            ? serializeList(patch.candidates)
            : (prev?.candidates ?? null),
        per_task_type:
          patch.perTaskType !== undefined
            ? serializeMap(patch.perTaskType)
            : (prev?.per_task_type ?? null),
      };
      const changed: [field: string, oldV: string | null, newV: string | null][] = [];
      const cmp = (field: string, oldV: number | string | null, newV: number | string | null) => {
        const o = oldV === null ? null : String(oldV);
        const n = newV === null ? null : String(newV);
        if (o !== n) changed.push([field, o, n]);
      };
      cmp("slider", prev?.slider ?? null, next.slider);
      cmp("min_quality", prev?.min_quality ?? null, next.min_quality);
      cmp("max_cost_per_call", prev?.max_cost_per_call ?? null, next.max_cost_per_call);
      cmp("candidates", prev?.candidates ?? null, next.candidates);
      cmp("per_task_type", prev?.per_task_type ?? null, next.per_task_type);
      if (changed.length === 0) return;
      const now = Math.floor(Date.now() / 1000);
      this.db.run(
        `INSERT INTO routing_profiles
           (project_key, slider, min_quality, max_cost_per_call, candidates, per_task_type, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_key) DO UPDATE SET
           slider = excluded.slider,
           min_quality = excluded.min_quality,
           max_cost_per_call = excluded.max_cost_per_call,
           candidates = excluded.candidates,
           per_task_type = excluded.per_task_type,
           source = excluded.source,
           updated_at = excluded.updated_at`,
        [
          projectKey,
          next.slider,
          next.min_quality,
          next.max_cost_per_call,
          next.candidates,
          next.per_task_type,
          source,
          now,
        ],
      );
      for (const [field, oldV, newV] of changed) {
        this.db.run(
          `INSERT INTO profile_events (project_key, ts, source, field, old_value, new_value)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [projectKey, now, source, field, oldV, newV],
        );
      }
    })();
    return this.getRoutingProfile(projectKey);
  }

  /** Delete the profile row + one `profile` audit event (old_value = the removed row). */
  clearRoutingProfile(projectKey: string, source: RoutingProfileSource): boolean {
    let removed = false;
    this.db.transaction(() => {
      const prev = this.getRoutingProfile(projectKey);
      if (!prev) return;
      this.db.run("DELETE FROM routing_profiles WHERE project_key = ?", [projectKey]);
      this.db.run(
        `INSERT INTO profile_events (project_key, ts, source, field, old_value, new_value)
         VALUES (?, ?, ?, 'profile', ?, NULL)`,
        [projectKey, Math.floor(Date.now() / 1000), source, JSON.stringify(prev)],
      );
      removed = true;
    })();
    return removed;
  }

  /**
   * Append one audit event outside a field upsert — e.g. the tuner's `field='probe'`
   * cooldown-ledger rows (one per probe SHOWN, regardless of the answer). `ts` is
   * injectable for tests; defaults to now.
   */
  insertProfileEvent(
    projectKey: string,
    source: RoutingProfileSource,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    ts?: number,
  ): void {
    this.db.run(
      `INSERT INTO profile_events (project_key, ts, source, field, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectKey, ts ?? Math.floor(Date.now() / 1000), source, field, oldValue, newValue],
    );
  }

  /** A project's profile audit trail, newest first (provenance for /profile show). */
  listProfileEvents(projectKey: string, limit = 100): ProfileEventRow[] {
    return this.db
      .query("SELECT * FROM profile_events WHERE project_key = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .all(projectKey, limit) as ProfileEventRow[];
  }

  // ================================================================ Big Plan ledger
  // Writers/readers are fail-open at the call site (a broken
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
   * Seed a fresh active plan + its steps from an APPROVED Big Plan (the planner→ledger
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
      candidates?: string[] | null;
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
            candidates: st.candidates ?? null,
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

  /**
   * The newest plan for a session regardless of status. Display/verification surfaces
   * (Ctrl+G overview, /why, /verify refutation, failure classification) pass
   * excludeCancelled — a cancelled plan is a USER-REJECTED plan, never the plan of
   * record; only the todo-upsert path keeps the default (its reopen logic must see the
   * cancelled row so it starts a FRESH plan instead of resurrecting an older done one).
   */
  getLatestPlan(sessionId: string, opts: { excludeCancelled?: boolean } = {}): PlanRow | null {
    const sql = opts.excludeCancelled
      ? "SELECT * FROM plans WHERE session_id = ? AND status <> 'cancelled' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      : "SELECT * FROM plans WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1";
    return ((this.db.query(sql).get(sessionId) as PlanRow) ?? null) as PlanRow | null;
  }

  /**
   * /tasks cancel: close EVERY active plan for the session — adoption on resume and
   * repeated seeding can pile up several, and getActivePlan(LIMIT 1) would let the
   * next-newest surface right back ("Big Plan still holds"). Returns how many were cancelled.
   */
  cancelActivePlans(sessionId: string): number {
    this.db.run(
      "UPDATE plans SET status = 'cancelled', closed_at = COALESCE(closed_at, ?) WHERE session_id = ? AND status = 'active'",
      [Date.now() / 1000, sessionId],
    );
    return (this.db.query("SELECT changes() AS n").get() as { n: number }).n;
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
    candidates?: string[] | null;
  }): string {
    const id = opts.id ?? newId();
    this.db.run(
      "INSERT INTO plan_steps (id, plan_id, idx, content, status, verify, baseline, created_at, verify_cwd, check_origin, tools, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        serializeToolList(opts.candidates),
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
   * enforces one todowrite per assistant message (big_plan.ts same-batch guard).
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
   * therefore re-enters fresh with NULL verify/baseline — Big Plan evidence is lost, never
   * misattributed. A matched step's `verify` is preserved unless a new value is supplied.
   *
   * M3.3: `started` reports the steps whose pre-work baseline should be captured now — a step
   * entering in_progress, a fresh step inserted directly as in_progress, or an in_progress
   * step gaining its first `verify` — always gated on baseline still NULL (capture is
   * once-only). Each entry carries the post-COALESCE effective `verify` (may be null —
   * filtering verify-less steps is the caller's job).
   *
   * Transaction note (D1): the reads here run BEFORE the deferred write transaction below —
   * safe while this process is the DB's only writer (the WAL single-writer invariant the
   * whole spine assumes). Revisit with BEGIN IMMEDIATE if a second writer process ever lands.
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
      "INSERT INTO gates (id, plan_id, step_id, kind, outcome, confidence, verified_by, factors_json, created_at, rec_id, session_id, agent_id, harness_version, tool_schema_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        this.stampHarnessVersion,
        this.stampToolSchemaHash,
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

  // ---------------------------------------------------------------- Big Plan outcome (M7.1)
  /** Stamp the step's real (deterministic) result onto its routing decision. */
  attachBigPlanOutcome(
    recId: string,
    o: { outcome: GateOutcome; verifiedBy: VerifiedBy; confidence?: ConfidenceTier | null },
  ): void {
    this.db.run(
      `UPDATE routing_decisions
       SET big_plan_outcome = ?, big_plan_verified_by = ?, big_plan_confidence = ?
       WHERE rec_id = ?`,
      [o.outcome, o.verifiedBy, o.confidence ?? null, recId],
    );
  }

  close(): void {
    this.db.close();
  }
}
