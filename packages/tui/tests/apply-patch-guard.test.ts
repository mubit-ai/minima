import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ToolResult } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { applyPatchTool, editTool, readTool } from "../src/tools/index.ts";
import { SeenLedger } from "../src/tools/_seen.ts";

const dirs: string[] = [];
const dbs: MinimaDb[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-ap-guard-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledger(): SeenLedger {
  const db = new MinimaDb(":memory:");
  dbs.push(db);
  const seen = new SeenLedger();
  seen.attach(db, "run1");
  return seen;
}

async function run(tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function bodyOf(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

const FIVE = "l1\nl2\nl3\nl4\nl5\n";

function updateHunk(path: string, ctxBefore: string, minus: string, plus: string, ctxAfter: string) {
  return (
    "*** Begin Patch\n" +
    `*** Update File: ${path}\n` +
    ` ${ctxBefore}\n` +
    `-${minus}\n` +
    `+${plus}\n` +
    ` ${ctxAfter}\n` +
    "*** End Patch\n"
  );
}

async function rereadAll(seen: SeenLedger, reread: string[]): Promise<void> {
  for (const rr of reread) {
    const m = /^(.*):(\d+)-(\d+)$/.exec(rr);
    if (!m) throw new Error(`bad reread token: ${rr}`);
    const [, path, s, e] = m as unknown as [string, string, string, string];
    await run(readTool({ seen }), {
      path,
      offset: Number(s),
      limit: Number(e) - Number(s) + 1,
    });
  }
}

describe("AC1 stale apply_patch rejected with re-read ranges", () => {
  test("AC1 an Update-File hunk on a drifted file is rejected, disk untouched, re-read+retry succeeds", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: f });
    appendFileSync(f, "drift\n");
    const patch = updateHunk(f, "l1", "l2", "L2", "l3");

    const res = await run(applyPatchTool({ seen }), { patch });
    expect(res.details?.error).toBe(true);
    expect(res.details?.edit_guard).toBe("stale");
    expect(bodyOf(res)).toMatch(/apply_patch: stale file/);
    expect(bodyOf(res)).toMatch(/re-read these ranges: .*:\d+-\d+/);
    expect(readFileSync(f, "utf8")).toBe(`${FIVE}drift\n`);

    const reread = res.details?.reread as string[];
    expect(Array.isArray(reread)).toBe(true);
    expect(reread.length).toBeGreaterThan(0);
    await rereadAll(seen, reread);

    const retry = await run(applyPatchTool({ seen }), { patch });
    expect(retry.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe(`${FIVE.replace("l2\n", "L2\n")}drift\n`);
  });

  test("AC1 multi-file aggregation names every failing file in one message", async () => {
    const d = tempDir();
    const f1 = join(d, "a.txt");
    const f2 = join(d, "b.txt");
    writeFileSync(f1, FIVE);
    writeFileSync(f2, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: f1 });
    await run(readTool({ seen }), { path: f2 });
    appendFileSync(f1, "drift\n");
    appendFileSync(f2, "drift\n");
    const patch =
      "*** Begin Patch\n" +
      `*** Update File: ${f1}\n l1\n-l2\n+L2\n l3\n` +
      `*** Update File: ${f2}\n l1\n-l2\n+L2\n l3\n` +
      "*** End Patch\n";

    const res = await run(applyPatchTool({ seen }), { patch });
    expect(res.details?.error).toBe(true);
    const body = bodyOf(res);
    expect(body).toContain(f1);
    expect(body).toContain(f2);
    const reread = res.details?.reread as string[];
    expect(reread.some((r) => r.startsWith(f1))).toBe(true);
    expect(reread.some((r) => r.startsWith(f2))).toBe(true);
    expect(readFileSync(f1, "utf8")).toBe(`${FIVE}drift\n`);
    expect(readFileSync(f2, "utf8")).toBe(`${FIVE}drift\n`);
  });
});

describe("AC2 patch-then-edit costs no stale round trip", () => {
  test("AC2 apply_patch updates the ledger hash so a later edit on a seen region succeeds", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: f });
    const patch = updateHunk(f, "l1", "l2", "L2", "l3");
    const applied = await run(applyPatchTool({ seen }), { patch });
    expect(applied.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("l1\nL2\nl3\nl4\nl5\n");

    const edit = await run(editTool({ seen }), { path: f, old_string: "l4\n", new_string: "L4\n" });
    expect(edit.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("l1\nL2\nl3\nL4\nl5\n");
  });
});

