/**
 * The one bounded-output helper. Every tool's truncation flows through here so the
 * model-visible notice format stays uniform and P1 can wire a SpillSink in one place.
 *
 * Cap interaction (pinned by tests/bounds.test.ts B7): maxLines and maxChars compose —
 * whole lines are emitted until adding the next would exceed either cap; a single line
 * longer than maxChars itself is hard-cut mid-line so the body lands exactly at maxChars
 * and still counts as one shown line.
 */

export interface BoundedOutput {
  body: string;
  notice: string | null;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  totalChars: number;
  spillRef?: string;
}

export interface BoundOpts {
  maxLines?: number;
  maxChars?: number;
  unit?: string;
  keep?: "head" | "headTail";
  headChars?: number;
  totalIsLowerBound?: boolean;
  spill?: SpillSink | null;
}

export type SpillSink = (full: string) => { ref: string } | null;

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_HEAD_CHARS = 10_000;
const MARKER_RESERVE = 64;

export function boundText(full: string, opts: BoundOpts = {}): BoundedOutput {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const b =
    opts.keep === "headTail"
      ? boundHeadTail(full, maxChars, opts.headChars ?? DEFAULT_HEAD_CHARS)
      : boundHead(
          full,
          opts.maxLines ?? Number.POSITIVE_INFINITY,
          maxChars,
          opts.unit ?? "lines",
          opts.totalIsLowerBound === true,
        );
  if (b.truncated && opts.spill) {
    const spilled = opts.spill(full);
    if (spilled) {
      b.spillRef = spilled.ref;
      b.notice =
        b.notice === null
          ? `[full output saved: ${spilled.ref}]`
          : `${b.notice}; full output saved: ${spilled.ref}`;
    }
  }
  return b;
}

export function boundDetails(b: BoundedOutput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    truncated: b.truncated,
    total_lines: b.totalLines,
    shown_lines: b.shownLines,
  };
  if (b.spillRef !== undefined) out.spill_ref = b.spillRef;
  return out;
}

function countLines(textLen: number, s: string): number {
  if (textLen === 0) return 0;
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n += 1;
  return n;
}

function boundHead(
  full: string,
  maxLines: number,
  maxChars: number,
  unit: string,
  totalIsLowerBound: boolean,
): BoundedOutput {
  const totalChars = full.length;
  const lines = full.split("\n");
  const totalLines = totalChars === 0 ? 0 : lines.length;
  if (totalLines <= maxLines && totalChars <= maxChars) {
    return {
      body: full,
      notice: null,
      truncated: false,
      totalLines,
      shownLines: totalLines,
      totalChars,
    };
  }
  const kept: string[] = [];
  let used = 0;
  let shown = 0;
  for (const line of lines) {
    if (shown >= maxLines) break;
    const sep = kept.length ? 1 : 0;
    if (used + sep + line.length > maxChars) {
      if (line.length > maxChars) {
        const room = maxChars - used - sep;
        if (room > 0) {
          kept.push(line.slice(0, room));
          shown += 1;
        }
      }
      break;
    }
    kept.push(line);
    used += sep + line.length;
    shown += 1;
  }
  const plus = totalIsLowerBound ? "+" : "";
  return {
    body: kept.join("\n"),
    notice: `[output truncated: showing first ${shown} of ${totalLines}${plus} ${unit}]`,
    truncated: true,
    totalLines,
    shownLines: shown,
    totalChars,
  };
}

function cutHead(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const slice = s.slice(0, budget);
  const nl = slice.lastIndexOf("\n");
  return nl > 0 ? slice.slice(0, nl) : slice;
}

function cutTail(s: string, budget: number): string {
  if (budget <= 0) return "";
  if (s.length <= budget) return s;
  const slice = s.slice(s.length - budget);
  const nl = slice.indexOf("\n");
  return nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
}

function omissionMarker(elided: number): string {
  return `[... ${elided} chars omitted ...]`;
}

function boundHeadTail(full: string, maxChars: number, headChars: number): BoundedOutput {
  const totalChars = full.length;
  const totalLines = countLines(totalChars, full);
  if (totalChars <= maxChars) {
    return {
      body: full,
      notice: null,
      truncated: false,
      totalLines,
      shownLines: totalLines,
      totalChars,
    };
  }
  const head = cutHead(full, headChars);
  const tail = cutTail(full, Math.max(0, maxChars - headChars - MARKER_RESERVE));
  const elided = totalChars - head.length - tail.length;
  const body = `${head}\n${omissionMarker(elided)}\n${tail}`;
  return {
    body,
    notice: null,
    truncated: true,
    totalLines,
    shownLines: countLines(body.length, body),
    totalChars,
  };
}

export class BoundedBuffer {
  private readonly maxChars: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private head = "";
  private tail = "";
  private total = 0;
  private newlines = 0;

  constructor(opts: { maxChars?: number; headChars?: number } = {}) {
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.headChars = opts.headChars ?? DEFAULT_HEAD_CHARS;
    this.tailChars = Math.max(0, this.maxChars - this.headChars - MARKER_RESERVE);
  }

  push(chunk: string): void {
    this.total += chunk.length;
    for (let i = chunk.indexOf("\n"); i !== -1; i = chunk.indexOf("\n", i + 1)) this.newlines += 1;
    let rest = chunk;
    if (this.head.length < this.headChars) {
      const take = Math.min(this.headChars - this.head.length, rest.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest) {
      this.tail += rest;
      if (this.tail.length > this.tailChars * 2) {
        this.tail = this.tail.slice(this.tail.length - this.tailChars);
      }
    }
  }

  snapshot(): string {
    if (this.total <= this.maxChars) return this.head + this.tail;
    const tail =
      this.tail.length > this.tailChars
        ? this.tail.slice(this.tail.length - this.tailChars)
        : this.tail;
    const elided = this.total - this.head.length - tail.length;
    return `${this.head}\n${omissionMarker(elided)}\n${tail}`;
  }

  finish(): BoundedOutput {
    const body = this.snapshot();
    return {
      body,
      notice: null,
      truncated: this.total > this.maxChars,
      totalLines: this.total === 0 ? 0 : this.newlines + 1,
      shownLines: countLines(body.length, body),
      totalChars: this.total,
    };
  }
}
