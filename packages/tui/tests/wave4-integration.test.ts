import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function shaOf(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

function seedOldRow(db: MinimaDb, dir: string, content: string, runId: string, epoch: number): string {
  const sha = shaOf(content);
  const path = join(dir, `${sha}.txt`);
  Bun.write(path, content);
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
  return path;
}

function rowRunId(db: MinimaDb, path: string): string | null {
  const r = db.db.query("SELECT run_id FROM artifacts WHERE path = ?").get(path) as
    | { run_id: string | null }
    | null;
  return r ? r.run_id : null;
}

// Cross-slice property no single Wave-4 slice tested: bgjobs (W4.1) and compaction v2 (W4.5)
// are BOTH spill producers through the same attached ArtifactStore, and W3.3's GC protects the
// current run's artifacts by run_id. Each slice tested its own producer against GC in isolation;
// this proves the exemption holds when both producers write into one store under a tiny budget.
describe("Wave 4 integration — two spill producers under one GC exemption", () => {
  test("a compaction spill and a bgjobs-style bash spill both survive GC as current-run; old-run rows evict", async () => {
    const base = tempDir("minima-w4int-");
    const db = new MinimaDb(join(base, "minima.db"));
    const artDir = join(base, "artifacts");

    // Two 400-byte old-run artifacts already on disk (800B) from a finished run.
    const old1 = seedOldRow(db, artDir, "O".repeat(400), "run-old", 1);
    const old2 = seedOldRow(db, artDir, "P".repeat(400), "run-old", 2);

    // Budget below the two old rows so GC must evict on attach, but the store protects run-cur.
    const store = new ArtifactStore({ dir: artDir, gcBudgetBytes: 500 });
    store.attach(db, "run-cur");

    // Producer 1: compaction v2 spills the pruned window (tool_name="compact").
    const compactRef = store.sink("compact")("compacted transcript window ".repeat(30));
    // Producer 2: a background bash job tees its output (tool_name="bash").
    const bashStream = store.beginStream("bash");
    expect(bashStream).not.toBeNull();
    bashStream!.write("dev server log line\n".repeat(40));
    const bashRes = await bashStream!.commit();

    expect(compactRef).not.toBeNull();
    expect(bashRes).not.toBeNull();
    const compactPath = compactRef!.ref;
    const bashPath = bashRes!.ref;

    // Both current-run artifacts survive on disk and own run-cur (the exemption predicate).
    expect(existsSync(compactPath)).toBe(true);
    expect(existsSync(bashPath)).toBe(true);
    expect(rowRunId(db, compactPath)).toBe("run-cur");
    expect(rowRunId(db, bashPath)).toBe("run-cur");

    // The finished run's artifacts were evicted by the post-spill GC, files and rows together.
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(rowRunId(db, old1)).toBeNull();
    expect(rowRunId(db, old2)).toBeNull();

    db.close();
  });
});
