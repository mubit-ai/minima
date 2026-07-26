import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ToolResult } from "../src/agent/tools.ts";
import { grepTool } from "../src/tools/grep.ts";
import { editTool, readTool, writeTool } from "../src/tools/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-edit-guard-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function bodyOf(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

function sha256(data: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

type MemRow = { start: number; end: number; tool: string };
type MemRange = { start: number; end: number };

function memLedger() {
  const state = new Map<string, { hash: string; rows: MemRow[] }>();
  return {
    enabled: true,
    state,
    rows(path: string) {
      const e = state.get(path);
      if (!e) return [];
      return e.rows.map((r) => ({
        start_line: r.start,
        end_line: r.end,
        file_hash: e.hash,
        tool: r.tool,
      }));
    },
    record(path: string, fileHash: string, ranges: MemRange[], tool: string) {
      const e = state.get(path);
      const keep = e && e.hash === fileHash ? e.rows : [];
      const rows = [...keep, ...ranges.map((r) => ({ start: r.start, end: r.end, tool }))];
      rows.sort((a, b) => a.start - b.start || a.end - b.end);
      state.set(path, { hash: fileHash, rows });
      return true;
    },
    applyEdit(path: string, edit: { spans: MemRange[]; lineDelta: number; newHash: string }) {
      const e = state.get(path);
      const prior = e ? e.rows : [];
      const spans = [...edit.spans].sort((a, b) => a.start - b.start);
      const rows: MemRow[] = [];
      for (const r of prior) {
        let segs: MemRange[] = [{ start: r.start, end: r.end }];
        for (const s of spans) {
          const next: MemRange[] = [];
          for (const g of segs) {
            if (g.end < s.start || g.start > s.end) {
              next.push(g);
              continue;
            }
            if (g.start < s.start) next.push({ start: g.start, end: s.start - 1 });
            if (g.end > s.end) next.push({ start: s.end + 1, end: g.end });
          }
          segs = next;
        }
        for (const g of segs) {
          const k = spans.filter((s) => s.end < g.start).length;
          rows.push({
            start: g.start + k * edit.lineDelta,
            end: g.end + k * edit.lineDelta,
            tool: r.tool,
          });
        }
      }
      spans.forEach((s, i) =>
        rows.push({
          start: s.start + i * edit.lineDelta,
          end: s.end + (i + 1) * edit.lineDelta,
          tool: "edit",
        }),
      );
      rows.sort((a, b) => a.start - b.start || a.end - b.end);
      state.set(path, { hash: edit.newHash, rows });
      return true;
    },
  };
}

const FIVE = "l1\nl2\nl3\nl4\nl5\n";

describe("AC1 stale rejection", () => {
  test("AC1 edit against an out-of-band change is rejected and the file is untouched", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    appendFileSync(f, "drift\n");
    const res = await run(editTool({ seen }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(bodyOf(res)).toMatch(/^edit: stale file: .*re-read these ranges: .*:\d+-\d+/);
    expect(res.details?.edit_guard).toBe("stale");
    expect(res.details?.error).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(`${FIVE}drift\n`);
  });

  test("AC1 stale message pins the snap hashes and previously-seen ranges", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const oldHash = sha256(readFileSync(f));
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    appendFileSync(f, "drift\n");
    const newHash = sha256(readFileSync(f));
    const res = await run(editTool({ seen }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(bodyOf(res)).toBe(
      `edit: stale file: ${f} changed since it was read (snap ${oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)}). re-read these ranges: ${f}:1-5 then retry the edit.`,
    );
    expect(res.details?.reread).toEqual([`${f}:1-5`]);
  });
});

describe("AC2 read stamp + evidence", () => {
  test("AC2 read output ends with the file's snap tag and records the shown window", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const hash = sha256(readFileSync(f));
    const seen = memLedger();
    const res = await run(readTool({ seen }), { path: f, offset: 2, limit: 3 });
    const body = bodyOf(res);
    expect(body.endsWith(`\n[snap:${hash.slice(0, 8)}]`)).toBe(true);
    const last = body.split("\n").at(-1) as string;
    expect(last).toMatch(/^\[snap:[0-9a-f]{8}\]$/);
    const entry = seen.state.get(f);
    expect(entry?.hash).toBe(hash);
    expect(entry?.rows).toEqual([{ start: 2, end: 4, tool: "read" }]);
  });
});

describe("AC3 grep stamp + grep-then-edit", () => {
  test("AC3 grep emits the aggregate snap tag and its evidence allows a context edit", async () => {
    const d = tempDir();
    const files = ["m1.txt", "m2.txt", "m3.txt"].map((nm) => join(d, nm));
    writeFileSync(files[0] as string, "alpha\nmark one\nomega\n");
    writeFileSync(files[1] as string, "alpha\nmark two\ncontext\nomega\n");
    writeFileSync(files[2] as string, "alpha\nmark three\nomega\n");
    const seen = memLedger();
    const res = await run(grepTool({ seen }), { pattern: "mark", path: d });
    const body = bodyOf(res);
    const pairs = files.map((f) => `${f}:${sha256(readFileSync(f))}\n`).sort();
    const agg = sha256(pairs.join(""));
    expect(body.split("\n").at(-1)).toBe(`[snap:${agg.slice(0, 8)} 3 files]`);
    for (const f of files) {
      expect(seen.state.get(f)?.rows.every((r) => r.tool === "grep")).toBe(true);
    }
    const edit = await run(editTool({ seen }), {
      path: files[1] as string,
      old_string: "mark two\ncontext",
      new_string: "mark TWO\ncontext",
    });
    expect(edit.details?.error).toBeUndefined();
    expect(readFileSync(files[1] as string, "utf8")).toBe("alpha\nmark TWO\ncontext\nomega\n");
  });
});

describe("AC4 recovery loop", () => {
  test("AC4 reject -> re-read the named ranges -> retry succeeds", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    appendFileSync(f, "drift\n");
    const rejected = await run(editTool({ seen }), {
      path: f,
      old_string: "l2\n",
      new_string: "L2\n",
    });
    expect(rejected.details?.edit_guard).toBe("stale");
    const reread = rejected.details?.reread as string[];
    expect(Array.isArray(reread)).toBe(true);
    expect(reread.length).toBeGreaterThan(0);
    for (const rr of reread) {
      const m = /^(.*):(\d+)-(\d+)$/.exec(rr);
      expect(m).toBeTruthy();
      const [, path, s, e] = m as unknown as [string, string, string, string];
      const back = await run(readTool({ seen }), {
        path,
        offset: Number(s),
        limit: Number(e) - Number(s) + 1,
      });
      expect(back.details?.error).toBeUndefined();
    }
    const retried = await run(editTool({ seen }), {
      path: f,
      old_string: "l2\n",
      new_string: "L2\n",
    });
    expect(retried.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe(`${FIVE.replace("l2\n", "L2\n")}drift\n`);
  });
});

describe("AC6 parity (tools without the ledger are byte-identical)", () => {
  test("AC6 parity read has no snap line", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");
    const res = await run(readTool(), { path: f, offset: 2, limit: 2 });
    expect(bodyOf(res)).toBe("2: beta\n3: gamma");
    expect(res.details).toEqual({ lines_read: 2 });
  });

  test("AC6 parity grep has no snap line", async () => {
    const d = tempDir();
    writeFileSync(join(d, "g.txt"), "alpha\nmark\n");
    const res = await run(grepTool(), { pattern: "mark", path: d });
    expect(bodyOf(res)).not.toContain("[snap:");
  });

  test("AC6 parity edit after an external change still applies", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    appendFileSync(f, "drift\n");
    const res = await run(editTool(), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(bodyOf(res)).toBe(`edited ${f}: 1 replacement(s)`);
  });
});

describe("verdict matrix", () => {
  test("matrix-1 flag off / unattached / ledger error all ALLOW with no stamp", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);

    const disabled = {
      enabled: false,
      rows(): never {
        throw new Error("must not be called when disabled");
      },
      record(): never {
        throw new Error("must not be called when disabled");
      },
      applyEdit(): never {
        throw new Error("must not be called when disabled");
      },
    };
    const readRes = await run(readTool({ seen: disabled as never }), { path: f });
    expect(bodyOf(readRes)).not.toContain("[snap:");
    appendFileSync(f, "drift\n");
    const editRes = await run(editTool({ seen: disabled as never }), {
      path: f,
      old_string: "l2\n",
      new_string: "L2\n",
    });
    expect(bodyOf(editRes)).toBe(`edited ${f}: 1 replacement(s)`);

    const erroring = {
      enabled: true,
      rows: () => null,
      record: () => false,
      applyEdit: () => false,
    };
    const f2 = join(d, "g.txt");
    writeFileSync(f2, FIVE);
    const read2 = await run(readTool({ seen: erroring as never }), { path: f2 });
    expect(bodyOf(read2)).not.toContain("[snap:");
    const edit2 = await run(editTool({ seen: erroring as never }), {
      path: f2,
      old_string: "l2\n",
      new_string: "L2\n",
    });
    expect(bodyOf(edit2)).toBe(`edited ${f2}: 1 replacement(s)`);
  });

  test("matrix-2 missing file defers to the base error", async () => {
    const d = tempDir();
    const seen = memLedger();
    const res = await run(editTool({ seen }), {
      path: join(d, "nope.txt"),
      old_string: "a",
      new_string: "b",
    });
    expect(bodyOf(res)).toMatch(/^edit: no such file: /);
    expect(res.details?.edit_guard).toBeUndefined();
  });

  test("matrix-3 stale wins even when old_string still matches", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    appendFileSync(f, "drift\n");
    const res = await run(editTool({ seen }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(res.details?.edit_guard).toBe("stale");
    expect(readFileSync(f, "utf8")).toBe(`${FIVE}drift\n`);
  });

  test("matrix-4 hash-equal base errors stay the actionable message", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, "dup\nmid\ndup\n");
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    const missing = await run(editTool({ seen }), {
      path: f,
      old_string: "zzz",
      new_string: "y",
    });
    expect(bodyOf(missing)).toBe(`edit: old_string not found in ${f}`);
    expect(missing.details?.edit_guard).toBeUndefined();
    const ambiguous = await run(editTool({ seen }), {
      path: f,
      old_string: "dup",
      new_string: "DUP",
    });
    expect(bodyOf(ambiguous)).toBe(
      `edit: old_string matches 2 times in ${f}; add more surrounding context or set replace_all=true`,
    );
    expect(ambiguous.details?.edit_guard).toBeUndefined();
  });

  test("matrix-5 intersection (not containment) allows a window edit", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f, offset: 1, limit: 3 });
    const res = await run(editTool({ seen }), {
      path: f,
      old_string: "l3\nl4",
      new_string: "l3\nL4",
    });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("l1\nl2\nl3\nL4\nl5\n");
  });

  test("matrix-6 an occurrence outside every seen range is rejected as unseen", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, "l1\nl2\nl3\nl4\nl5\nl6\nl7\ntarget\n");
    const seen = memLedger();
    await run(readTool({ seen }), { path: f, offset: 1, limit: 3 });
    const res = await run(editTool({ seen }), {
      path: f,
      old_string: "target",
      new_string: "TARGET",
    });
    expect(bodyOf(res)).toBe(
      `edit: unread lines in ${f}: this session has no read evidence covering the target. re-read these ranges: ${f}:8-8 then retry the edit.`,
    );
    expect(res.details?.edit_guard).toBe("unseen");
    expect(res.details?.reread).toEqual([`${f}:8-8`]);
    expect(readFileSync(f, "utf8")).toBe("l1\nl2\nl3\nl4\nl5\nl6\nl7\ntarget\n");
  });

  test("matrix-7 no rows at all rejects with the located occurrence span", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    const res = await run(editTool({ seen }), { path: f, old_string: "l4\n", new_string: "x\n" });
    expect(res.details?.edit_guard).toBe("unseen");
    expect(res.details?.reread).toEqual([`${f}:4-4`]);
    expect(readFileSync(f, "utf8")).toBe(FIVE);
  });

  test("matrix-8 no rows and no match defers to the base error", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    const res = await run(editTool({ seen }), { path: f, old_string: "zzz", new_string: "y" });
    expect(bodyOf(res)).toBe(`edit: old_string not found in ${f}`);
    expect(res.details?.edit_guard).toBeUndefined();
  });

  test("matrix-9 a file written this session is fully seen", async () => {
    const d = tempDir();
    const f = join(d, "w.txt");
    const seen = memLedger();
    await run(writeTool({ seen }), { path: f, content: "one\ntwo\nthree\n" });
    const res = await run(editTool({ seen }), { path: f, old_string: "two", new_string: "TWO" });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("one\nTWO\nthree\n");
  });

  test("matrix-10 a successful edit refreshes the hash and shifts later ranges", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    const first = await run(editTool({ seen }), {
      path: f,
      old_string: "l2\n",
      new_string: "x1\nx2\nx3\n",
    });
    expect(first.details?.error).toBeUndefined();
    const second = await run(editTool({ seen }), {
      path: f,
      old_string: "l4\n",
      new_string: "L4\n",
    });
    expect(second.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("l1\nx1\nx2\nx3\nl3\nL4\nl5\n");
  });

  test("matrix-11 an identical-bytes external rewrite still allows the edit", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    writeFileSync(f, FIVE);
    const res = await run(editTool({ seen }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe(FIVE.replace("l2\n", "L2\n"));
  });

  test("matrix-12 an out-of-band in-place mutation rejects as stale", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, FIVE);
    const seen = memLedger();
    await run(readTool({ seen }), { path: f });
    writeFileSync(f, FIVE.replace("l4\n", "zz\n"));
    const res = await run(editTool({ seen }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(res.details?.edit_guard).toBe("stale");
    expect(readFileSync(f, "utf8")).toBe(FIVE.replace("l4\n", "zz\n"));
  });
});

