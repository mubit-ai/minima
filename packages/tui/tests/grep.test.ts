import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../src/agent/tools.ts";
import { grepTool } from "../src/tools/grep.ts";

const RG = Bun.which("rg");
const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-grep-"));
  return tmp;
}

async function run(tool: ReturnType<typeof grepTool>, args: Record<string, unknown>) {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

describe("grep args builders", () => {
  test("G2: buildRgArgs has -n and --sort path, never -N; buildGrepArgs has excludes", async () => {
    const mod = (await import("../src/tools/grep.ts")) as unknown as Record<string, unknown>;
    const buildRgArgs = mod.buildRgArgs as ((p: unknown) => string[]) | undefined;
    const buildGrepArgs = mod.buildGrepArgs as ((p: unknown) => string[]) | undefined;
    expect(typeof buildRgArgs).toBe("function");
    expect(typeof buildGrepArgs).toBe("function");
    const rgArgs = buildRgArgs?.({ pattern: "foo", path: ".", caseInsensitive: false }) ?? [];
    expect(rgArgs).toContain("-n");
    expect(rgArgs).not.toContain("-N");
    expect(rgArgs[0]).toBe("--no-config");
    const si = rgArgs.indexOf("--sort");
    expect(si).toBeGreaterThan(-1);
    expect(rgArgs[si + 1]).toBe("path");
    const gArgs = buildGrepArgs?.({ pattern: "foo", path: ".", caseInsensitive: true }) ?? [];
    expect(gArgs).toContain("-rnsI");
    expect(gArgs).toContain("--exclude-dir=.git");
    expect(gArgs).toContain("--exclude-dir=node_modules");
    expect(gArgs).toContain("-i");
  });
});

describe("grep rg path", () => {
  test.if(RG !== null)("G1: emits file:line:content matches", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "one\ntwo\nalpha\n");
    const res = await run(grepTool(), { pattern: "alpha", path: d });
    expect(body(res)).toMatch(/f\.txt:3:alpha/);
  });

  test.if(RG !== null)("G7a: bad regex returns a clean error", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    const res = await run(grepTool(), { pattern: "[", path: d });
    expect(body(res)).toMatch(/grep error/);
    expect(res.details?.error).toBe(true);
  });

  test.if(RG !== null && notRoot)("G8a: partial results survive exit 2", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    mkdirSync(join(d, "blocked"));
    writeFileSync(join(d, "blocked", "s.txt"), "alpha\n");
    chmodSync(join(d, "blocked"), 0o000);
    try {
      const res = await run(grepTool(), { pattern: "alpha", path: d });
      const b = body(res);
      expect(b).toMatch(/f\.txt:1:alpha/);
      expect(b).toContain("[note: some paths could not be searched]");
    } finally {
      chmodSync(join(d, "blocked"), 0o700);
    }
  });

  test.if(RG !== null)("G9a: case_insensitive finds mixed-case pattern", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    const res = await run(grepTool(), { pattern: "AlPhA", path: d, case_insensitive: true });
    expect(body(res)).toMatch(/alpha/);
  });

  test.if(RG !== null)("G10: --sort path makes multi-file order deterministic", async () => {
    const d = newTmp();
    writeFileSync(join(d, "b.txt"), "needle\n");
    writeFileSync(join(d, "a.txt"), "needle\n");
    const res = await run(grepTool(), { pattern: "needle", path: d });
    const b = body(res);
    expect(b.indexOf("a.txt")).toBeGreaterThan(-1);
    expect(b.indexOf("a.txt")).toBeLessThan(b.indexOf("b.txt"));
  });
});

describe("grep fallback path", () => {
  test("G3: emits line numbers", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "one\ntwo\nalpha\n");
    const res = await run(grepTool({ rgCmd: null }), { pattern: "alpha", path: d });
    expect(body(res)).toMatch(/f\.txt:3:alpha/);
  });

  test("G4: excludes node_modules and .git", async () => {
    const d = newTmp();
    mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, "node_modules", "pkg", "x.txt"), "needle\n");
    writeFileSync(join(d, ".git", "config"), "needle\n");
    const res = await run(grepTool({ rgCmd: null }), { pattern: "needle", path: d });
    expect(body(res)).toBe("(no matches)");
  });

  test("G7b: bad regex returns a clean error", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    const res = await run(grepTool({ rgCmd: null }), { pattern: "[", path: d });
    expect(body(res)).toMatch(/grep error/);
    expect(res.details?.error).toBe(true);
  });

  test.if(notRoot)("G8b: partial results survive exit 2", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    mkdirSync(join(d, "blocked"));
    writeFileSync(join(d, "blocked", "s.txt"), "alpha\n");
    chmodSync(join(d, "blocked"), 0o000);
    try {
      const res = await run(grepTool({ rgCmd: null }), { pattern: "alpha", path: d });
      const b = body(res);
      expect(b).toMatch(/f\.txt:1:alpha/);
      expect(b).toContain("[note: some paths could not be searched]");
    } finally {
      chmodSync(join(d, "blocked"), 0o700);
    }
  });

  test("G9b: case_insensitive finds mixed-case pattern", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), "alpha\n");
    const res = await run(grepTool({ rgCmd: null }), {
      pattern: "AlPhA",
      path: d,
      case_insensitive: true,
    });
    expect(body(res)).toMatch(/alpha/);
  });
});

describe("grep bounding", () => {
  test("G5: 200-match cap with standardized notice; count is the total", async () => {
    const d = newTmp();
    const lines = Array.from({ length: 300 }, (_, i) => `m${i} match`);
    writeFileSync(join(d, "f.txt"), `${lines.join("\n")}\n`);
    const res = await run(grepTool({ rgCmd: null }), { pattern: "match", path: d });
    const b = body(res);
    expect(b).toContain(":200:");
    expect(b).not.toContain(":201:");
    expect(b).toContain("[output truncated: showing first 200 of 300 matches]");
    expect(res.details?.count).toBe(300);
    expect(res.details?.truncated).toBe(true);
    expect(res.details?.shown_lines).toBe(200);
    expect(res.details?.total_lines).toBe(300);
  });

  test("G6: long match lines are truncated per-line", async () => {
    const d = newTmp();
    writeFileSync(join(d, "f.txt"), `needle${"x".repeat(10_000)}\n`);
    const res = await run(grepTool({ rgCmd: null }), { pattern: "needle", path: d });
    const b = body(res);
    expect(b).toContain("…(truncated)");
    expect(b.length).toBeLessThan(2500);
  });
});

// Review fixes: the rg-path branches are deterministic on any machine via a fake rg
// script forced through the rgCmd seam — no test.if(RG) gate needed.
describe("grep exit-2 stderr bounding (fake rg)", () => {
  test("G11: a huge stderr on exit 2 reaches the model bounded, not verbatim", async () => {
    const d = newTmp();
    const fake = join(d, "fake-rg.sh");
    writeFileSync(
      fake,
      `#!/bin/sh\ni=0\nwhile [ $i -lt 5000 ]; do echo "rg: fixture/$i: Permission denied" >&2; i=$((i+1)); done\nexit 2\n`,
      { mode: 0o755 },
    );
    const res = await run(grepTool({ rgCmd: fake }), { pattern: "x", path: d });
    expect(res.details?.error).toBeDefined();
    const b = body(res);
    expect(b.length).toBeLessThan(4_000);
    expect(b).toContain("[output truncated");
  });
});
