/**
 * String-line renderers for the fullscreen line viewport (see viewport.ts).
 *
 * Each message renders to an array of SELF-CONTAINED ANSI lines — SGR opened and reset within
 * every line — pre-wrapped to fit `cols` display columns, mirroring MessageRow in messages.tsx
 * (same role chrome, colors, inline **bold** / `code` markdown). The viewport then windows the
 * transcript BY LINE: sections can be partially visible, and the Σ(visible rows) ≤ region
 * invariant holds by construction because the caller renders each line as a single-row
 * <Text wrap="truncate"> — a string with no newline can never occupy two rows.
 *
 * Blank separator rows are emitted as "" — the caller must render them as " " (a single space):
 * an empty Ink <Text> measures height 0 and would silently collapse the row.
 *
 * Wrapping walks code points with per-cp display widths (string-width): CJK count as 2, and a
 * ZWJ emoji sequence may over-count — which only breaks a line EARLIER, never past `cols`.
 */

import stringWidth from "string-width";
import { type ChatMessage, clampToolText } from "./layout.ts";

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/** `text` wrapped in SGR codes and reset — self-contained for single-line <Text> rendering. */
function paint(text: string, ...codes: Array<number | string>): string {
  if (text === "") return "";
  return `${ESC}[${codes.join(";")}m${text}${RESET}`;
}

// -- word wrap ------------------------------------------------------------------------------

/**
 * Greedy word-wrap over display columns; returns [start, end) code-point ranges per row.
 * Same behavior class as Ink's wrap-ansi({wordWrap:true, hard:true}) and layout.ts wrapRows:
 * pack space-separated words, break before a word that won't fit, hard-break a word wider
 * than a full row, trim whitespace at breaks. Every row's display width ≤ width.
 */
export function wrapSegments(cps: string[], width: number): Array<[number, number]> {
  const w = Math.max(1, width);
  const n = cps.length;
  if (n === 0) return [[0, 0]];
  const widths = cps.map((c) => stringWidth(c));
  const rows: Array<[number, number]> = [];
  let rowStart = 0;
  let col = 0;
  let i = 0;
  const endRow = (breakAt: number, nextStart: number) => {
    let e = breakAt;
    while (e > rowStart && cps[e - 1] === " ") e--;
    rows.push([rowStart, e]);
    rowStart = nextStart;
    col = 0;
  };
  while (i < n) {
    if (cps[i] === " ") {
      let j = i;
      let sw = 0;
      while (j < n && cps[j] === " ") {
        sw += 1;
        j++;
      }
      if (col + sw <= w) {
        col += sw;
      } else {
        endRow(i, j); // spaces at the break are consumed
      }
      i = j;
      continue;
    }
    let j = i;
    let ww = 0;
    while (j < n && cps[j] !== " ") {
      ww += widths[j]!;
      j++;
    }
    if (col + ww <= w) {
      col += ww;
      i = j;
      continue;
    }
    if (col > 0) endRow(i, i);
    // The word starts a fresh row; hard-break it if it is wider than a full row.
    let k = i;
    for (;;) {
      let cw = 0;
      let m = k;
      while (m < j && cw + widths[m]! <= w) {
        cw += widths[m]!;
        m++;
      }
      if (m === k) m = k + 1; // a single cp wider than the row still advances
      if (m >= j) {
        col = cw;
        break; // remainder sits on the open row
      }
      rows.push([rowStart, m]);
      rowStart = m;
      k = m;
    }
    i = j;
  }
  if (rowStart < n || rows.length === 0) endRow(n, n);
  return rows;
}

/** A plain string wrapped to ≤ width display columns per row. */
function plainWrap(line: string, width: number): string[] {
  const cps = [...line];
  return wrapSegments(cps, width).map(([s, e]) => cps.slice(s, e).join(""));
}

/** Clip to the LAST cps that fit `width` display columns (freshest tail of a stream). */
function clipTail(text: string, width: number): string {
  const cps = [...text];
  let used = 0;
  let start = cps.length;
  while (start > 0) {
    const cw = stringWidth(cps[start - 1]!);
    if (used + cw > width) break;
    used += cw;
    start--;
  }
  return cps.slice(start).join("");
}

