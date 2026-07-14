/**
 * Line-space windowing for the fullscreen renderer (Stage 3 of the stability plan).
 *
 * The transcript is a virtual array of pre-rendered lines (lines.ts) indexed by prefix
 * sums; the viewport is a [top, top+rows) window over it, followed by the live region
 * (streaming reply / reasoning peek) which occupies the virtual tail. windowLines emits
 * ≤ viewportRows lines BY CONSTRUCTION — the "Σ visible rows ≤ region" invariant that
 * keeps Ink from garbling is structural here, not a conservative estimate.
 *
 * Scroll semantics: `null` = pinned to the newest line (follow — new content slides the
 * window automatically, no follow-effect needed); `{topLine}` = absolute anchor into the
 * virtual line space, so appends below the window leave visible content stationary.
 */

export interface LineIndex {
  /** Per-message rendered line counts (chrome included). */
  counts: number[];
  /** prefix[i] = total lines before message i. */
  prefix: number[];
  /** Σ counts. */
  total: number;
}

export function buildLineIndex(counts: number[]): LineIndex {
  const prefix = new Array<number>(counts.length);
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    prefix[i] = total;
    total += counts[i]!;
  }
  return { counts, prefix, total };
}

/** null = pinned to the bottom (follow newest); otherwise an absolute top anchor. */
export type ScrollState = null | { topLine: number };

export function maxTop(total: number, viewportRows: number): number {
  return Math.max(0, total - Math.max(1, viewportRows));
}

/**
 * Apply a line delta (positive = down, toward newest), clamping the STORED state at
 * mutation time — over-scroll banks nothing in either direction. Reaching the bottom
 * returns null (re-pins, resuming follow-newest).
 */
export function scrollLinesBy(
  cur: ScrollState,
  delta: number,
  total: number,
  viewportRows: number,
): ScrollState {
  const mt = maxTop(total, viewportRows);
  const from = cur === null ? mt : Math.min(cur.topLine, mt);
  const next = Math.max(0, Math.min(from + delta, mt));
  return next >= mt ? null : { topLine: next };
}

export interface ViewportWindow {
  /** The visible lines, ≤ viewportRows of them, oldest first. */
  lines: string[];
  pinned: boolean;
  atTop: boolean;
  /** Clamped top of the window in virtual line space. */
  topLine: number;
  /** Virtual line count (transcript + live region). */
  total: number;
}

/**
 * The visible window at `scroll`. `getLines(i)` must return the same array the index was
 * built from (lines.ts linesFor — cached, so this is O(viewportRows + log n)); `liveLines`
 * is the streaming tail appended after the last message.
 */
export function windowLines(
  index: LineIndex,
  getLines: (msgIdx: number) => string[],
  liveLines: string[],
  scroll: ScrollState,
  viewportRows: number,
): ViewportWindow {
  const rows = Math.max(1, viewportRows);
  const total = index.total + liveLines.length;
  const mt = maxTop(total, rows);
  const top = scroll === null ? mt : Math.min(Math.max(0, scroll.topLine), mt);
  const end = Math.min(top + rows, total);
  const pinned = scroll === null;
  if (total === 0) return { lines: [], pinned, atTop: true, topLine: 0, total };

  const out: string[] = [];
  if (top < index.total) {
    // Greatest i with prefix[i] <= top (binary search), then walk forward slicing.
    let lo = 0;
    let hi = index.counts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.prefix[mid]! <= top) lo = mid;
      else hi = mid - 1;
    }
    let cursor = index.prefix[lo]!;
    for (let i = lo; i < index.counts.length && cursor < end; i++) {
      const lines = getLines(i);
      const s = Math.max(0, top - cursor);
      const e = Math.min(lines.length, end - cursor);
      for (let k = s; k < e; k++) out.push(lines[k]!);
      cursor += lines.length;
    }
  }
  const ls = Math.max(0, top - index.total);
  const le = Math.min(liveLines.length, end - index.total);
  for (let k = ls; k < le; k++) out.push(liveLines[k]!);

  return { lines: out, pinned, atTop: top === 0, topLine: top, total };
}
