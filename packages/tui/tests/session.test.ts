import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SessionStore, formatAge, newId } from "../src/session/index.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "minima-sess-"));
  return dir;
}

describe("SessionStore", () => {
  test("append links entries by parentId and advances the tip", async () => {
    const d = freshDir();
    const path = join(d, "s.jsonl");
    const store = await SessionStore.fileBacked(path);
    const a = await store.append("user", { text: "hi" });
    const b = await store.append("assistant", { text: "hello" });
    expect(store.entries).toHaveLength(2);
    expect(store.tip).toBe(b.id);
    expect(b.parentId).toBe(a.id);
    expect(a.parentId).toBeNull();
  });

  test("reload from disk reconstructs the tree", async () => {
    const d = freshDir();
    const path = join(d, "s.jsonl");
    const store = await SessionStore.fileBacked(path);
    await store.append("user", { text: "q" });
    await store.append("assistant", { text: "a" });
    const reloaded = await SessionStore.fileBacked(path);
    expect(reloaded.entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(reloaded.tip).toBe(reloaded.entries[1]!.id);
  });

  test("pathTo walks root → target", async () => {
    const d = freshDir();
    const store = await SessionStore.fileBacked(join(d, "s.jsonl"));
    const a = await store.append("user", {});
    const b = await store.append("assistant", {});
    const c = await store.append("user", {});
    const path = store.pathTo(c.id);
    expect(path.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  test("setTip branches from an earlier entry", async () => {
    const d = freshDir();
    const store = await SessionStore.fileBacked(join(d, "s.jsonl"));
    const a = await store.append("user", {});
    await store.append("assistant", {});
    store.setTip(a.id);
    const branch = await store.append("user", { alt: true });
    expect(branch.parentId).toBe(a.id);
  });

  test("forkTo copies the path into a new file", async () => {
    const d = freshDir();
    const store = await SessionStore.fileBacked(join(d, "s1.jsonl"));
    const a = await store.append("user", {});
    await store.append("assistant", {});
    const dest = join(d, "s2.jsonl");
    const fork = await store.forkTo(dest, a.id);
    expect(fork.entries).toHaveLength(1);
    expect(fork.entries[0]!.id).toBe(a.id);
  });

  test("in-memory store is not persistent", () => {
    const s = SessionStore.inMemory();
    expect(s.persistent).toBe(false);
  });

  test("formatAge buckets deltas", () => {
    const now = 1000000;
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 120, now)).toBe("2m ago");
    expect(formatAge(now - 7200, now)).toBe("2h ago");
  });

  test("newId is a 12-char hex", () => {
    expect(newId()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("SessionManager", () => {
  // MUB-168 boot contract: a plain `minima` must NEVER attach to a prior session. Resuming
  // is always explicit — an id (--resume//resume) or the resumeMostRecent opt-in.
  test("open without an id starts a NEW session, never the most-recent one", async () => {
    const base = freshDir();
    const mgr = new SessionManager(base);
    const cwd = "/tmp/project-x";
    const s1 = await mgr.new(cwd);
    await s1.append("user", { text: "first" });

    const opened = await mgr.open(cwd);
    expect(opened.entries).toHaveLength(0);
    await opened.append("user", { text: "unrelated" });
    expect(await mgr.listSessions(cwd)).toHaveLength(2);
    const reloaded = await SessionStore.fileBacked((await mgr.mostRecent(cwd))!.path);
    expect(reloaded.entries.map((e) => (e.payload as { text?: string }).text)).not.toContain(
      "first",
    );
  });

  test("new creates a file under the cwd-slug dir; resumeMostRecent opts in to most-recent", async () => {
    const base = freshDir();
    const mgr = new SessionManager(base);
    const cwd = "/tmp/project-x";
    const s1 = await mgr.new(cwd);
    await s1.append("user", { text: "first" });

    const s2 = await mgr.new(cwd);
    await s2.append("user", { text: "second" });

    const sessions = await mgr.listSessions(cwd);
    expect(sessions).toHaveLength(2);

    const recent = await mgr.mostRecent(cwd);
    expect(recent).not.toBeNull();

    const resumed = await mgr.open(cwd, { resumeMostRecent: true });
    expect(resumed.entries.map((e) => (e.payload as { text?: string }).text)).toContain("second");
  });

  test("resumeMostRecent with no prior sessions falls back to a new session", async () => {
    const base = freshDir();
    const mgr = new SessionManager(base);
    const s = await mgr.open("/tmp/project-y", { resumeMostRecent: true });
    expect(s.persistent).toBe(true);
    expect(s.entries).toHaveLength(0);
  });

  test("open with noSession returns an in-memory store", async () => {
    const base = freshDir();
    const mgr = new SessionManager(base);
    const s = await mgr.open("/anywhere", { noSession: true });
    expect(s.persistent).toBe(false);
  });
});
