import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";

const SRC = join(import.meta.dir, "../src/db/minima_db.ts");
const LATEST = new MinimaDb(":memory:").schemaVersion;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-db-migrate-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migratedDbPath(): string {
  const path = join(tempDir(), "minima.db");
  const db = new MinimaDb(path);
  db.db.close();
  return path;
}

function regressVersion(path: string, version: number): void {
  const raw = new Database(path);
  raw.exec("UPDATE schema_meta SET version = ?", [version]);
  raw.close();
}

function openerScript(dbPath: string): string {
  const file = join(tempDir(), `open-${Math.random().toString(16).slice(2, 8)}.ts`);
  writeFileSync(
    file,
    `import { MinimaDb } from ${JSON.stringify(SRC)};\n` +
      `const db = new MinimaDb(${JSON.stringify(dbPath)});\n` +
      `console.log(db.schemaVersion);\n` +
      `db.db.close();\n`,
  );
  return file;
}

async function spawnOpeners(
  dbPath: string,
  n: number,
): Promise<{ codes: number[]; out: string[] }> {
  const procs = Array.from({ length: n }, () =>
    Bun.spawn(["bun", openerScript(dbPath)], { stdout: "pipe", stderr: "pipe" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  const out = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
  const err = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
  for (const [i, code] of codes.entries()) {
    if (code !== 0) console.error(`opener ${i} failed:\n${err[i]}`);
  }
  return { codes, out: out.map((s) => s.trim()) };
}

describe("migration runner: self-heal", () => {
  test("wedged DB (version regressed below v5 with v5 columns present) heals on open", () => {
    const path = migratedDbPath();
    regressVersion(path, LATEST - 1);
    const db = new MinimaDb(path);
    expect(db.schemaVersion).toBe(LATEST);
    db.db.close();
  });

  test("deep regression across ALTER TABLE batches heals on open", () => {
    const path = migratedDbPath();
    regressVersion(path, 1);
    const db = new MinimaDb(path);
    expect(db.schemaVersion).toBe(LATEST);
    expect(db.db.query("SELECT gt_outcome FROM routing_decisions LIMIT 1").all()).toEqual([]);
    db.db.close();
  });

  test("legacy double-seeded schema_meta collapses to one row keeping the max version", () => {
    const path = migratedDbPath();
    const raw = new Database(path);
    raw.exec("INSERT INTO schema_meta VALUES (0)");
    raw.close();
    const db = new MinimaDb(path);
    expect(db.schemaVersion).toBe(LATEST);
    const rows = db.db.query("SELECT COUNT(*) AS n FROM schema_meta").get() as { n: number };
    expect(rows.n).toBe(1);
    db.db.close();
  });

  test("non-ADD-COLUMN failures still throw (no silent corruption)", () => {
    const path = join(tempDir(), "minima.db");
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
    raw.exec("INSERT INTO schema_meta VALUES (0)");
    raw.exec("CREATE TABLE projects (bogus TEXT)");
    raw.exec("CREATE TABLE runs (bogus TEXT)");
    raw.close();
    expect(() => new MinimaDb(path)).toThrow();
  });
});

describe("v14 Big Plan outcome migration", () => {
  test("a fresh database has canonical and compatibility outcome columns", () => {
    const db = new MinimaDb(":memory:");
    const columns = db.db.query("PRAGMA table_info(routing_decisions)").all() as {
      name: string;
    }[];
    const names = new Set(columns.map((column) => column.name));

    expect(db.schemaVersion).toBe(LATEST);
    expect(names.has("big_plan_outcome")).toBe(true);
    expect(names.has("big_plan_verified_by")).toBe(true);
    expect(names.has("big_plan_confidence")).toBe(true);
    expect(names.has("gt_outcome")).toBe(true);
    expect(names.has("gt_verified_by")).toBe(true);
    expect(names.has("gt_confidence")).toBe(true);
    db.db.close();
  });

  test("opening a v13 database backfills canonical outcomes from compatibility columns", () => {
    const path = migratedDbPath();
    const raw = new Database(path);
    raw.exec("ALTER TABLE routing_decisions DROP COLUMN big_plan_outcome");
    raw.exec("ALTER TABLE routing_decisions DROP COLUMN big_plan_verified_by");
    raw.exec("ALTER TABLE routing_decisions DROP COLUMN big_plan_confidence");
    raw.exec(
      `INSERT INTO routing_decisions
         (rec_id, run_id, gt_outcome, gt_verified_by, gt_confidence, ts)
       VALUES ('rec-v13', 'run-v13', 'verified', 'deterministic', 'green', 1)`,
    );
    raw.exec("UPDATE schema_meta SET version = 13");
    raw.close();

    const db = new MinimaDb(path);
    const row = db.db
      .query(
        `SELECT big_plan_outcome, big_plan_verified_by, big_plan_confidence
         FROM routing_decisions WHERE rec_id = 'rec-v13'`,
      )
      .get() as Record<string, string>;

    expect(db.schemaVersion).toBe(LATEST);
    expect(row.big_plan_outcome).toBe("verified");
    expect(row.big_plan_verified_by).toBe("deterministic");
    expect(row.big_plan_confidence).toBe("green");
    db.db.close();
  });

  test("the outcome writer stamps canonical columns only — legacy columns stay null", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("project-dual");
    const runId = db.startRun({ runId: "run-dual", projectKey: "project-dual" });
    db.db.run("INSERT INTO routing_decisions (rec_id, run_id, ts) VALUES (?, ?, ?)", [
      "rec-dual",
      runId,
      1,
    ]);

    db.attachBigPlanOutcome("rec-dual", {
      outcome: "verified",
      verifiedBy: "deterministic",
      confidence: "green",
    });
    const row = db.db
      .query(
        `SELECT big_plan_outcome, big_plan_verified_by, big_plan_confidence,
                gt_outcome, gt_verified_by, gt_confidence
         FROM routing_decisions WHERE rec_id = 'rec-dual'`,
      )
      .get() as Record<string, string | null>;

    expect(row.big_plan_outcome).toBe("verified");
    expect(row.big_plan_verified_by).toBe("deterministic");
    expect(row.big_plan_confidence).toBe("green");
    expect(row.gt_outcome).toBeNull();
    expect(row.gt_verified_by).toBeNull();
    expect(row.gt_confidence).toBeNull();
    db.db.close();
  });

  test("legacy-only gt_* rows still read through the COALESCE fallback", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("project-legacy");
    const runId = db.startRun({ runId: "run-legacy", projectKey: "project-legacy" });
    db.db.run(
      `INSERT INTO routing_decisions (rec_id, run_id, ts, judged, quality, gt_outcome)
       VALUES ('rec-legacy', ?, 1, 1, 0.9, 'failure')`,
      [runId],
    );
    const rows = db.getProjectJudgeGateDisagreements("project-legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.big_plan_outcome).toBe("failure");
    db.db.close();
  });
});

describe("migration runner: concurrent opens", () => {
  test("two processes opening a fresh DB both succeed", async () => {
    const path = join(tempDir(), "minima.db");
    const { codes, out } = await spawnOpeners(path, 2);
    expect(codes).toEqual([0, 0]);
    for (const line of out) expect(Number(line)).toBe(LATEST);
    const db = new MinimaDb(path);
    const rows = db.db.query("SELECT COUNT(*) AS n FROM schema_meta").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(db.schemaVersion).toBe(LATEST);
    db.db.close();
  }, 30000);

  test("two processes opening a version-regressed DB both succeed", async () => {
    const path = migratedDbPath();
    regressVersion(path, 1);
    const { codes, out } = await spawnOpeners(path, 2);
    expect(codes).toEqual([0, 0]);
    for (const line of out) expect(Number(line)).toBe(LATEST);
  }, 30000);
});

// Divergent-lineage schema forks: parallel branches have twice shipped DIFFERENT batches
// under the same version index, so a DB's version stamp does not imply THIS lineage's
// batch contents. reconcileSchema() replays every statement idempotently on open.
describe("reconcileSchema — heals lineage-forked DBs regardless of the version stamp", () => {
  test("the field case: version 11, check_origin present, verify_cwd + gates.rec_id missing", () => {
    const path = migratedDbPath();
    const raw = new Database(path);
    raw.exec("ALTER TABLE plan_steps DROP COLUMN verify_cwd");
    raw.exec("DROP INDEX ix_gates_rec");
    raw.exec("ALTER TABLE gates DROP COLUMN rec_id");
    raw.close();

    const db = new MinimaDb(path);
    const stepCols = db.db.query("PRAGMA table_info(plan_steps)").all() as { name: string }[];
    expect(stepCols.some((c) => c.name === "verify_cwd")).toBe(true);
    const gateCols = db.db.query("PRAGMA table_info(gates)").all() as { name: string }[];
    expect(gateCols.some((c) => c.name === "rec_id")).toBe(true);
    // The crash path from the field report: /bp-seed → upsertPlanFromTodos → insertStep.
    const { planId } = db.upsertPlanFromTodos(
      "run1",
      [{ content: "step", status: "in_progress", verify: "bun test", verify_cwd: "/tmp" }],
      "Healed plan",
    );
    expect(db.getPlanSteps(planId)[0]!.verify_cwd).toBe("/tmp");
    db.db.close();
  });

  test("a missing table is recreated even when the version stamp says fully migrated", () => {
    const path = migratedDbPath();
    const raw = new Database(path);
    raw.exec("DROP TABLE checkpoints");
    raw.close();

    const db = new MinimaDb(path);
    const t = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
      .get();
    expect(t).not.toBeNull();
    expect(db.schemaVersion).toBe(LATEST);
    db.db.close();
  });

  test("a version stamp AHEAD of this lineage still heals (no early-out bypass)", () => {
    const path = migratedDbPath();
    const raw = new Database(path);
    raw.exec("ALTER TABLE plan_steps DROP COLUMN verify_cwd");
    raw.exec("UPDATE schema_meta SET version = 99");
    raw.close();

    const db = new MinimaDb(path);
    const cols = db.db.query("PRAGMA table_info(plan_steps)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "verify_cwd")).toBe(true);
    db.db.close();
  });
});
