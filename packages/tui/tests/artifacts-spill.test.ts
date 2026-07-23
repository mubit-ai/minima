import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentTool, ToolResult } from "../src/agent/tools.ts";
import { bashTool } from "../src/tools/bash.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";

const AWK_20K = `awk 'BEGIN { for (i=0;i<20000;i++) printf "line %06d abcdefghijklmnopqrstuvwxyz\\n", i }'`;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArtifacts(dir: string) {
  const save = (full: string): { ref: string } | null => {
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(full);
      mkdirSync(dir, { recursive: true });
      const ref = join(dir, `${hasher.digest("hex")}.txt`);
      if (!existsSync(ref)) writeFileSync(ref, full, "utf8");
      return { ref };
    } catch {
      return null;
    }
  };
  return {
    dir,
    sink: (_tool: string) => (full: string) => save(full),
    beginStream: (_tool: string) => {
      let buf = "";
      return {
        write(chunk: string): void {
          buf += chunk;
        },
        async commit(): Promise<{ ref: string } | null> {
          return save(buf);
        },
        async discard(): Promise<void> {},
      };
    },
  };
}

async function run(tool: AgentTool, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

describe("bash artifact spill (AC1)", () => {
  test("AC1: ~1MB bash output keeps head+tail and lands a content-addressed ref", async () => {
    const artDir = tempDir("minima-artifacts-");
    const artifacts = makeArtifacts(artDir);
    const res = await run(bashTool({ artifacts }), { command: AWK_20K, timeout: 30_000 });
    const out = body(res);
    expect(out.length).toBeLessThanOrEqual(51_000);
    expect(out).toContain("line 000000");
    expect(out).toContain("line 019999");
    expect(out).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(out).toContain("[exit 0]");
    const m = out.match(/\[full output saved: (.+?)\]/);
    expect(m).not.toBeNull();
    const ref = m?.[1] ?? "";
    expect(ref.startsWith(artDir)).toBe(true);
    expect(ref.endsWith(".txt")).toBe(true);
    expect(res.details?.spill_ref).toBe(ref);
    const saved = readFileSync(ref, "utf8");
    expect(saved.split("\n").length - 1).toBe(20_000);
    expect(saved.startsWith("line 000000 ")).toBe(true);
    expect(saved).toContain("line 019999 ");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(saved);
    expect(basename(ref)).toBe(`${hasher.digest("hex")}.txt`);
  });

  test("bash timeout carries partial output AND the ref when >50k chars streamed", async () => {
    const artDir = tempDir("minima-artifacts-");
    const artifacts = makeArtifacts(artDir);
    const cmd = `awk 'BEGIN { for (i=0;i<3000;i++) printf "line %06d abcdefghijklmnopqrstuvwxyz\\n", i }'; sleep 30`;
    const res = await run(bashTool({ artifacts }), { command: cmd, timeout: 1_500 });
    const out = body(res);
    expect(out).toContain("bash: timed out after 1500 ms");
    expect(out).toContain("--- partial output ---");
    const m = out.match(/\[full output saved: (.+?)\]/);
    expect(m).not.toBeNull();
    const ref = m?.[1] ?? "";
    expect(res.details?.spill_ref).toBe(ref);
    expect(res.details?.error).toBe(true);
    const saved = readFileSync(ref, "utf8");
    expect(saved.length).toBeGreaterThan(50_000);
  });

  test("bash under-cap output leaves no artifact file and no ref line", async () => {
    const artDir = tempDir("minima-artifacts-");
    const artifacts = makeArtifacts(artDir);
    const res = await run(bashTool({ artifacts }), { command: "echo hi", timeout: 30_000 });
    const out = body(res);
    expect(out.endsWith("[exit 0]")).toBe(true);
    expect(out).not.toContain("full output saved");
    expect(res.details?.spill_ref).toBeUndefined();
    expect(existsSync(artDir) ? readdirSync(artDir) : []).toEqual([]);
  });
});

describe("read pages artifact refs (AC2)", () => {
  test("AC2: confined read pages an artifact ref via the artifact-root allowance", async () => {
    const artDir = tempDir("minima-artifacts-");
    const workdir = tempDir("minima-work-");
    const artifacts = makeArtifacts(artDir);
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      lines.push(`line ${String(i).padStart(6, "0")} abcdefghijklmnopqrstuvwxyz`);
    }
    const spilled = artifacts.sink("bash")(`${lines.join("\n")}\n`);
    expect(spilled).not.toBeNull();
    const ref = spilled?.ref ?? "";
    const res = await run(readTool({ workdir, artifacts }), { path: ref, offset: 9000, limit: 5 });
    const out = body(res);
    expect(out).not.toContain("path escapes workdir");
    expect(out.split("\n").slice(0, 5)).toEqual([
      "9000: line 008999 abcdefghijklmnopqrstuvwxyz",
      "9001: line 009000 abcdefghijklmnopqrstuvwxyz",
      "9002: line 009001 abcdefghijklmnopqrstuvwxyz",
      "9003: line 009002 abcdefghijklmnopqrstuvwxyz",
      "9004: line 009003 abcdefghijklmnopqrstuvwxyz",
    ]);
    expect(res.details?.lines_read).toBe(5);
  });

  test("the allowance opens toward exactly one root: other outside paths still escape", async () => {
    const artDir = tempDir("minima-artifacts-");
    const workdir = tempDir("minima-work-");
    const outside = join(tempDir("minima-outside-"), "x.txt");
    writeFileSync(outside, "nope\n");
    const artifacts = makeArtifacts(artDir);
    const res = await run(readTool({ workdir, artifacts }), { path: outside });
    expect(body(res)).toContain("path escapes workdir");
  });
});

