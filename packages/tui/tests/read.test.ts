import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenLedger } from "../src/tools/_seen.ts";
import { readTool } from "../src/tools/index.ts";
import { MAX_IMAGE_BYTES } from "../src/tools/read.ts";
import type { FsToolOptions } from "../src/tools/types.ts";

// Smallest valid PNG: 1x1, fully transparent. Written inline rather than as a fixture —
// tests/ has no binary fixture directory and R1 already synthesizes its blob this way.
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

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

async function run(args: Record<string, unknown>, opts: FsToolOptions = {}) {
  const tool = readTool(opts);
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

  test("R2: a real png returns a descriptor plus an image block when image results are on", async () => {
    const d = newTmp();
    const p = join(d, "x.png");
    const bytes = Buffer.from(PNG_1X1_B64, "base64");
    writeFileSync(p, bytes);
    const res = await run({ path: p }, { imageResults: () => true });
    expect(res.content).toHaveLength(2);
    // Text FIRST: db/sink, the transcript and compaction all read textContent only.
    expect(res.content[0]?.type).toBe("text");
    expect(bodyOf(res)).toMatch(/^\[image\] /);
    expect(bodyOf(res)).toContain(p);
    expect(bodyOf(res)).toContain("image/png");
    const img = res.content[1] as { type: string; data: string; mime_type?: string };
    expect(img.type).toBe("image");
    expect(img.mime_type).toBe("image/png");
    expect(img.data).toBe(bytes.toString("base64"));
    expect(res.details?.image).toBe(true);
    expect(res.details?.error).toBeUndefined();
  });

  test("R2b: with image results off, a real png keeps the historical refusal", async () => {
    const d = newTmp();
    const p = join(d, "x.png");
    writeFileSync(p, Buffer.from(PNG_1X1_B64, "base64"));
    const res = await run({ path: p });
    expect(res.content).toHaveLength(1);
    expect(bodyOf(res)).toBe(`read: image file not supported: ${p}`);
    expect(res.details?.error).toBe(true);
  });

  test("R2c: an empty .png is refused as invalid even with image results on", async () => {
    const d = newTmp();
    const p = join(d, "x.png");
    writeFileSync(p, "");
    const res = await run({ path: p }, { imageResults: () => true });
    expect(bodyOf(res)).toMatch(/read: not a valid image/);
    expect(res.content).toHaveLength(1);
  });

  test("R2d: a real gif is refused with a format message (Gemini takes no gif)", async () => {
    const d = newTmp();
    const p = join(d, "x.gif");
    writeFileSync(p, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]));
    const res = await run({ path: p }, { imageResults: () => true });
    expect(bodyOf(res)).toMatch(/image format not supported \(gif\)/);
  });

  test("R2e: mime comes from magic bytes, not the extension", async () => {
    const d = newTmp();
    const p = join(d, "actually-jpeg.png");
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const res = await run({ path: p }, { imageResults: () => true });
    expect(bodyOf(res)).toContain("image/jpeg");
    expect((res.content[1] as { mime_type?: string }).mime_type).toBe("image/jpeg");
  });

  test("R2f: an oversized image is refused before it is read into memory", async () => {
    const d = newTmp();
    const p = join(d, "huge.png");
    const head = Buffer.from(PNG_1X1_B64, "base64");
    writeFileSync(p, Buffer.concat([head, Buffer.alloc(MAX_IMAGE_BYTES + 1 - head.length)]));
    const res = await run({ path: p }, { imageResults: () => true });
    expect(bodyOf(res)).toMatch(/read: image too large/);
    expect(bodyOf(res)).toContain(String(MAX_IMAGE_BYTES));
  });

  test("R2g: the image path leaves the seen ledger untouched", async () => {
    const d = newTmp();
    const p = join(d, "x.png");
    writeFileSync(p, Buffer.from(PNG_1X1_B64, "base64"));
    const seen = new SeenLedger();
    const res = await run({ path: p }, { imageResults: () => true, seen });
    expect(bodyOf(res)).not.toContain("[snap:");
    expect(res.details?.snap).toBeUndefined();
    expect(res.details?.lines_read).toBeUndefined();
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
