import { describe, expect, test } from "bun:test";
import { BoundedBuffer, boundDetails, boundText } from "../src/tools/_bounds.ts";

describe("boundText head mode", () => {
  test("B1: caps by lines with standardized notice", () => {
    const input = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
    const b = boundText(input, { maxLines: 200 });
    const lines = b.body.split("\n");
    expect(lines.length).toBe(200);
    expect(lines[0]).toBe("line0");
    expect(lines[199]).toBe("line199");
    expect(b.notice).toBe("[output truncated: showing first 200 of 500 lines]");
    expect(b.truncated).toBe(true);
    expect(b.totalLines).toBe(500);
    expect(b.shownLines).toBe(200);
    expect(b.totalChars).toBe(input.length);
    expect(boundDetails(b)).toEqual({ truncated: true, total_lines: 500, shown_lines: 200 });
  });

  test("B2: char cap ends on a whole line", () => {
    const input = Array.from({ length: 10 }, () => "x".repeat(10_000)).join("\n");
    const b = boundText(input, { maxChars: 50_000 });
    expect(b.body.length).toBeLessThanOrEqual(50_000);
    for (const line of b.body.split("\n")) expect(line.length).toBe(10_000);
    expect(b.shownLines).toBe(4);
    expect(b.truncated).toBe(true);
    expect(b.notice).toBe("[output truncated: showing first 4 of 10 lines]");
  });

  test("B4: under-cap input untouched", () => {
    const input = "hello\nworld";
    const b = boundText(input);
    expect(b.body).toBe(input);
    expect(b.notice).toBeNull();
    expect(b.truncated).toBe(false);
    expect(b.totalLines).toBe(2);
    expect(b.shownLines).toBe(2);
    expect(b.totalChars).toBe(11);
  });

  test("B6: lower-bound totals get a plus suffix", () => {
    const input = Array.from({ length: 10_000 }, (_, i) => `m${i}`).join("\n");
    const b = boundText(input, { maxLines: 200, unit: "matches", totalIsLowerBound: true });
    expect(b.notice).toBe("[output truncated: showing first 200 of 10000+ matches]");
  });

  test("B7: maxLines and maxChars compose; oversized line hard-cut counts as one shown line", () => {
    const lines = Array.from({ length: 300 }, (_, i) => (i === 149 ? "X".repeat(60_000) : `line${i}`));
    const b = boundText(lines.join("\n"), { maxLines: 200, maxChars: 50_000 });
    expect(b.shownLines).toBe(150);
    expect(b.body.length).toBe(50_000);
    expect(b.body.split("\n").length).toBe(150);
    expect(b.body.endsWith("X")).toBe(true);
    expect(b.truncated).toBe(true);
    expect(b.totalLines).toBe(300);
    expect(b.notice).toBe("[output truncated: showing first 150 of 300 lines]");
  });
});

describe("boundText headTail mode", () => {
  test("B3: keeps both ends with inline omission marker, notice null", () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `L${String(i).padStart(4, "0")}-${"f".repeat(93)}`);
    rows[0] = `HEAD-SENTINEL-${"f".repeat(85)}`;
    rows[rows.length - 1] = `TAIL-SENTINEL-${"f".repeat(85)}`;
    const input = rows.join("\n");
    const b = boundText(input, { keep: "headTail" });
    expect(b.body).toContain("HEAD-SENTINEL");
    expect(b.body).toContain("TAIL-SENTINEL");
    expect(b.body).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(b.notice).toBeNull();
    expect(b.truncated).toBe(true);
    expect(b.body.length).toBeLessThanOrEqual(50_000);
    expect(b.totalChars).toBe(input.length);
  });
});

describe("BoundedBuffer", () => {
  test("B5: streams 1MB in 1k chunks, bounded snapshot, exact totals", () => {
    const full = `HEADSTART${"m".repeat(1_000_000 - 18)}TAILFINIS`;
    expect(full.length).toBe(1_000_000);
    const buf = new BoundedBuffer();
    for (let i = 0; i < full.length; i += 1_000) buf.push(full.slice(i, i + 1_000));
    const snap = buf.snapshot();
    expect(snap.length).toBeLessThanOrEqual(50_100);
    expect(snap.startsWith("HEADSTART")).toBe(true);
    expect(snap.endsWith("TAILFINIS")).toBe(true);
    expect(snap).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    const b = buf.finish();
    expect(b.totalChars).toBe(1_000_000);
    expect(b.truncated).toBe(true);
    expect(b.notice).toBeNull();
    expect(b.body.startsWith("HEADSTART")).toBe(true);
    expect(b.body.endsWith("TAILFINIS")).toBe(true);
  });

  test("B5b: under-cap buffer passes through untouched", () => {
    const buf = new BoundedBuffer();
    buf.push("alpha\n");
    buf.push("beta");
    expect(buf.snapshot()).toBe("alpha\nbeta");
    const b = buf.finish();
    expect(b.body).toBe("alpha\nbeta");
    expect(b.truncated).toBe(false);
    expect(b.totalChars).toBe(10);
  });
});

describe("spill hook (P1 seam)", () => {
  test("B8: spill fires on truncation, ref lands in notice and details", () => {
    const input = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
    let seen: string | null = null;
    const b = boundText(input, {
      maxLines: 200,
      spill: (full) => {
        seen = full;
        return { ref: "art:abc" };
      },
    });
    expect(seen).toBe(input);
    expect(b.notice).toBe(
      "[output truncated: showing first 200 of 500 lines]; full output saved: art:abc",
    );
    expect(boundDetails(b).spill_ref).toBe("art:abc");
  });

  test("B8b: spill not called under cap; null return leaves notice plain", () => {
    let calls = 0;
    const under = boundText("tiny", {
      maxLines: 200,
      spill: () => {
        calls += 1;
        return { ref: "never" };
      },
    });
    expect(calls).toBe(0);
    expect(under.notice).toBeNull();
    const declined = boundText("a\nb\nc", { maxLines: 2, spill: () => null });
    expect(declined.notice).toBe("[output truncated: showing first 2 of 3 lines]");
    expect(boundDetails(declined).spill_ref).toBeUndefined();
  });
});

describe("surrogate-safe cuts (review fix)", () => {
  test("B8: a hard cut mid-emoji never emits a lone surrogate", () => {
    const line = "\u{1F600}".repeat(30_000);
    const b = boundText(line, { maxLines: 10, maxChars: 50_001 });
    expect(b.body.isWellFormed()).toBe(true);
    expect(b.truncated).toBe(true);
  });

  test("B9: BoundedBuffer head/tail boundaries stay well-formed under emoji chunks", () => {
    const buf = new BoundedBuffer({ maxChars: 2_001, headChars: 501 });
    for (let i = 0; i < 40; i++) buf.push("\u{1F680}".repeat(50));
    expect(buf.snapshot().isWellFormed()).toBe(true);
    expect(buf.finish().body.isWellFormed()).toBe(true);
  });

  test("B10: under-cap content survives intact for any headChars config", () => {
    const buf = new BoundedBuffer({ maxChars: 1_000, headChars: 100 });
    const input = "a".repeat(900);
    buf.push(input);
    expect(buf.snapshot()).toBe(input);
    expect(buf.finish().truncated).toBe(false);
  });
});