// -- inline markdown ------------------------------------------------------------------------

const BOLD = 1;
const CODE = 2;

/** Strip `**`/`` ` `` markers; return visible code points with a parallel style bitmask. */
function parseInline(line: string): { cps: string[]; styles: number[] } {
  const cps: string[] = [];
  const styles: number[] = [];
  let bold = false;
  let code = false;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "*" && chars[i + 1] === "*") {
      bold = !bold;
      i++;
      continue;
    }
    if (chars[i] === "`") {
      code = !code;
      continue;
    }
    cps.push(chars[i]!);
    styles.push((bold ? BOLD : 0) | (code ? CODE : 0));
  }
  return { cps, styles };
}

/** One row [start,end) of a parsed inline line as a self-contained ANSI string. */
function emitStyledRow(cps: string[], styles: number[], start: number, end: number): string {
  let out = "";
  let cur = 0;
  for (let i = start; i < end; i++) {
    const s = styles[i]!;
    if (s !== cur) {
      if (cur !== 0) out += RESET;
      const codes: number[] = [];
      if (s & BOLD) codes.push(1);
      if (s & CODE) codes.push(36); // inline `code` renders cyan (renderInlineMarkdown)
      if (codes.length > 0) out += `${ESC}[${codes.join(";")}m`;
      cur = s;
    }
    out += cps[i]!;
  }
  if (cur !== 0) out += RESET;
  return out;
}

/**
 * An assistant markdown body as styled lines, mirroring MarkdownRenderer in messages.tsx:
 * `#` heading → blank row (marginTop) + bold-cyan text; `-`/`* ` list → 2-col indent +
 * yellow bullet, continuations aligned under the body; anything else → inline markdown
 * wrapped at the full width.
 */
export function markdownToLines(text: string, cols: number): string[] {
  const w = Math.max(1, cols);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const depth = (trimmed.match(/^#+/) ?? [""])[0].length;
      out.push("");
      for (const row of plainWrap(trimmed.slice(depth).trim(), w)) out.push(paint(row, 1, 36));
      continue;
    }
    if (trimmed.startsWith("-") || trimmed.startsWith("* ")) {
      const bullet = trimmed.startsWith("-") ? "-" : "•";
      const { cps, styles } = parseInline(trimmed.slice(1).trim());
      const segs = wrapSegments(cps, Math.max(1, cols - 4));
      segs.forEach(([s, e], idx) => {
        const lead = idx === 0 ? `  ${paint(`${bullet} `, 33)}` : "    ";
        out.push(lead + emitStyledRow(cps, styles, s, e));
      });
      continue;
    }
    const { cps, styles } = parseInline(line);
    for (const [s, e] of wrapSegments(cps, w)) out.push(emitStyledRow(cps, styles, s, e));
  }
  return out;
}

// -- per-message rendering ------------------------------------------------------------------

/**
 * One message as pre-wrapped ANSI lines, chrome and all — the line-space equivalent of
 * MessageRow. Line 0 is always the blank marginTop separator.
 */
