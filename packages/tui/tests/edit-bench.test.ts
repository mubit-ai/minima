import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ToolResult } from "../src/agent/tools.ts";
import { grepTool } from "../src/tools/grep.ts";
import { editTool, readTool, writeTool } from "../src/tools/index.ts";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type MemRow = { start: number; end: number; tool: string };
type MemRange = { start: number; end: number };

interface LedgerLike {
  enabled: boolean;
  rows(path: string): { start_line: number; end_line: number; file_hash: string; tool: string }[] | null;
  record(path: string, fileHash: string, ranges: MemRange[], tool: string): boolean;
  applyEdit(path: string, edit: { spans: MemRange[]; lineDelta: number; newHash: string }): boolean;
}

function memLedger(): LedgerLike {
  const state = new Map<string, { hash: string; rows: MemRow[] }>();
  return {
    enabled: true,
    rows(path) {
      const e = state.get(path);
      if (!e) return [];
      return e.rows.map((r) => ({
        start_line: r.start,
        end_line: r.end,
        file_hash: e.hash,
        tool: r.tool,
      }));
    },
    record(path, fileHash, ranges, tool) {
      const e = state.get(path);
      const keep = e && e.hash === fileHash ? e.rows : [];
      const rows = [...keep, ...ranges.map((r) => ({ start: r.start, end: r.end, tool }))];
      rows.sort((a, b) => a.start - b.start || a.end - b.end);
      state.set(path, { hash: fileHash, rows });
      return true;
    },
    applyEdit(path, edit) {
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

async function newLedger(runId: string): Promise<LedgerLike> {
  try {
    const seenMod = await import("../src/tools/_seen.ts");
    const dbMod = await import("../src/db/minima_db.ts");
    const dir = mkdtempSync(join(tmpdir(), "minima-bench-db-"));
    const db = new dbMod.MinimaDb(join(dir, "bench.db"));
    cleanups.push(() => {
      try {
        db.db.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    });
    const led = new seenMod.SeenLedger();
    led.attach(db, runId);
    return led as unknown as LedgerLike;
  } catch {
    return memLedger();
  }
}

async function call(tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("bench", parsed.value, null, null);
}

function bodyOf(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

function isRejected(res: ToolResult): boolean {
  return res.details?.error === true;
}

type Step =
  | { call: "read" | "grep" | "edit" | "write"; args: (dir: string) => Record<string, unknown> }
  | { external: (dir: string) => void };

interface Scenario {
  name: string;
  arm: "legit" | "stale";
  setup: (dir: string) => void;
  steps: Step[];
  final: (dir: string) => { file: string; content: string };
}

const BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
const SIXTY = Array.from({ length: 60 }, (_, i) => `n${i + 1}`).join("\n") + "\n";

const scenarios: Scenario[] = [
  {
    name: "L1-read-full-edit",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l5\n", new_string: "L5\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "a.txt"), content: BASE.replace("l5\n", "L5\n") }),
  },
  {
    name: "L2-window-read-edit-inside",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt"), offset: 3, limit: 4 }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l4\n", new_string: "L4\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "a.txt"), content: BASE.replace("l4\n", "L4\n") }),
  },
  {
    name: "L3-grep-edit-matched-line",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "g.txt"), "alpha\nneedle here\nomega\n"),
    steps: [
      { call: "grep", args: (d) => ({ pattern: "needle", path: d }) },
      {
        call: "edit",
        args: (d) => ({
          path: join(d, "g.txt"),
          old_string: "needle here",
          new_string: "needle HERE",
        }),
      },
    ],
    final: (d) => ({ file: join(d, "g.txt"), content: "alpha\nneedle HERE\nomega\n" }),
  },
  {
    name: "L4-write-edit",
    arm: "legit",
    setup: () => {},
    steps: [
      { call: "write", args: (d) => ({ path: join(d, "w.txt"), content: "alpha\nbeta\n" }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "w.txt"), old_string: "beta", new_string: "BETA" }),
      },
    ],
    final: (d) => ({ file: join(d, "w.txt"), content: "alpha\nBETA\n" }),
  },
  {
    name: "L5-edit-then-edit-below-shift",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "e.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "e.txt") }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "e.txt"), old_string: "l3\n", new_string: "x1\nx2\nx3\n" }),
      },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "e.txt"), old_string: "l8\n", new_string: "L8\n" }),
      },
    ],
    final: (d) => ({
      file: join(d, "e.txt"),
      content: BASE.replace("l3\n", "x1\nx2\nx3\n").replace("l8\n", "L8\n"),
    }),
  },
  {
    name: "L6-identical-external-rewrite",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      { external: (d) => writeFileSync(join(d, "a.txt"), BASE) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l5\n", new_string: "L5\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "a.txt"), content: BASE.replace("l5\n", "L5\n") }),
  },
  {
    name: "L7-replace-all-within-window",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "r.txt"), "tok a\nmid\ntok b\n"),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "r.txt") }) },
      {
        call: "edit",
        args: (d) => ({
          path: join(d, "r.txt"),
          old_string: "tok",
          new_string: "TOK",
          replace_all: true,
        }),
      },
    ],
    final: (d) => ({ file: join(d, "r.txt"), content: "TOK a\nmid\nTOK b\n" }),
  },
  {
    name: "L8-multi-file-grep-edit-second",
    arm: "legit",
    setup: (d) => {
      writeFileSync(join(d, "m1.txt"), "alpha\nmark one\n");
      writeFileSync(join(d, "m2.txt"), "alpha\nmark two\n");
      writeFileSync(join(d, "m3.txt"), "alpha\nmark three\n");
    },
    steps: [
      { call: "grep", args: (d) => ({ pattern: "mark", path: d }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "m2.txt"), old_string: "mark two", new_string: "mark TWO" }),
      },
    ],
    final: (d) => ({ file: join(d, "m2.txt"), content: "alpha\nmark TWO\n" }),
  },
  {
    name: "L9-multi-line-old-string",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "b.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "b.txt") }) },
      {
        call: "edit",
        args: (d) => ({
          path: join(d, "b.txt"),
          old_string: "l4\nl5\nl6\n",
          new_string: "L456\n",
        }),
      },
    ],
    final: (d) => ({ file: join(d, "b.txt"), content: BASE.replace("l4\nl5\nl6\n", "L456\n") }),
  },
  {
    name: "L10-read-edit-read-edit",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l2\n", new_string: "L2\n" }),
      },
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l9\n", new_string: "L9\n" }),
      },
    ],
    final: (d) => ({
      file: join(d, "a.txt"),
      content: BASE.replace("l2\n", "L2\n").replace("l9\n", "L9\n"),
    }),
  },
  {
    name: "L11-crlf",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "c.txt"), "a\r\nb\r\nc\r\n"),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "c.txt") }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "c.txt"), old_string: "b\r\n", new_string: "B\r\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "c.txt"), content: "a\r\nB\r\nc\r\n" }),
  },
  {
    name: "L12-whole-small-file",
    arm: "legit",
    setup: (d) => writeFileSync(join(d, "s.txt"), "only line\n"),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "s.txt") }) },
      {
        call: "edit",
        args: (d) => ({
          path: join(d, "s.txt"),
          old_string: "only line\n",
          new_string: "the whole new\n",
        }),
      },
    ],
    final: (d) => ({ file: join(d, "s.txt"), content: "the whole new\n" }),
  },
  {
    name: "S1-read-append-edit",
    arm: "stale",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      { external: (d) => appendFileSync(join(d, "a.txt"), "drift\n") },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l5\n", new_string: "L5\n" }),
      },
    ],
    final: (d) => ({
      file: join(d, "a.txt"),
      content: `${BASE.replace("l5\n", "L5\n")}drift\n`,
    }),
  },
  {
    name: "S2-never-read-edit",
    arm: "stale",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l5\n", new_string: "L5\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "a.txt"), content: BASE.replace("l5\n", "L5\n") }),
  },
  {
    name: "S3-read-modify-edit",
    arm: "stale",
    setup: (d) => writeFileSync(join(d, "a.txt"), BASE),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "a.txt") }) },
      { external: (d) => writeFileSync(join(d, "a.txt"), BASE.replace("l7\n", "zz\n")) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "a.txt"), old_string: "l5\n", new_string: "L5\n" }),
      },
    ],
    final: (d) => ({
      file: join(d, "a.txt"),
      content: BASE.replace("l7\n", "zz\n").replace("l5\n", "L5\n"),
    }),
  },
  {
    name: "S4-window-read-edit-outside",
    arm: "stale",
    setup: (d) => writeFileSync(join(d, "big.txt"), SIXTY),
    steps: [
      { call: "read", args: (d) => ({ path: join(d, "big.txt"), offset: 1, limit: 10 }) },
      {
        call: "edit",
        args: (d) => ({ path: join(d, "big.txt"), old_string: "n50\n", new_string: "N50\n" }),
      },
    ],
    final: (d) => ({ file: join(d, "big.txt"), content: SIXTY.replace("n50\n", "N50\n") }),
  },
];

