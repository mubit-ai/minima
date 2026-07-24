import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentState } from "../src/agent/state.ts";
import type { ToolResult } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { makeArtifactReadTouchHook } from "../src/tools/_artifact_gc.ts";
import { ArtifactStore } from "../src/tools/_artifacts.ts";
import { readTool } from "../src/tools/read.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newFixture(): { db: MinimaDb; dir: string; store: ArtifactStore } {
  const base = tempDir("minima-arttouch-");
  const db = new MinimaDb(join(base, "minima.db"));
  const dir = join(base, "artifacts");
  const store = new ArtifactStore({ dir, gcBudgetBytes: 1_000_000 });
  store.attach(db, "run-cur");
  return { db, dir, store };
}

function lastUsedOf(db: MinimaDb, sha: string): number {
  const row = db.db.query("SELECT last_used FROM artifacts WHERE sha = ?").get(sha) as {
    last_used: number;
  } | null;
  return row?.last_used ?? -1;
}

function spill(db: MinimaDb, store: ArtifactStore, content: string): { sha: string; ref: string } {
  const r = store.sink("grep")(content);
  if (!r) throw new Error("spill failed");
  const sha = basename(r.ref, ".txt");
  db.db.run("UPDATE artifacts SET last_used = 5 WHERE sha = ?", [sha]);
  return { sha, ref: r.ref };
}

const agentState = {} as AgentState;

function readCtx(path: string, result: ToolResult, isError = false) {
  return {
    toolCall: { type: "toolCall" as const, id: "tc-1", name: "read", arguments: { path } },
    result,
    isError,
    context: agentState,
  };
}

describe("last_used touch on artifact re-read", () => {
  test("noteRead bumps last_used for a path inside the artifact dir", () => {
    const { db, store } = newFixture();
    const { sha, ref } = spill(db, store, "hello artifact\n");
    expect(lastUsedOf(db, sha)).toBe(5);
    store.noteRead(ref);
    expect(lastUsedOf(db, sha)).toBeGreaterThan(5);
    db.close();
  });

  test("noteRead ignores paths outside the dir and non-artifact names inside it", () => {
    const { db, store } = newFixture();
    const { sha } = spill(db, store, "hello artifact\n");
    store.noteRead("/etc/hosts");
    store.noteRead(join(store.dir, "not-a-sha.txt"));
    expect(lastUsedOf(db, sha)).toBe(5);
    db.close();
  });

  test("afterToolCall hook touches on a successful read of an artifact path", async () => {
    const { db, store } = newFixture();
    const { sha, ref } = spill(db, store, "paged back\n");
    const hook = makeArtifactReadTouchHook(store);
    const tool = readTool({ workdir: tempDir("minima-workdir-"), artifacts: store });
    const result = await tool.execute("tc-1", { path: ref, offset: 1, limit: 2000 }, null, null);
    expect(result.details?.error).toBeUndefined();
    await hook(readCtx(ref, result));
    expect(lastUsedOf(db, sha)).toBeGreaterThan(5);
    db.close();
  });

  test("afterToolCall hook skips errored results and non-path calls", async () => {
    const { db, store } = newFixture();
    const { sha, ref } = spill(db, store, "paged back\n");
    const hook = makeArtifactReadTouchHook(store);
    const errored: ToolResult = { content: [], details: { error: true } };
    await hook(readCtx(ref, errored));
    await hook(readCtx(ref, { content: [] }, true));
    await hook({
      toolCall: { type: "toolCall" as const, id: "tc-2", name: "bash", arguments: { command: "ls" } },
      result: { content: [] },
      isError: false,
      context: agentState,
    });
    expect(lastUsedOf(db, sha)).toBe(5);
    db.close();
  });
});