describe("message-format pins", () => {
  test("stale text caps ranges at 5 with +N more; details carry the full list", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    const thirteen = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\n";
    writeFileSync(f, thirteen);
    const oldHash = sha256(readFileSync(f));
    const seen = memLedger();
    for (const off of [1, 3, 5, 7, 9, 11, 13]) {
      await run(readTool({ seen }), { path: f, offset: off, limit: 1 });
    }
    appendFileSync(f, "drift\n");
    const newHash = sha256(readFileSync(f));
    const res = await run(editTool({ seen }), { path: f, old_string: "l3\n", new_string: "x\n" });
    expect(bodyOf(res)).toBe(
      `edit: stale file: ${f} changed since it was read (snap ${oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)}). re-read these ranges: ${f}:1-1, ${f}:3-3, ${f}:5-5, ${f}:7-7, ${f}:9-9, +2 more then retry the edit.`,
    );
    expect(res.details?.reread).toEqual([
      `${f}:1-1`,
      `${f}:3-3`,
      `${f}:5-5`,
      `${f}:7-7`,
      `${f}:9-9`,
      `${f}:11-11`,
      `${f}:13-13`,
    ]);
  });

  test("replace_all with one unseen occurrence names exactly that span", async () => {
    const d = tempDir();
    const f = join(d, "f.txt");
    writeFileSync(f, "tok\nl2\nl3\nl4\nl5\nl6\nl7\ntok\n");
    const seen = memLedger();
    await run(readTool({ seen }), { path: f, offset: 1, limit: 3 });
    const res = await run(editTool({ seen }), {
      path: f,
      old_string: "tok",
      new_string: "TOK",
      replace_all: true,
    });
    expect(bodyOf(res)).toBe(
      `edit: unread lines in ${f}: this session has no read evidence covering the target. re-read these ranges: ${f}:8-8 then retry the edit.`,
    );
    expect(res.details?.reread).toEqual([`${f}:8-8`]);
    expect(readFileSync(f, "utf8")).toBe("tok\nl2\nl3\nl4\nl5\nl6\nl7\ntok\n");
  });

  test("CRLF content hashes byte-consistently between read and edit", async () => {
    const d = tempDir();
    const f = join(d, "c.txt");
    writeFileSync(f, "alpha\r\nbeta\r\ngamma\r\n");
    const hash = sha256(readFileSync(f));
    const seen = memLedger();
    const res = await run(readTool({ seen }), { path: f });
    expect(bodyOf(res).endsWith(`[snap:${hash.slice(0, 8)}]`)).toBe(true);
    const edit = await run(editTool({ seen }), {
      path: f,
      old_string: "beta\r\n",
      new_string: "BETA\r\n",
    });
    expect(edit.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });
});
