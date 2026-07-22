import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../src/tools/index.ts";

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function newTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-read-"));
  return tmp;
}

async function run(args: Record<string, unknown>) {
  const tool = readTool();
  const parsed = tool.parameters.validate(args);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return tool.execute("t1", parsed.value, null, null);
}

function bodyOf(res: { content: { text?: string }[] }): string {
  return (res.content[0] as { text: string }).text;
}

describe("read tool hardening", () => {
  test("R1: file with NUL bytes is rejected by the binary guard", async () => {
    const d = newTmp();
    const p = join(d, "blob.bin");
    writeFileSync(p, Buffer.from([0x68, 0x69, 0x00, 0xff, 0x00, 0x01]));
    const res = await run({ path: p });
    const body = bodyOf(res);
    expect(body).toMatch(/read: binary file \(6 bytes\)/);
    expect(body).toContain(p);
    expect(body).toMatch(/use bash to inspect binary content/);
  });

  test("R2: image extension is rejected even when the file is empty", async () => {
    const d = newTmp();
    const p = join(d, "x.png");
    writeFileSync(p, "");
    const res = await run({ path: p });
    expect(bodyOf(res)).toMatch(/image file not supported/);
  });

  test("R3: huge single line is bounded by truncateLine", async () => {
    const d = newTmp();
    const p = join(d, "one-line.txt");
    writeFileSync(p, "x".repeat(100_000));
    const res = await run({ path: p });
    expect(bodyOf(res)).toBe(`1: ${"x".repeat(2000)} …(truncated)`);
    expect(res.details?.lines_read).toBe(1);
  });

  test("R4: deep offset window is byte-exact with the more-lines trailer", async () => {
    const d = newTmp();
    const p = join(d, "many-lines.txt");
    const lines = Array.from({ length: 10_000 }, (_, i) => `line-${i + 1}`);
    writeFileSync(p, `${lines.join("\n")}\n`);
    const res = await run({ path: p, offset: 9000, limit: 5 });
    expect(bodyOf(res)).toBe(
      [
        "9000: line-9000",
        "9001: line-9001",
        "9002: line-9002",
        "9003: line-9003",
        "9004: line-9004",
        "…(996 more lines; use a larger offset to continue)",
      ].join("\n"),
    );
    expect(res.details?.lines_read).toBe(5);
  });

  test("R5: total output is capped at 200000 chars with a cap notice", async () => {
    const d = newTmp();
    const p = join(d, "wide.txt");
    const content = Array.from({ length: 2000 }, () => "a".repeat(300)).join("\n");
    writeFileSync(p, `${content}\n`);
    const res = await run({ path: p });
    const body = bodyOf(res);
    expect(body.endsWith("…(output capped at 200000 chars; use offset/limit)")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(200_100);
  });
});
