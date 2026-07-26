import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  SeenLedger,
  coalesce,
  hashFile,
  occurrenceSpans,
  sha256Hex,
} from "../src/tools/_seen.ts";
import { readTool } from "../src/tools/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-seen-ledger-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attached(): { db: MinimaDb; led: SeenLedger } {
  const db = new MinimaDb(":memory:");
  const led = new SeenLedger();
  led.attach(db, "r1");
  return { db, led };
}

function shape(led: SeenLedger, path: string) {
  return (led.rows(path) ?? []).map((r) => ({
    s: r.start_line,
    e: r.end_line,
    h: r.file_hash,
    t: r.tool,
  }));
}

describe("migration (AC5)", () => {
  test("a fresh MinimaDb has the seen_lines table and index (no version pin)", () => {
    const db = new MinimaDb(":memory:");
    const table = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='seen_lines'")
      .get();
    expect(table).toBeTruthy();
    const index = db.db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_seen_lines_key'")
      .get();
    expect(index).toBeTruthy();
    const cols = (db.db.query("PRAGMA table_info(seen_lines)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      "id",
      "run_id",
      "agent_id",
      "path",
      "start_line",
      "end_line",
      "file_hash",
      "tool",
      "created",
    ]);
    db.db.close();
  });

  test("open -> close -> open replays cleanly and keeps rows", () => {
    const dir = tempDir();
    const path = join(dir, "m.db");
    const db1 = new MinimaDb(path);
    db1.replaceSeenLines("r1", "/tmp/f.txt", "h1", [{ start: 1, end: 5, tool: "read" }]);
    db1.db.close();
    const db2 = new MinimaDb(path);
    const rows = db2.listSeenLines("r1", "/tmp/f.txt");
    expect(rows.length).toBe(1);
    expect(rows[0]?.start_line).toBe(1);
    expect(rows[0]?.end_line).toBe(5);
    expect(rows[0]?.file_hash).toBe("h1");
    expect(rows[0]?.tool).toBe("read");
    expect(rows[0]?.agent_id).toBeNull();
    db2.db.close();
  });
});

describe("ledger semantics (AC5)", () => {
  test("record supersedes rows carrying a different hash", () => {
    const { db, led } = attached();
    const p = "/tmp/seen/a.txt";
    expect(led.record(p, "h1", [{ start: 1, end: 5 }], "read")).toBe(true);
    expect(shape(led, p)).toEqual([{ s: 1, e: 5, h: "h1", t: "read" }]);
    expect(led.record(p, "h2", [{ start: 3, end: 4 }], "grep")).toBe(true);
    expect(shape(led, p)).toEqual([{ s: 3, e: 4, h: "h2", t: "grep" }]);
    db.db.close();
  });

  test("record coalesces adjacent and overlapping ranges under one hash", () => {
    const { db, led } = attached();
    const p = "/tmp/seen/b.txt";
    led.record(p, "h1", [{ start: 1, end: 3 }], "read");
    led.record(p, "h1", [{ start: 4, end: 6 }], "read");
    led.record(p, "h1", [{ start: 5, end: 9 }], "grep");
    expect(shape(led, p)).toEqual([{ s: 1, e: 9, h: "h1", t: "read" }]);
    led.record(p, "h1", [{ start: 20, end: 22 }], "grep");
    expect(shape(led, p)).toEqual([
      { s: 1, e: 9, h: "h1", t: "read" },
      { s: 20, e: 22, h: "h1", t: "grep" },
    ]);
    db.db.close();
  });

  test("applyEdit shifts disjoint ranges below the span by the line delta", () => {
    const { db, led } = attached();
    const p = "/tmp/seen/c.txt";
    led.record(p, "h1", [{ start: 1, end: 2 }], "read");
    led.record(p, "h1", [{ start: 8, end: 10 }], "read");
    expect(
      led.applyEdit(p, { spans: [{ start: 4, end: 4 }], lineDelta: 2, newHash: "h2" }),
    ).toBe(true);
    expect(shape(led, p)).toEqual([
      { s: 1, e: 2, h: "h2", t: "read" },
      { s: 4, e: 6, h: "h2", t: "edit" },
      { s: 10, e: 12, h: "h2", t: "read" },
    ]);
    db.db.close();
  });

  test("applyEdit handles negative deltas", () => {
    const { db, led } = attached();
    const p = "/tmp/seen/d.txt";
    led.record(p, "h1", [{ start: 1, end: 2 }], "read");
    led.record(p, "h1", [{ start: 8, end: 10 }], "read");
    led.applyEdit(p, { spans: [{ start: 4, end: 6 }], lineDelta: -2, newHash: "h2" });
    expect(shape(led, p)).toEqual([
      { s: 1, e: 2, h: "h2", t: "read" },
      { s: 4, e: 4, h: "h2", t: "edit" },
      { s: 6, e: 8, h: "h2", t: "read" },
    ]);
    db.db.close();
  });

  test("applyEdit shifts cumulatively across multiple occurrences", () => {
    const { db, led } = attached();
    const p = "/tmp/seen/e.txt";
    led.record(p, "h1", [{ start: 1, end: 20 }], "read");
    led.applyEdit(p, {
      spans: [
        { start: 5, end: 5 },
        { start: 10, end: 10 },
      ],
      lineDelta: 1,
      newHash: "h2",
    });
    expect(shape(led, p)).toEqual([{ s: 1, e: 22, h: "h2", t: "read" }]);
    db.db.close();
  });
});