describe("AC3 fresh/unseen matrix", () => {
  test("AC3a read then patch applies content-exact", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: f });
    const res = await run(applyPatchTool({ seen }), { patch: updateHunk(f, "l2", "l3", "L3", "l4") });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("l1\nl2\nL3\nl4\nl5\n");
  });

  test("AC3b Add File needs no prior evidence and records full-file (follow-up edit passes)", async () => {
    const d = tempDir();
    const nf = join(d, "new.txt");
    const seen = ledger();
    const patch =
      "*** Begin Patch\n" + `*** Add File: ${nf}\n` + "+alpha\n+beta\n+gamma\n" + "*** End Patch\n";
    const add = await run(applyPatchTool({ seen }), { patch });
    expect(add.details?.error).toBeUndefined();
    expect(readFileSync(nf, "utf8")).toBe("alpha\nbeta\ngamma\n");

    const edit = await run(editTool({ seen }), { path: nf, old_string: "beta", new_string: "BETA" });
    expect(edit.details?.error).toBeUndefined();
    expect(readFileSync(nf, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("AC3c update on a never-read file is rejected unseen naming original-coordinate ranges", async () => {
    const d = tempDir();
    const g = join(d, "g.txt");
    writeFileSync(g, FIVE);
    const seen = ledger();
    const res = await run(applyPatchTool({ seen }), { patch: updateHunk(g, "l2", "l3", "L3", "l4") });
    expect(res.details?.error).toBe(true);
    expect(res.details?.edit_guard).toBe("unseen");
    expect(bodyOf(res)).toMatch(/apply_patch: unread lines/);
    expect(res.details?.reread).toEqual([`${g}:2-4`]);
    expect(readFileSync(g, "utf8")).toBe(FIVE);
  });

  test("AC3d delete forgets the path's evidence", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: f });
    expect((seen.rows(f) ?? []).length).toBeGreaterThan(0);
    const patch = "*** Begin Patch\n" + `*** Delete File: ${f}\n` + "*** End Patch\n";
    const res = await run(applyPatchTool({ seen }), { patch });
    expect(res.details?.error).toBeUndefined();
    expect(seen.rows(f)).toEqual([]);
  });

  test("AC3d move remaps evidence to the destination and clears the source", async () => {
    const d = tempDir();
    const src = join(d, "src.txt");
    const dst = join(d, "dst.txt");
    writeFileSync(src, FIVE);
    const seen = ledger();
    await run(readTool({ seen }), { path: src });
    const patch =
      "*** Begin Patch\n" +
      `*** Update File: ${src}\n` +
      `*** Move to: ${dst}\n` +
      " l1\n-l2\n+L2\n l3\n" +
      "*** End Patch\n";
    const res = await run(applyPatchTool({ seen }), { patch });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(dst, "utf8")).toBe("l1\nL2\nl3\nl4\nl5\n");
    expect(seen.rows(src)).toEqual([]);
    expect((seen.rows(dst) ?? []).length).toBeGreaterThan(0);

    const edit = await run(editTool({ seen }), { path: dst, old_string: "l4\n", new_string: "L4\n" });
    expect(edit.details?.error).toBeUndefined();
    expect(readFileSync(dst, "utf8")).toBe("l1\nL2\nl3\nL4\nl5\n");
  });
});

describe("AC4 per-agent scoping (two agent ids)", () => {
  test("AC4 a file read by agentA does not grant agentB unseen coverage", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const db = new MinimaDb(":memory:");
    dbs.push(db);
    const ledA = new SeenLedger();
    ledA.attach(db, "r1", "agentA");
    const ledB = new SeenLedger();
    ledB.attach(db, "r1", "agentB");

    await run(readTool({ seen: ledA }), { path: f });

    const bEdit = await run(editTool({ seen: ledB }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(bEdit.details?.edit_guard).toBe("unseen");
    expect(readFileSync(f, "utf8")).toBe(FIVE);

    const aEdit = await run(editTool({ seen: ledA }), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(aEdit.details?.error).toBeUndefined();

    const aRows = db.db.query("SELECT * FROM seen_lines WHERE agent_id = 'agentA'").all();
    expect(aRows.length).toBeGreaterThan(0);

    const lead = new SeenLedger();
    lead.attach(db, "r1");
    expect(lead.rows(f)).toEqual([]);
  });
});

describe("AC7 flag-off parity (no ledger passed)", () => {
  test("AC7 the AC1 stale scenario applies with the plain success text when the guard is off", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    await run(readTool(), { path: f });
    appendFileSync(f, "drift\n");
    const res = await run(applyPatchTool(), { patch: updateHunk(f, "l1", "l2", "L2", "l3") });
    expect(res.details?.error).toBeUndefined();
    expect(bodyOf(res)).toMatch(/^applied patch/);
    expect(readFileSync(f, "utf8")).toBe(`${FIVE.replace("l2\n", "L2\n")}drift\n`);
  });

  test("AC7 the AC4 scenario's unseen edit applies with no ledger", async () => {
    const d = tempDir();
    const f = join(d, "a.txt");
    writeFileSync(f, FIVE);
    const res = await run(editTool(), { path: f, old_string: "l2\n", new_string: "L2\n" });
    expect(res.details?.error).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe(FIVE.replace("l2\n", "L2\n"));
  });
});
