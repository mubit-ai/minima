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
 * Wrapping delegates to layout.ts wrapLineToWidth — THE row ruler computeMsgHeight is defined
 * by — so `renderMessageToLines(msg, cols).length === computeMsgHeight(msg, cols)` holds for
 * marker-free text (tests/lines.test.ts pins it). The inline anchor ledger already forces
 * computeMsgHeight into lockstep with MessageRow, so that identity is the drift alarm chaining
 * this file to the JSX renderer. Inline bold/code markers are measured raw by the estimate but
 * stripped by the render (same conservative bias as MarkdownRenderer).
 *
 * Blank separator rows are emitted as "" — the caller must render them as " " (a single space):
 * an empty Ink <Text> measures height 0 and would silently collapse the row.
 */

import stringWidth from "string-width";
import { isGateBlockReason } from "../minima/big_plan.ts";
import {
  BANNER_TAGLINES,
  type ChatMessage,
  clampToolText,
  classifyMarkdownLines,
  getAsciiBanner,
  guardDenyLine,
  harnessNoiseLine,
  toolHiddenMarker,
  wrapLineToWidth,
} from "./layout.ts";

const ESC = String.fromCharCode(27);

/**
 * The specific SGR closer for one open code. Ink's Text transform (wrap-ansi) re-encodes
 * embedded ANSI and derives its closer from the FIRST code of a combined `ESC[a;b;…m`
 * sequence — a `37;48;2;…m` bubble row came back closed with `39m` only, leaving the
 * background OPEN, and background-color-erase then flooded whole terminal rows with the
 * bubble color (the fullscreen stripe bug, 2026-07-31). Separate single-code sequences
 * with explicit per-code closers pass through the transform verbatim, so paint() emits
 * exactly that — and never relies on `0m`, which the transform also rewrites.
 */
function closeFor(code: number | string): string {
  const s = String(code);
  if (s === "1" || s === "2") return "22";
  if (s === "3") return "23";
  if (s.startsWith("48")) return "49";
  return "39"; // every foreground code
}

/** `text` wrapped in SGR codes, each opened and closed as its OWN sequence (see closeFor). */
function paint(text: string, ...codes: Array<number | string>): string {
  if (text === "") return "";
  const open = codes.map((c) => `${ESC}[${c}m`).join("");
  const close = [...codes]
    .reverse()
    .map((c) => `${ESC}[${closeFor(c)}m`)
    .join("");
  return open + text + close;
}

/** wrapLineToWidth over every source line of `text` — the multi-line form of the shared ruler. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...wrapLineToWidth(line, width));
  return out;
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

/** One row [start,end) of a parsed inline line as a self-contained ANSI string. Same
 * single-code-per-sequence + specific-closer discipline as paint() (see closeFor). */
function emitStyledRow(cps: string[], styles: number[], start: number, end: number): string {
  const openOf = (s: number) => (s & BOLD ? `${ESC}[1m` : "") + (s & CODE ? `${ESC}[36m` : "");
  const closeOf = (s: number) => (s & CODE ? `${ESC}[39m` : "") + (s & BOLD ? `${ESC}[22m` : "");
  let out = "";
  let cur = 0;
  for (let i = start; i < end; i++) {
    const s = styles[i]!;
    if (s !== cur) {
      out += closeOf(cur) + openOf(s);
      cur = s;
    }
    out += cps[i]!;
  }
  out += closeOf(cur);
  return out;
}

/**
 * Marker-stripped inline markdown wrapped by the shared ruler, styles re-applied positionally.
 * wrapLineToWidth drops only single joining spaces at row breaks, so each emitted row is a
 * CONTIGUOUS cps range — the pointer just skips the dropped space between rows.
 */
function styledRows(raw: string, width: number): string[] {
  const { cps, styles } = parseInline(raw);
  const rows = wrapLineToWidth(cps.join(""), width);
  const out: string[] = [];
  let ptr = 0;
  for (const row of rows) {
    const len = [...row].length;
    while (ptr < cps.length && cps.slice(ptr, ptr + len).join("") !== row && cps[ptr] === " ")
      ptr++;
    out.push(emitStyledRow(cps, styles, ptr, ptr + len));
    ptr += len;
  }
  return out;
}