describe("grep/glob/ls artifact spill (AC3)", () => {
  test("AC3: grep truncation notice carries the ref; ref file holds all 300 matches", async () => {
    const artDir = tempDir("minima-artifacts-");
    const work = tempDir("minima-grep-");
    const artifacts = makeArtifacts(artDir);
    const lines = Array.from({ length: 300 }, (_, i) => `needle ${String(i).padStart(3, "0")}`);
    writeFileSync(join(work, "hay.txt"), `${lines.join("\n")}\n`);
    const res = await run(grepTool({ workdir: work, artifacts }), {
      pattern: "needle",
      path: ".",
    });
    const out = body(res);
    const m = out.match(
      /\[output truncated: showing first 200 of 300 matches\]; full output saved: (.+)$/m,
    );
    expect(m).not.toBeNull();
    const ref = m?.[1] ?? "";
    expect(ref.startsWith(artDir)).toBe(true);
    expect(res.details?.spill_ref).toBe(ref);
    const saved = readFileSync(ref, "utf8");
    for (const line of lines) expect(saved).toContain(line);
  });

  test("AC3: glob truncation notice carries the ref; ref file holds all 250 paths", async () => {
    const artDir = tempDir("minima-artifacts-");
    const work = tempDir("minima-glob-");
    const artifacts = makeArtifacts(artDir);
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(work, `f${String(i).padStart(3, "0")}.txt`), "x");
    }
    const res = await run(globTool({ workdir: work, artifacts }), { pattern: "*.txt", path: "." });
    const out = body(res);
    const m = out.match(
      /\[output truncated: showing first 200 of 250 matches\]; full output saved: (.+)$/m,
    );
    expect(m).not.toBeNull();
    const ref = m?.[1] ?? "";
    expect(ref.startsWith(artDir)).toBe(true);
    expect(res.details?.spill_ref).toBe(ref);
    const saved = readFileSync(ref, "utf8").trim();
    expect(saved.split("\n").length).toBe(250);
  });

  test("AC3: ls truncation notice carries the ref; ref file holds all 600 entries", async () => {
    const artDir = tempDir("minima-artifacts-");
    const work = tempDir("minima-ls-");
    const artifacts = makeArtifacts(artDir);
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(work, `e${String(i).padStart(3, "0")}`), "");
    }
    const res = await run(lsTool({ workdir: work, artifacts }), { path: "." });
    const out = body(res);
    const m = out.match(
      /\[output truncated: showing first 500 of 600 entries\]; full output saved: (.+)$/m,
    );
    expect(m).not.toBeNull();
    const ref = m?.[1] ?? "";
    expect(ref.startsWith(artDir)).toBe(true);
    expect(res.details?.spill_ref).toBe(ref);
    const saved = readFileSync(ref, "utf8").trim();
    expect(saved.split("\n").length).toBe(600);
  });
});

describe("flag-off parity + fail-open (AC5)", () => {
  test("AC5: tools built WITHOUT artifacts keep today's notices and write zero files", async () => {
    const artDir = tempDir("minima-artifacts-");
    const work = tempDir("minima-parity-");
    const lines = Array.from({ length: 300 }, (_, i) => `needle ${i}`);
    writeFileSync(join(work, "hay.txt"), `${lines.join("\n")}\n`);
    const g = await run(grepTool({ workdir: work }), { pattern: "needle", path: "." });
    const gOut = body(g);
    expect(gOut.endsWith("[output truncated: showing first 200 of 300 matches]")).toBe(true);
    expect(gOut).not.toContain("full output saved");
    expect(g.details?.spill_ref).toBeUndefined();
    const b = await run(bashTool({}), { command: AWK_20K, timeout: 30_000 });
    const bOut = body(b);
    expect(bOut.endsWith("[exit 0]")).toBe(true);
    expect(bOut).not.toContain("full output saved");
    expect(b.details?.spill_ref).toBeUndefined();
    expect(readdirSync(artDir)).toEqual([]);
  });

  test("a declined spill leaves the notice plain and the result intact", async () => {
    const work = tempDir("minima-grep-");
    const lines = Array.from({ length: 300 }, (_, i) => `needle ${i}`);
    writeFileSync(join(work, "hay.txt"), `${lines.join("\n")}\n`);
    const artifacts = {
      dir: join(work, "no-artifacts"),
      sink: (_tool: string) => (_full: string) => null,
      beginStream: (_tool: string) => null,
    };
    const res = await run(grepTool({ workdir: work, artifacts }), {
      pattern: "needle",
      path: ".",
    });
    const out = body(res);
    expect(out.endsWith("[output truncated: showing first 200 of 300 matches]")).toBe(true);
    expect(res.details?.spill_ref).toBeUndefined();
    expect(res.details?.error).toBeUndefined();
  });

  test("a throwing bash tee never affects the command result", async () => {
    const artifacts = {
      dir: tempDir("minima-artifacts-"),
      sink: (_tool: string) => (_full: string) => null,
      beginStream: (_tool: string) => ({
        write(_chunk: string): void {
          throw new Error("disk full");
        },
        async commit(): Promise<{ ref: string } | null> {
          return null;
        },
        async discard(): Promise<void> {},
      }),
    };
    const res = await run(bashTool({ artifacts }), { command: AWK_20K, timeout: 30_000 });
    const out = body(res);
    expect(out).toContain("[exit 0]");
    expect(out).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(res.details?.error).toBeUndefined();
  });
});
