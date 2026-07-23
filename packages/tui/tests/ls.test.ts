import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../src/agent/tools.ts";
import { lsTool } from "../src/tools/ls.ts";

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-ls-"));
  return tmp;
}

async function run(tool: ReturnType<typeof lsTool>, args: Record<string, unknown>) {
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

describe("ls hardening", () => {
  test("S1: dangling symlink lists as a plain file, never throws", async () => {
    const d = newTmp();
    writeFileSync(join(d, "a.txt"), "x");
    symlinkSync("/nowhere", join(d, "broken"));
    const res = await run(lsTool(), { path: d });
    const lines = body(res).split("\n");
    expect(lines).toContain("broken");
    expect(lines).toContain("a.txt");
  });

  test("S2: 600 entries capped at 500 with notice", async () => {
    const d = newTmp();
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(d, `f${String(i).padStart(3, "0")}.txt`), "");
    }
    const res = await run(lsTool(), { path: d });
    const out = body(res);
    expect(out).toContain("showing first 500 of 600 entries");
    expect(out.split("\n").length).toBe(501);
    expect(res.details).toMatchObject({
      count: 600,
      truncated: true,
      total_lines: 600,
      shown_lines: 500,
    });
  });

  test("S3: regular file path returns clean not-a-directory error", async () => {
    const d = newTmp();
    const f = join(d, "plain.txt");
    writeFileSync(f, "x");
    const res = await run(lsTool(), { path: f });
    expect(body(res)).toMatch(/ls: not a directory/);
  });
});