describe("fail-open (AC5, verdict row 1)", () => {
  test("an unattached ledger is disabled and inert", async () => {
    const led = new SeenLedger();
    expect(led.enabled).toBe(false);
    expect(led.rows("/tmp/x")).toBeNull();
    expect(led.record("/tmp/x", "h", [{ start: 1, end: 1 }], "read")).toBe(false);
    expect(led.applyEdit("/tmp/x", { spans: [], lineDelta: 0, newHash: "h" })).toBe(false);

    const dir = tempDir();
    const f = join(dir, "f.txt");
    writeFileSync(f, "alpha\nbeta\n");
    const tool = readTool({ seen: led });
    const parsed = tool.parameters.validate({ path: f });
    if (!parsed.ok) throw new Error("validate failed");
    const res = await tool.execute("t1", parsed.value, null, null);
    expect((res.content[0] as { text: string }).text).toBe("1: alpha\n2: beta");
  });

  test("a throwing index breaks the ledger open (enabled flips false)", () => {
    const led = new SeenLedger();
    led.attach(
      {
        listSeenLines() {
          throw new Error("boom");
        },
        replaceSeenLines() {
          throw new Error("boom");
        },
      },
      "r1",
    );
    expect(led.enabled).toBe(true);
    expect(led.record("/tmp/x", "h", [{ start: 1, end: 1 }], "read")).toBe(false);
    expect(led.enabled).toBe(false);
    expect(led.rows("/tmp/x")).toBeNull();
  });
});

describe("helpers", () => {
  test("hashFile hashes bytes and honors the size cap", async () => {
    const dir = tempDir();
    const f = join(dir, "h.txt");
    writeFileSync(f, "0123456789".repeat(10));
    expect(await hashFile(f)).toBe(sha256Hex("0123456789".repeat(10)));
    expect(await hashFile(f, 50)).toBeNull();
    expect(await hashFile(dir)).toBeNull();
    expect(await hashFile(join(dir, "missing.txt"))).toBeNull();
  });

  test("coalesce merges overlapping and adjacent ranges", () => {
    expect(
      coalesce([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 3, end: 4 },
        { start: 10, end: 12 },
      ]),
    ).toEqual([
      { start: 1, end: 6 },
      { start: 10, end: 12 },
    ]);
  });

  test("occurrenceSpans maps occurrences to 1-based line spans", () => {
    const body = "aaa\nbbb\nccc\nbbb\n";
    expect(occurrenceSpans(body, "bbb", false)).toEqual([{ start: 2, end: 2 }]);
    expect(occurrenceSpans(body, "bbb", true)).toEqual([
      { start: 2, end: 2 },
      { start: 4, end: 4 },
    ]);
    expect(occurrenceSpans(body, "bbb\nccc", true)).toEqual([{ start: 2, end: 3 }]);
    expect(occurrenceSpans(body, "zzz", true)).toEqual([]);
  });
});