interface RunOutcome {
  results: ToolResult[];
  finalResult: ToolResult;
  preFinal: string;
  dir: string;
}

async function runScenario(sc: Scenario, guardOn: boolean): Promise<RunOutcome> {
  const dir = tempDir("minima-bench-");
  sc.setup(dir);
  const seen = guardOn ? await newLedger(`bench-${sc.name}`) : undefined;
  const opts = seen ? { seen: seen as never } : {};
  const tools: Record<string, AgentTool> = {
    read: readTool(opts),
    grep: grepTool(opts),
    edit: editTool(opts),
    write: writeTool(opts),
  };
  const toolSteps = sc.steps.filter((s) => "call" in s);
  const lastTool = toolSteps[toolSteps.length - 1];
  const results: ToolResult[] = [];
  let preFinal = "";
  for (const step of sc.steps) {
    if ("external" in step) {
      step.external(dir);
      continue;
    }
    if (step === lastTool) preFinal = readFileSync(sc.final(dir).file, "utf8");
    const tool = tools[step.call] as AgentTool;
    results.push(await call(tool, step.args(dir)));
  }
  return { results, finalResult: results[results.length - 1] as ToolResult, preFinal, dir };
}

describe("AC7 benchmark", () => {
  test("legitimate scenarios: 12/12 succeed with the guard ON and 12/12 OFF", async () => {
    const legit = scenarios.filter((s) => s.arm === "legit");
    expect(legit.length).toBe(12);
    const counts = { on: 0, off: 0 };
    for (const sc of legit) {
      for (const mode of ["on", "off"] as const) {
        const out = await runScenario(sc, mode === "on");
        const allOk = out.results.every((r) => !isRejected(r));
        const expected = sc.final(out.dir);
        const contentOk = readFileSync(expected.file, "utf8") === expected.content;
        if (allOk && contentOk) counts[mode] += 1;
        else console.log(`edit-bench FAIL ${sc.name} guard=${mode} allOk=${allOk} contentOk=${contentOk}`);
      }
    }
    console.log(`edit-bench legit: ON ${counts.on}/12, OFF ${counts.off}/12`);
    expect(counts.on).toBe(12);
    expect(counts.off).toBe(12);
  });

  test("stale scenarios: 4/4 rejected with the guard ON, 4/4 silently apply OFF", async () => {
    const stale = scenarios.filter((s) => s.arm === "stale");
    expect(stale.length).toBe(4);
    let rejectedOn = 0;
    let appliedOff = 0;
    for (const sc of stale) {
      const on = await runScenario(sc, true);
      if (
        isRejected(on.finalResult) &&
        /re-read these ranges:/.test(bodyOf(on.finalResult)) &&
        readFileSync(sc.final(on.dir).file, "utf8") === on.preFinal
      ) {
        rejectedOn += 1;
      } else {
        console.log(`edit-bench STALE-ON not rejected: ${sc.name}`);
      }
      const off = await runScenario(sc, false);
      const expected = sc.final(off.dir);
      if (!isRejected(off.finalResult) && readFileSync(expected.file, "utf8") === expected.content) {
        appliedOff += 1;
      } else {
        console.log(`edit-bench STALE-OFF did not apply: ${sc.name}`);
      }
    }
    console.log(`edit-bench stale: rejected ON ${rejectedOn}/4, applied OFF ${appliedOff}/4`);
    expect(rejectedOn).toBe(4);
    expect(appliedOff).toBe(4);
  });

  test("recovery (R1): reject -> re-read named ranges -> retry lands the exact content", async () => {
    const dir = tempDir("minima-bench-r1-");
    const f = join(dir, "a.txt");
    writeFileSync(f, BASE);
    const seen = await newLedger("bench-R1-on");
    const read = readTool({ seen: seen as never });
    const edit = editTool({ seen: seen as never });
    await call(read, { path: f });
    appendFileSync(f, "drift\n");
    const rejected = await call(edit, { path: f, old_string: "l5\n", new_string: "L5\n" });
    expect(isRejected(rejected)).toBe(true);
    expect(bodyOf(rejected)).toMatch(/re-read these ranges:/);
    const reread = rejected.details?.reread as string[];
    expect(Array.isArray(reread)).toBe(true);
    for (const rr of reread) {
      const m = /^(.*):(\d+)-(\d+)$/.exec(rr);
      expect(m).toBeTruthy();
      const [, path, s, e] = m as unknown as [string, string, string, string];
      const back = await call(read, {
        path,
        offset: Number(s),
        limit: Number(e) - Number(s) + 1,
      });
      expect(isRejected(back)).toBe(false);
    }
    const retried = await call(edit, { path: f, old_string: "l5\n", new_string: "L5\n" });
    expect(isRejected(retried)).toBe(false);
    const expected = `${BASE.replace("l5\n", "L5\n")}drift\n`;
    expect(readFileSync(f, "utf8")).toBe(expected);

    const dirOff = tempDir("minima-bench-r1-off-");
    const fOff = join(dirOff, "a.txt");
    writeFileSync(fOff, BASE);
    const editOff = editTool();
    const readOff = readTool();
    await call(readOff, { path: fOff });
    appendFileSync(fOff, "drift\n");
    const applied = await call(editOff, { path: fOff, old_string: "l5\n", new_string: "L5\n" });
    expect(isRejected(applied)).toBe(false);
    expect(readFileSync(fOff, "utf8")).toBe(expected);
    console.log("edit-bench recovery: ON reject->re-read->retry ok, OFF parity ok");
  });
});
