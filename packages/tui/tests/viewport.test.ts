import { describe, expect, test } from "bun:test";
import {
  type ScrollState,
  buildLineIndex,
  maxTop,
  scrollLinesBy,
  windowLines,
} from "../src/tui/viewport.ts";

/** Synthetic transcript: message i has counts[i] lines labeled "m<i>:<k>". */
function fixture(counts: number[]) {
  const index = buildLineIndex(counts);
  const store = counts.map((n, i) => Array.from({ length: n }, (_, k) => `m${i}:${k}`));
  return { index, getLines: (i: number) => store[i]!, store };
}

describe("buildLineIndex", () => {
  test("prefix sums", () => {
    const { index } = fixture([3, 1, 5]);
    expect(index.prefix).toEqual([0, 3, 4]);
    expect(index.total).toBe(9);
  });
});

describe("windowLines — the line-sweep invariant (successor to the scroll-sweep garble guard)", () => {
  test("never emits more than viewportRows lines at ANY topLine, and the window is exact", () => {
    const { index, getLines } = fixture([4, 7, 1, 12, 3, 9]); // total 36
    for (const rows of [1, 5, 10, 36, 50]) {
      for (let top = 0; top <= maxTop(index.total, rows); top++) {
        const v = windowLines(index, getLines, [], { topLine: top }, rows);
        expect(v.lines.length).toBeLessThanOrEqual(rows);
        expect(v.lines.length).toBe(Math.min(rows, index.total - top));
        // The window is the exact contiguous slice of the virtual line array.
        const flat = [4, 7, 1, 12, 3, 9].flatMap((n, i) =>
          Array.from({ length: n }, (_, k) => `m${i}:${k}`),
        );
        expect(v.lines).toEqual(flat.slice(top, top + rows));
      }
    }
  });

  test("partial visibility: a window can start and end mid-message", () => {
    const { index, getLines } = fixture([5, 5, 5]);
    const v = windowLines(index, getLines, [], { topLine: 3 }, 5);
    expect(v.lines).toEqual(["m0:3", "m0:4", "m1:0", "m1:1", "m1:2"]); // both folds cut mid-message
  });

  test("pinned (null) ends at the virtual total, including live lines", () => {
    const { index, getLines } = fixture([5, 5]);
    const live = ["live:0", "live:1", "live:2"];
    const v = windowLines(index, getLines, live, null, 6);
    expect(v.pinned).toBe(true);
    expect(v.lines).toEqual(["m1:2", "m1:3", "m1:4", "live:0", "live:1", "live:2"]);
  });

  test("append while scrolled leaves visible content stationary", () => {
    const a = fixture([5, 5]);
    const scroll: ScrollState = { topLine: 2 };
    const before = windowLines(a.index, a.getLines, [], scroll, 4).lines;
    const b = fixture([5, 5, 8]); // a new message arrived below
    const after = windowLines(b.index, b.getLines, [], scroll, 4).lines;
    expect(after).toEqual(before);
  });

  test("clamps a stale topLine when content shrinks (e.g. /clear)", () => {
    const big = fixture([50]);
    const v1 = windowLines(big.index, big.getLines, [], { topLine: 40 }, 5);
    expect(v1.topLine).toBe(40);
    const small = fixture([8]);
    const v2 = windowLines(small.index, small.getLines, [], { topLine: 40 }, 5);
    expect(v2.topLine).toBe(3); // maxTop(8, 5)
    expect(v2.lines.length).toBe(5);
  });

  test("content shorter than the viewport renders in full, pinned or not", () => {
    const { index, getLines } = fixture([2, 1]);
    for (const scroll of [null, { topLine: 0 }, { topLine: 99 }] as ScrollState[]) {
      const v = windowLines(index, getLines, [], scroll, 10);
      expect(v.lines).toEqual(["m0:0", "m0:1", "m1:0"]);
      expect(v.atTop).toBe(true);
    }
  });

  test("empty transcript", () => {
    const { index, getLines } = fixture([]);
    const v = windowLines(index, getLines, [], null, 10);
    expect(v.lines).toEqual([]);
    expect(v.total).toBe(0);
  });
});

describe("scrollLinesBy", () => {
  test("up from pinned anchors; down past the bottom re-pins", () => {
    const s1 = scrollLinesBy(null, -3, 100, 20); // wheel up
    expect(s1).toEqual({ topLine: 77 }); // maxTop 80, minus 3
    const s2 = scrollLinesBy(s1, 3, 100, 20); // wheel down back to the bottom
    expect(s2).toBeNull(); // re-pinned — follow resumes
  });

  test("clamps at the top (no banked dead offset)", () => {
    let s: ScrollState = null;
    for (let i = 0; i < 100; i++) s = scrollLinesBy(s, -10, 100, 20); // storm far past the top
    expect(s).toEqual({ topLine: 0 });
    const down = scrollLinesBy(s, 10, 100, 20);
    expect(down).toEqual({ topLine: 10 }); // first reverse notch responds immediately
  });

  test("no-op when content fits the viewport", () => {
    expect(scrollLinesBy(null, -5, 10, 20)).toBeNull();
  });

  test("a stale anchor beyond maxTop clamps before applying the delta", () => {
    expect(scrollLinesBy({ topLine: 500 }, -2, 100, 20)).toEqual({ topLine: 78 });
  });
});
