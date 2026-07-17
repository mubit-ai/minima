import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