// -- markdown body --------------------------------------------------------------------------

/**
 * An assistant markdown body as styled lines, sharing classifyMarkdownLines with
 * MarkdownRenderer / markdownBodyHeight / tailToFit (ONE classifier — the fence/heading/list
 * divergence class cannot reopen). Row counts match markdownBodyHeight(text, cols) for
 * marker-free text: heading → blank marginTop row + wrapped bold-cyan text; list → 2-col
 * indent + yellow bullet, body wrapped at cols-4; fence delimiters dim verbatim; code
 * verbatim default-fg; plain → inline markdown.
 *
 * `inFence` seeds the classifier mid-fence (a streamed chunk that starts inside a code block
 * must not re-classify `# comment` as a heading — the phantom-marginTop bug class tailToFit's
 * openerIdx guards). Returns the end state so the stream cache can carry it across flushes.
 */
export function markdownToLinesStateful(
  text: string,
  cols: number,
  inFence: boolean,
): { lines: string[]; inFence: boolean } {
  const w = Math.max(1, cols);
  const listw = Math.max(1, cols - 4);
  const md = classifyMarkdownLines(inFence ? `\`\`\`\n${text}` : text);
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < md.length; i++) {
    const l = md[i]!;
    if (l.kind === "fence-open") fence = true;
    else if (l.kind === "fence-close") fence = false;
    if (inFence && i === 0) continue; // the synthetic opener row
    if (l.kind === "heading") {
      out.push("");
      for (const row of wrapLineToWidth(l.text, w)) out.push(paint(row, 1, 36));
    } else if (l.kind === "list") {
      styledRows(l.text, listw).forEach((row, idx) => {
        out.push(idx === 0 ? `  ${paint(`${l.bullet ?? "-"} `, 33)}${row}` : `    ${row}`);
      });
    } else if (l.kind === "fence-open" || l.kind === "fence-close") {
      for (const row of wrapLineToWidth(l.text, w)) out.push(paint(row, 2));
    } else if (l.kind === "code") {
      out.push(...wrapLineToWidth(l.text, w));
    } else {
      out.push(...styledRows(l.text, w));
    }
  }
  return { lines: out, inFence: fence };
}

export function markdownToLines(text: string, cols: number): string[] {
  return markdownToLinesStateful(text, cols, false).lines;
}

// -- per-message rendering ------------------------------------------------------------------

/** Center `row` in `cols` display columns (BannerBlock's alignItems="center"). */
function centered(row: string, cols: number): string {
  const pad = Math.max(0, Math.floor((cols - stringWidth(row)) / 2));
  return " ".repeat(pad) + row;
}

/**
 * One message as pre-wrapped ANSI lines, chrome and all — the line-space equivalent of
 * MessageRow. Line 0 is always the blank marginTop separator. Width floors mirror the
 * computeMsgHeight branch for the same role (wrappedLineCount floors at 20).
 */