export function renderMessageToLines(msg: ChatMessage, cols: number): string[] {
  const out: string[] = [""];

  if (msg.role === "user") {
    out.push(paint("▸ you", 32));
    for (const src of msg.text.split("\n"))
      for (const row of plainWrap(src, Math.max(1, cols - 2)))
        out.push(paint(` ${row} `, 37, "48;2;42;42;53"));
    return out;
  }

  if (msg.role === "tool") {
    out.push(paint(`  ⚙ ${msg.toolName ?? "tool"}:`, msg.isError ? 31 : 33));
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    for (const src of body.split("\n"))
      for (const row of plainWrap(src, Math.max(1, cols)))
        out.push(msg.isError ? paint(row, 31) : row);
    if (hiddenLines > 0) out.push(paint(`  … +${hiddenLines} more lines`, 90));
    return out;
  }

  if (msg.role === "thinking") {
    const inner = Math.max(1, cols - 2); // between the border pipes
    const bodyW = Math.max(1, cols - 4); // paddingLeft 2 inside the border
    const row = (content: string) => {
      const pad = " ".repeat(Math.max(0, inner - 2 - stringWidth(content)));
      return `${paint("│", 90)}  ${paint(content, 90, 3)}${pad}${paint("│", 90)}`;
    };
    out.push(paint(`┌${"─".repeat(inner)}┐`, 90));
    out.push(row(`🧠 reasoning (${msg.thoughtDurationSecs?.toFixed(1) ?? "0.0"}s)`));
    for (const src of msg.text.split("\n")) for (const r of plainWrap(src, bodyW)) out.push(row(r));
    out.push(paint(`└${"─".repeat(inner)}┘`, 90));
    return out;
  }

  out.push(paint("◆ assistant", 35));
  out.push(...markdownToLines(msg.text, cols));
  return out;
}

/**
 * renderMessageToLines memoized by message identity (same soundness argument as
 * layout.ts cachedMsgHeight: the transcript is append/replace-only, entries die with
 * their transcript via the WeakMap, width is the only other input).
 */
const lineCache = new WeakMap<ChatMessage, { cols: number; lines: string[] }>();

export function linesFor(msg: ChatMessage, cols: number): string[] {
  const hit = lineCache.get(msg);
  if (hit && hit.cols === cols) return hit.lines;
  const lines = renderMessageToLines(msg, cols);
  lineCache.set(msg, { cols, lines });
  return lines;
}

// -- live region ----------------------------------------------------------------------------

const streamCache = { head: "", cols: 0, lines: [] as string[] };

/**
 * The LIVE assistant reply (header + markdown body) as viewport lines, incrementally cached:
 * only source lines after the previously-seen last "\n" are re-rendered per stream flush, so
 * each 80ms tick costs O(new text), not O(whole reply). Resets when the text is not an
 * extension of the previous flush (new turn / retry) or the width changes.
 */
export function liveReplyLines(text: string, cols: number): string[] {
  const cut = text.lastIndexOf("\n");
  const head = cut === -1 ? "" : text.slice(0, cut); // complete source lines
  const tail = cut === -1 ? text : text.slice(cut + 1); // still-streaming partial line
  if (streamCache.cols !== cols || !head.startsWith(streamCache.head)) {
    streamCache.cols = cols;
    streamCache.head = "";
    streamCache.lines = [];
  }
  if (head !== streamCache.head) {
    const fresh = streamCache.head === "" ? head : head.slice(streamCache.head.length + 1);
    streamCache.lines.push(...markdownToLines(fresh, cols));
    streamCache.head = head;
  }
  const tailLines = tail === "" ? [] : markdownToLines(tail, cols);
  return ["", paint("◆ assistant", 35), ...streamCache.lines, ...tailLines];
}

/** Reset the incremental stream cache (turn end). Exported for tests and turn boundaries. */
export function resetLiveReplyCache(): void {
  streamCache.head = "";
  streamCache.cols = 0;
  streamCache.lines = [];
}

/**
 * The live reasoning peek as a fixed FIVE lines (blank + round border + header + one
 * truncated body row + border), mirroring StreamingThoughts — constant height so the
 * viewport math never swings while thoughts stream.
 */
export function thoughtsPeekLines(text: string, cols: number): string[] {
  const inner = Math.max(1, cols - 2);
  const contentW = Math.max(1, inner - 2); // paddingX 1
  const row = (content: string, ...codes: Array<number | string>) => {
    const pad = " ".repeat(Math.max(0, contentW - stringWidth(content)));
    return `${paint("│", 36)} ${paint(content, ...codes)}${pad} ${paint("│", 36)}`;
  };
  const peek = clipTail(text.slice(-300).replace(/\n/g, " "), contentW);
  return [
    "",
    paint(`╭${"─".repeat(inner)}╮`, 36),
    row("🧠 reasoning...", 36),
    row(peek, 90),
    paint(`╰${"─".repeat(inner)}╯`, 36),
  ];
}
