import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";
import { configFromEnv } from "../src/minima/config.ts";
import { ArtifactStore } from "../src/tools/_artifacts.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newFixture(): { db: MinimaDb; dir: string } {
  const base = tempDir("minima-artgc-");
  const db = new MinimaDb(join(base, "minima.db"));
  return { db, dir: join(base, "artifacts") };
}

function shaOf(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

function seedArtifact(
  db: MinimaDb,
  dir: string,
  content: string,
  runId: string,
  epoch: number,
): { sha: string; path: string } {
  const sha = shaOf(content);
  const path = join(dir, `${sha}.txt`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf8");
  db.recordArtifact({
    sha,
    path,
    runId,
    toolName: "grep",
    bytes: Buffer.byteLength(content, "utf8"),
    lineCount: 1,
  });
  db.db.run("UPDATE artifacts SET created = ?, last_used = ?, run_id = ? WHERE sha = ?", [
    epoch,
    epoch,
    runId,
    sha,
  ]);
  return { sha, path };
}

function rowFor(db: MinimaDb, sha: string): { run_id: string | null; last_used: number } | null {
  return db.db.query("SELECT run_id, last_used FROM artifacts WHERE sha = ?").get(sha) as {
    run_id: string | null;
    last_used: number;
  } | null;
}

function totalBytes(db: MinimaDb): number {
  const row = db.db.query("SELECT COALESCE(SUM(bytes), 0) AS total FROM artifacts").get() as {
    total: number;
  };
  return row.total;
}

describe("artifact GC at attach (startup)", () => {
  test("prunes LRU rows until the dir fits the budget; files and rows go together", () => {
    const { db, dir } = newFixture();
    const a = seedArtifact(db, dir, "a".repeat(60), "run-old", 100);
    const b = seedArtifact(db, dir, "b".repeat(60), "run-old", 200);
    const c = seedArtifact(db, dir, "c".repeat(60), "run-old", 300);
    const store = new ArtifactStore({ dir, gcBudgetBytes: 100 });
    store.attach(db, "run-new");
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(existsSync(c.path)).toBe(true);
    expect(rowFor(db, a.sha)).toBeNull();
    expect(rowFor(db, b.sha)).toBeNull();
    expect(rowFor(db, c.sha)).not.toBeNull();
    expect(totalBytes(db)).toBeLessThanOrEqual(100);
    db.close();
  });

  test("last_used ordering respected: only the oldest goes when one eviction suffices", () => {
    const { db, dir } = newFixture();
    const a = seedArtifact(db, dir, "a".repeat(60), "run-old", 100);
    const b = seedArtifact(db, dir, "b".repeat(60), "run-old", 200);
    const c = seedArtifact(db, dir, "c".repeat(60), "run-old", 300);
    const store = new ArtifactStore({ dir, gcBudgetBytes: 130 });
    store.attach(db, "run-new");
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(c.path)).toBe(true);
    expect(rowFor(db, a.sha)).toBeNull();
    expect(rowFor(db, b.sha)).not.toBeNull();
    expect(rowFor(db, c.sha)).not.toBeNull();
    db.close();
  });

  test("rows owned by the attached run are never pruned, even over budget", () => {
    const { db, dir } = newFixture();
    const cur = seedArtifact(db, dir, "x".repeat(200), "run-cur", 100);
    const old = seedArtifact(db, dir, "y".repeat(60), "run-old", 50);
    const store = new ArtifactStore({ dir, gcBudgetBytes: 100 });
    store.attach(db, "run-cur");
    expect(existsSync(old.path)).toBe(false);
    expect(rowFor(db, old.sha)).toBeNull();
    expect(existsSync(cur.path)).toBe(true);
    expect(rowFor(db, cur.sha)).not.toBeNull();
    db.close();
  });

  test("budget 0 disables GC: nothing pruned", () => {
    const { db, dir } = newFixture();
    const a = seedArtifact(db, dir, "a".repeat(60), "run-old", 100);
    const b = seedArtifact(db, dir, "b".repeat(60), "run-old", 200);
    const store = new ArtifactStore({ dir, gcBudgetBytes: 0 });
    store.attach(db, "run-new");
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(rowFor(db, a.sha)).not.toBeNull();
    expect(rowFor(db, b.sha)).not.toBeNull();
    db.close();
  });
});

describe("artifact GC post-spill", () => {
  test("a spill that pushes the dir over budget evicts the LRU row", () => {
    const { db, dir } = newFixture();
    const store = new ArtifactStore({ dir, gcBudgetBytes: 100 });
    store.attach(db, "run-cur");
    const first = store.sink("grep")("o".repeat(60));
    expect(first).not.toBeNull();
    const firstSha = shaOf("o".repeat(60));
    db.db.run("UPDATE artifacts SET run_id = 'run-old', last_used = 1 WHERE sha = ?", [firstSha]);
    const second = store.sink("grep")("n".repeat(80));
    expect(second).not.toBeNull();
    expect(existsSync(first?.ref ?? "")).toBe(false);
    expect(rowFor(db, firstSha)).toBeNull();
    expect(existsSync(second?.ref ?? "")).toBe(true);
    expect(totalBytes(db)).toBeLessThanOrEqual(100);
    db.close();
  });

  test("re-spill of an indexed sha claims run_id for the current run and bumps last_used", () => {
    const { db, dir } = newFixture();
    const content = "z".repeat(40);
    const oldStore = new ArtifactStore({ dir, gcBudgetBytes: 1_000_000 });
    oldStore.attach(db, "run-old");
    const first = oldStore.sink("grep")(content);
    expect(first).not.toBeNull();
    const sha = shaOf(content);
    db.db.run("UPDATE artifacts SET last_used = 1 WHERE sha = ?", [sha]);
    const curStore = new ArtifactStore({ dir, gcBudgetBytes: 1_000_000 });
    curStore.attach(db, "run-cur");
    const again = curStore.sink("bash")(content);
    expect(again?.ref).toBe(first?.ref ?? "");
    const row = rowFor(db, sha);
    expect(row?.run_id).toBe("run-cur");
    expect(row?.last_used ?? 0).toBeGreaterThan(1);
    db.close();
  });

  test("a pruned artifact re-spills cleanly to the same path", () => {
    const { db, dir } = newFixture();
    const content = "p".repeat(120);
    const sha = shaOf(content);
    const seeded = seedArtifact(db, dir, content, "run-old", 10);
    const store = new ArtifactStore({ dir, gcBudgetBytes: 100 });
    store.attach(db, "run-cur");
    expect(existsSync(seeded.path)).toBe(false);
    expect(rowFor(db, sha)).toBeNull();
    const back = store.sink("grep")(content);
    expect(back?.ref).toBe(seeded.path);
    expect(existsSync(seeded.path)).toBe(true);
    expect(rowFor(db, sha)?.run_id).toBe("run-cur");
    db.close();
  });
});

describe("artifact GC config knob", () => {
  const KEY = "MINIMA_TUI_ARTIFACT_GC_MB";
  afterEach(() => {
    delete process.env[KEY];
  });

  test("defaults to 512 MB when unset", () => {
    delete process.env[KEY];
    expect(configFromEnv().artifactGcMb).toBe(512);
  });

  test("env override wins; 0 means disabled; junk falls back to the default", () => {
    process.env[KEY] = "64";
    expect(configFromEnv().artifactGcMb).toBe(64);
    process.env[KEY] = "0";
    expect(configFromEnv().artifactGcMb).toBe(0);
    process.env[KEY] = "nope";
    expect(configFromEnv().artifactGcMb).toBe(512);
    process.env[KEY] = "-5";
    expect(configFromEnv().artifactGcMb).toBe(512);
  });
});