export function renderMessageToLines(msg: ChatMessage, cols: number): string[] {
  const out: string[] = [""];
  const w20 = Math.max(20, cols);

  if (msg.role === "banner") {
    for (const src of getAsciiBanner("MINIMA").split("\n"))
      for (const row of wrapLineToWidth(src, w20)) out.push(centered(paint(row, 1, 32), cols));
    for (const line of BANNER_TAGLINES) {
      out.push("");
      for (const row of wrapLineToWidth(line, w20)) out.push(centered(paint(row, 90), cols));
    }
    if (msg.text) {
      out.push("");
      for (const row of wrapLineToWidth(msg.text, w20)) out.push(centered(paint(row, 33), cols));
    }
    return out;
  }

  if (msg.role === "user") {
    if (msg.guardKind === "harness") {
      for (const row of wrapLineToWidth(harnessNoiseLine(msg.text), w20)) out.push(paint(row, 2));
      return out;
    }
    out.push(paint("▸ you", 32));
    const bodyW = Math.max(20, cols - 2);
    for (const row of wrapText(msg.text, bodyW)) out.push(paint(` ${row} `, 37, "48;2;42;42;53"));
    return out;
  }

  if (msg.role === "tool") {
    if (msg.guardKind === "deny") {
      for (const row of wrapLineToWidth(guardDenyLine(msg.toolName), w20)) out.push(paint(row, 2));
      return out;
    }
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    const gateBlock =
      msg.isError === true && msg.toolName === "todowrite" && isGateBlockReason(msg.text);
    if (gateBlock) {
      for (const row of wrapLineToWidth(
        "  ⊘ verify gate — completion blocked, statuses unchanged:",
        w20,
      ))
        out.push(paint(row, 33));
      out.push(...wrapText(body, w20));
    } else {
      for (const row of wrapLineToWidth(`  ⚙ ${msg.toolName ?? "tool"}:`, w20))
        out.push(paint(row, msg.isError ? 31 : 33));
      for (const row of wrapText(body, w20)) out.push(msg.isError ? paint(row, 31) : row);
    }
    if (hiddenLines > 0) out.push(paint(`  ${toolHiddenMarker(hiddenLines)}`, 2));
    return out;
  }

  if (msg.role === "thinking") {
    const inner = Math.max(1, cols - 2); // between the border pipes
    const bodyW = Math.max(20, cols - 4); // paddingLeft 2 inside the border
    const row = (content: string) => {
      const pad = " ".repeat(Math.max(0, inner - 2 - stringWidth(content)));
      return `${paint("│", 90)}  ${paint(content, 90, 3)}${pad}${paint("│", 90)}`;
    };
    out.push(paint(`┌${"─".repeat(inner)}┐`, 90));
    out.push(row(`🧠 reasoning (${msg.thoughtDurationSecs?.toFixed(1) ?? "0.0"}s)`));
    for (const r of wrapText(msg.text, bodyW)) out.push(row(r));
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

const streamCache = { head: "", cols: 0, lines: [] as string[], inFence: false };

/**
 * The LIVE assistant reply (header + markdown body) as viewport lines, incrementally cached:
 * only source lines after the previously-seen last "\n" are re-rendered per stream flush, so
 * each 80ms tick costs O(new text), not O(whole reply). Fence state carries across flushes
 * (streamCache.inFence) so a chunk cut mid-code-block classifies as code, not prose. Resets
 * when the text is not an extension of the previous flush (new turn / retry) or the width
 * changes.
 */
export function liveReplyLines(text: string, cols: number): string[] {
  const cut = text.lastIndexOf("\n");
  const head = cut === -1 ? "" : text.slice(0, cut); // complete source lines
  const tail = cut === -1 ? text : text.slice(cut + 1); // still-streaming partial line
  if (streamCache.cols !== cols || !head.startsWith(streamCache.head)) {
    streamCache.cols = cols;
    streamCache.head = "";
    streamCache.lines = [];
    streamCache.inFence = false;
  }
  if (head !== streamCache.head) {
    const fresh = streamCache.head === "" ? head : head.slice(streamCache.head.length + 1);
    const r = markdownToLinesStateful(fresh, cols, streamCache.inFence);
    streamCache.lines.push(...r.lines);
    streamCache.inFence = r.inFence;
    streamCache.head = head;
  }
  const tailLines =
    tail === "" ? [] : markdownToLinesStateful(tail, cols, streamCache.inFence).lines;
  return ["", paint("◆ assistant", 35), ...streamCache.lines, ...tailLines];
}

/** Reset the incremental stream cache (turn end). Exported for tests and turn boundaries. */
export function resetLiveReplyCache(): void {
  streamCache.head = "";
  streamCache.cols = 0;
  streamCache.lines = [];
  streamCache.inFence = false;
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