describe("applyEdits / forget / agent scope (edit-guard v2)", () => {
  test("applyEdits remaps prior evidence through a per-hunk delta (in place)", () => {
    const { db, led } = attached();
    const p = "/tmp/v2/a.txt";
    led.record(p, "h1", [{ start: 1, end: 2 }], "read");
    led.record(p, "h1", [{ start: 8, end: 12 }], "read");
    led.record(p, "h1", [{ start: 20, end: 22 }], "read");
    // one hunk: original line 9 (before length 1) becomes 3 lines -> delta +2.
    expect(
      led.applyEdits(p, p, { edits: [{ span: { start: 9, end: 9 }, delta: 2 }], newHash: "h2" }),
    ).toBe(true);
    expect(shape(led, p)).toEqual([
      { s: 1, e: 2, h: "h2", t: "read" },
      { s: 8, e: 14, h: "h2", t: "read" },
      { s: 22, e: 24, h: "h2", t: "read" },
    ]);
    db.db.close();
  });

  test("applyEdits composes multiple out-of-order per-hunk deltas", () => {
    const { db, led } = attached();
    const p = "/tmp/v2/b.txt";
    led.record(p, "h1", [{ start: 1, end: 30 }], "read");
    // hunks supplied out of file order; each carries its own delta.
    led.applyEdits(p, p, {
      edits: [
        { span: { start: 20, end: 21 }, delta: 1 },
        { span: { start: 5, end: 5 }, delta: 3 },
      ],
      newHash: "h2",
    });
    // [1,30] shifted: everything past line 21 gains 3+1=4, past line 5 gains 3 -> end 30 -> 34.
    expect(shape(led, p)).toEqual([{ s: 1, e: 34, h: "h2", t: "read" }]);
    db.db.close();
  });

  test("applyEdits with src != dest remaps to dest and clears src (the move case)", () => {
    const { db, led } = attached();
    const src = "/tmp/v2/src.txt";
    const dst = "/tmp/v2/dst.txt";
    led.record(src, "h1", [{ start: 1, end: 5 }], "read");
    led.applyEdits(src, dst, { edits: [{ span: { start: 2, end: 2 }, delta: 0 }], newHash: "h2" });
    expect(shape(led, src)).toEqual([]);
    expect(shape(led, dst)).toEqual([{ s: 1, e: 5, h: "h2", t: "read" }]);
    db.db.close();
  });

  test("forget clears a path's evidence", () => {
    const { db, led } = attached();
    const p = "/tmp/v2/c.txt";
    led.record(p, "h1", [{ start: 1, end: 5 }], "read");
    expect(led.forget(p)).toBe(true);
    expect(shape(led, p)).toEqual([]);
    db.db.close();
  });

  test("agent-scoped ledgers on one run do not cross-see or cross-clobber", () => {
    const db = new MinimaDb(":memory:");
    const a = new SeenLedger();
    a.attach(db, "r1", "A");
    const b = new SeenLedger();
    b.attach(db, "r1", "B");
    const p = "/tmp/v2/shared.txt";
    a.record(p, "h1", [{ start: 1, end: 3 }], "read");
    expect(shape(a, p)).toEqual([{ s: 1, e: 3, h: "h1", t: "read" }]);
    expect(shape(b, p)).toEqual([]);
    // B replacing its own scope must not delete A's rows for the same path.
    b.record(p, "h9", [{ start: 8, end: 9 }], "read");
    expect(shape(a, p)).toEqual([{ s: 1, e: 3, h: "h1", t: "read" }]);
    expect(shape(b, p)).toEqual([{ s: 8, e: 9, h: "h9", t: "read" }]);
    const lead = new SeenLedger();
    lead.attach(db, "r1");
    expect(shape(lead, p)).toEqual([]);
    db.db.close();
  });

  test("applyEdits/forget on an unattached ledger are inert", () => {
    const led = new SeenLedger();
    expect(led.applyEdits("/tmp/x", "/tmp/y", { edits: [], newHash: "h" })).toBe(false);
    expect(led.forget("/tmp/x")).toBe(false);
  });
});
