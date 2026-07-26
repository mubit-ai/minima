import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";
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

function newStore(): { store: ArtifactStore; dir: string } {
  const dir = join(tempDir("minima-artstore-"), "artifacts");
  return { store: new ArtifactStore({ dir }), dir };
}

function newDb(): { db: MinimaDb; path: string } {
  const path = join(tempDir("minima-artdb-"), "minima.db");
  return { db: new MinimaDb(path), path };
}

describe("ArtifactStore content addressing (AC4)", () => {
  test("same text twice: same ref, one file, one upserted row with bumped last_used", () => {
    const { store, dir } = newStore();
    const { db } = newDb();
    store.attach(db, "run-1");
    const sink = store.sink("grep");
    const first = sink("alpha\nbeta\n");
    expect(first).not.toBeNull();
    Bun.sleepSync(15);
    const second = sink("alpha\nbeta\n");
    expect(second?.ref).toBe(first?.ref ?? "");
    expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBe(1);
    const sha = basename(first?.ref ?? "", ".txt");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update("alpha\nbeta\n");
    expect(sha).toBe(hasher.digest("hex"));
    expect(readFileSync(first?.ref ?? "", "utf8")).toBe("alpha\nbeta\n");
    const rows = db.db
      .query(
        "SELECT run_id, tool_name, bytes, line_count, created, last_used FROM artifacts WHERE sha = ?",
      )
      .all(sha) as {
      run_id: string;
      tool_name: string;
      bytes: number;
      line_count: number;
      created: number;
      last_used: number;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.run_id).toBe("run-1");
    expect(rows[0]?.tool_name).toBe("grep");
    expect(rows[0]?.bytes).toBe(11);
    expect(rows[0]?.line_count).toBe(2);
    expect(rows[0]?.last_used ?? 0).toBeGreaterThan(rows[0]?.created ?? Number.POSITIVE_INFINITY);
    db.close();
  });

  test("unattached store still writes the artifact file (fail-open)", () => {
    const { store } = newStore();
    const r = store.sink("ls")("one\ntwo");
    expect(r).not.toBeNull();
    expect(existsSync(r?.ref ?? "")).toBe(true);
    expect(readFileSync(r?.ref ?? "", "utf8")).toBe("one\ntwo");
  });
});

describe("ArtifactStore streams (AC4)", () => {
  test("write→commit lands the content-addressed file; discard leaves nothing", async () => {
    const { store, dir } = newStore();
    const s = store.beginStream("bash");
    expect(s).not.toBeNull();
    s?.write("chunk-1\n");
    s?.write("chunk-2\n");
    const done = await s?.commit();
    expect(done).not.toBeNull();
    const saved = readFileSync(done?.ref ?? "", "utf8");
    expect(saved).toBe("chunk-1\nchunk-2\n");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(saved);
    expect(basename(done?.ref ?? "")).toBe(`${hasher.digest("hex")}.txt`);
    expect(readdirSync(dir).some((f) => f.endsWith(".part"))).toBe(false);

    const d = store.beginStream("bash");
    d?.write("throwaway");
    await d?.discard();
    expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBe(1);
    expect(readdirSync(dir).some((f) => f.endsWith(".part"))).toBe(false);

    const dup = store.beginStream("bash");
    dup?.write("chunk-1\n");
    dup?.write("chunk-2\n");
    const again = await dup?.commit();
    expect(again?.ref).toBe(done?.ref ?? "");
    expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBe(1);
    expect(readdirSync(dir).some((f) => f.endsWith(".part"))).toBe(false);
  });

  test("attached stream commit records provenance", async () => {
    const { store } = newStore();
    const { db } = newDb();
    store.attach(db, "run-s");
    const s = store.beginStream("bash");
    s?.write("x".repeat(10));
    const done = await s?.commit();
    expect(done).not.toBeNull();
    const sha = basename(done?.ref ?? "", ".txt");
    const row = db.db
      .query("SELECT run_id, tool_name, bytes, line_count FROM artifacts WHERE sha = ?")
      .get(sha) as {
      run_id: string;
      tool_name: string;
      bytes: number;
      line_count: number;
    } | null;
    expect(row?.run_id).toBe("run-s");
    expect(row?.tool_name).toBe("bash");
    expect(row?.bytes).toBe(10);
    expect(row?.line_count).toBe(1);
    db.close();
  });
});

describe("artifacts migration (AC4)", () => {
  test("fresh DB has the artifacts table + index; double-open replays cleanly", () => {
    const { db, path } = newDb();
    expect(
      db.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").get(),
    ).not.toBeNull();
    expect(
      db.db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_artifacts_run'")
        .get(),
    ).not.toBeNull();
    const cols = (db.db.query("PRAGMA table_info(artifacts)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      "sha",
      "path",
      "run_id",
      "tool_name",
      "bytes",
      "line_count",
      "created",
      "last_used",
    ]);
    db.close();
    const again = new MinimaDb(path);
    expect(
      again.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'")
        .get(),
    ).not.toBeNull();
    again.close();
  });

  test("recordArtifact is idempotent on sha", () => {
    const { db } = newDb();
    const r = {
      sha: "a".repeat(64),
      path: "/tmp/x.txt",
      runId: null,
      toolName: "grep",
      bytes: 3,
      lineCount: 1,
    };
    db.recordArtifact(r);
    db.recordArtifact(r);
    const n = db.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});
