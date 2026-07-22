/**
 * Pure layout math for the TUI — no React/Ink, so it is unit-testable in isolation.
 *
 * The renderer prints the finalized transcript via Ink's <Static> (native scrollback) and
 * only re-diffs a small live region; the helpers below size that region.
 *
 * Helpers:
 *   - wrappedLineCount     — input-box height as the typed text wraps
 *   - tailToFit            — the last lines of a streaming reply that fit the live area
 *   - clampToolText        — bound a huge tool result so the preview can't dwarf the screen
 *   - markdownBodyHeight   — rendered rows of a markdown body, mirroring MarkdownRenderer
 *   - computeMsgHeight     — rendered rows of one MessageRow (per role)
 *
 * The cardinal rule for these estimates: they MUST be >= the real rendered rows in messages.tsx (a
 * CONSERVATIVE bias). An under-count would let content grow past the space reserved for it and
 * desync Ink's frame diff — the garbled-overlap / decimation class of bug this module guards
 * against (an overgrown live region reaching `rows` makes Ink clearTerminal and wipe scrollback).
 */

import stringWidth from "string-width";

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "thinking" | "banner";
  text: string;
  toolName?: string;
  isError?: boolean;
  thoughtDurationSecs?: number;
}

const BANNER_GLYPHS: Record<string, string[]> = {
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
};

export function getAsciiBanner(word: string): string {
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    const chars: string[] = [];
    for (const ch of word) {
      const glyph = BANNER_GLYPHS[ch];
      if (glyph) {
        chars.push(glyph[r] || "");
      }
    }
    rows.push(chars.join(" "));
  }
  return rows.join("\n");
}

// Startup banner taglines — one array feeds BOTH the JSX and the ledger's row count, so the
// reservation can't drift from the render.
export const BANNER_TAGLINES = [
  "CLI · cost-aware model routing",
  "recommend → run → judge → feedback → memory",
  "type a prompt, or / for commands",
  "scroll with your terminal (wheel / trackpad) · select & copy freely",
];

/** Rendered rows of the MINIMA banner block (live and committed forms are the same JSX). */
export function bannerRowCount(tip: string | null, cols: number): number {
  return (
    1 +
    wrappedLineCount(getAsciiBanner("MINIMA"), cols) +
    BANNER_TAGLINES.reduce((n, line) => n + 1 + wrappedLineCount(line, cols), 0) +
    (tip ? 1 + wrappedLineCount(tip, cols) : 0)
  );
}

/** Max rendered lines of a tool message before it's clipped (keeps /model, big bash, etc. bounded). */
export const MAX_TOOL_LINES = 30;

/**
 * Clip a tool message body to MAX_TOOL_LINES *rendered* rows (word-wrapped at the box interior),
 * not source lines: one long web_fetch/web_search line can wrap to dozens of rows, so a source-line
 * clamp still lets the box dwarf the chat region. Returns the shown text + how many source lines
 * were hidden. `cols` is the terminal width (interior = cols-4, floored at 20 to match
 * wrappedLineCount). The first source line is always kept even if it alone exceeds the budget.
 */
export function clampToolText(text: string, cols: number): { text: string; hiddenLines: number } {
  // Tab-expanded (4 spaces) because string-width counts \t as 0 while the terminal advances
  // to a tab stop — the same width-lie class the fence/code classifier guards (see MdLine).
  // This is the single choke point: MessageRow, computeMsgHeight, and the D3b reader all
  // consume the clamped text, so render == estimate == reader stays an identity.
  const expanded = text.replaceAll("\t", "    ");
  const w = Math.max(20, cols - 4);
  const lines = expanded.split("\n");
  let rendered = 0;
  let kept = 0;
  for (const line of lines) {
    const r = wrapRows(line, w);
    if (kept > 0 && rendered + r > MAX_TOOL_LINES) break;
    rendered += r;
    kept++;
  }
  if (kept >= lines.length) return { text: expanded, hiddenLines: 0 };
  return { text: lines.slice(0, kept).join("\n"), hiddenLines: lines.length - kept };
}

/**
 * The tool-truncation indicator row, CC-style (`… 214 more lines`). ONE producer for both
 * truncation surfaces — the live transcript (MessageRow) and the D3b reader — so the
 * committed scrollback and the panel can never show different markers. Call sites add
 * their own indent; this string carries none.
 */
export function toolHiddenMarker(hidden: number): string {
  return `… ${hidden} more lines`;
}

/**
 * Word-wrap a single logical line to `width` display columns, PRODUCING the wrapped rows —
 * matching Ink's wrap-ansi ({ trim: false, wordWrap: true, hard: true }): greedily pack
 * space-separated words, wrap to a new row when the next word (plus a joining space) won't
 * fit, and hard-break any single word wider than a full row (by display columns — a wide
 * char that doesn't fit moves whole to the next row). Uses stringWidth so emoji/CJK count
 * as 2. Because Ink wraps with trim:false, LEADING SPACES OCCUPY COLUMNS — the indent is
 * peeled and seeded into the first row (hard-broken if wider than a row) so indented code
 * measures and reproduces exactly; dropping it (the old `col === 0` join test) under-counted
 * and let the live region overgrow its reservation.
 * Known benign divergence: for an over-width token following text on the same row, wrap-ansi
 * may pack the row's tail before hard-breaking while this always flushes first — one row
 * MORE, never fewer (safe over-estimate).
 * `wrapRows` is DEFINED as this function's row count, so the string producer (the D3b
 * reader) and every height estimate in this file can never diverge.
 */
export function wrapLineToWidth(line: string, width: number): string[] {
  const w = Math.max(1, width);
  if (line === "") return [""];
  const out: string[] = [];
  let lead = (line.match(/^ +/) ?? [""])[0];
  const body = line.slice(lead.length);
  while (lead.length > w) {
    out.push(lead.slice(0, w));
    lead = lead.slice(w);
  }
  let cur = lead;
  let col = lead.length;
  let join = false;
  const flush = () => {
    out.push(cur);
    cur = "";
    col = 0;
    join = false;
  };
  for (const word of body.split(" ")) {
    const wlen = stringWidth(word);
    const needed = join ? col + 1 + wlen : col + wlen;
    if (needed <= w) {
      cur = join ? `${cur} ${word}` : cur + word;
      col = needed;
      join = true;
      continue;
    }
    if (col !== 0) flush();
    if (wlen <= w) {
      cur = word;
      col = wlen;
      join = true;
      continue;
    }
    let rest = word;
    while (stringWidth(rest) > w) {
      let take = "";
      let tw = 0;
      for (const ch of rest) {
        const cw = stringWidth(ch);
        if (tw + cw > w) break;
        take += ch;
        tw += cw;
      }
      out.push(take);
      rest = rest.slice(take.length);
    }
    cur = rest;
    col = stringWidth(rest);
    join = true;
  }
  out.push(cur);
  return out;
}

function wrapRows(line: string, width: number): number {
  return wrapLineToWidth(line, width).length;
}

/**
 * Wrapped row count of `text` at content `width` (>=1 per source line; floors width at 20).
 * Word-wraps each line the way Ink does (see wrapRows) so the estimate stays >= the real render.
 */
export function wrappedLineCount(text: string, width: number): number {
  const w = Math.max(20, width);
  let n = 0;
  for (const line of text.split("\n")) n += wrapRows(line, w);
  return n;
}

/**
 * One classified markdown line — THE shared representation consumed by all three rendering
 * sites (MarkdownRenderer, markdownBodyHeight, sectionReaderLines), so the render, the
 * height estimate, and the panel reader cannot classify a line differently (the divergence
 * that garbled fenced code: delimiters hit the inline-backtick toggle, `#` code lines became
 * headings with a phantom marginTop row, `- ` code lines became bullets).
 *
 * Fence rule (v1): a line whose trim starts with ``` opens a fence; the next such line
 * closes it; EOF with an open fence leaves the trailing lines as code — which is exactly the
 * mid-stream state, so streaming needs no special case. Tilde fences, 4-space-indent blocks,
 * and CommonMark fence-length matching are deliberately out of scope (models emit backtick
 * fences; each is a 2-line tweak here if ever needed).
 * List rule: `- `/`* ` WITH the space (`-x`, `---`, `--flag` are plain text).
 * Fence/code text is tab-expanded (4 spaces) because string-width counts \t as 0 while the
 * terminal advances to a tab stop — the same width-lie class the thinking box guards.
 */
export interface MdLine {
  kind: "heading" | "list" | "fence-open" | "fence-close" | "code" | "plain";
  /** Heading text sans #'s; list body sans marker; tab-expanded verbatim for fence/code; raw for plain. */
  text: string;
  bullet?: "-" | "•";
  /** code + fence-close: index of the opening ``` line (lets tailToFit re-anchor a mid-fence slice). */
  openerIdx?: number;
}

export function classifyMarkdownLines(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  let openerIdx = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inFence) {
        inFence = false;
        out.push({ kind: "fence-close", text: line.replaceAll("\t", "    "), openerIdx });
      } else {
        inFence = true;
        openerIdx = i;
        out.push({ kind: "fence-open", text: line.replaceAll("\t", "    ") });
      }
    } else if (inFence) {
      out.push({ kind: "code", text: line.replaceAll("\t", "    "), openerIdx });
    } else if (trimmed.startsWith("#")) {
      const depth = (trimmed.match(/^#+/) ?? [""])[0].length;
      out.push({ kind: "heading", text: trimmed.slice(depth).trim() });
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      out.push({
        kind: "list",
        text: trimmed.slice(1).trim(),
        bullet: trimmed.startsWith("- ") ? "-" : "•",
      });
    } else {
      out.push({ kind: "plain", text: line });
    }
  }
  return out;
}

/**
 * Rendered rows of an assistant markdown body, in lockstep with MarkdownRenderer in
 * messages.tsx via the shared classifier, so the live-streaming reservation in app.tsx
 * agrees with what actually renders:
 *   - heading            -> a marginTop={1} row + the wrapped heading text
 *   - list               -> body wrapped at interior-4 (marginLeft 2 + "- " bullet 2)
 *   - fence/code/plain   -> wrapped verbatim at the full interior width
 * `interior` is the content width (stream box interior = cols-4).
 */
export function markdownBodyHeight(text: string, interior: number): number {
  const iw = Math.max(1, interior);
  const listw = Math.max(1, interior - 4);
  let rows = 0;
  for (const l of classifyMarkdownLines(text)) {
    if (l.kind === "heading") rows += 1 + wrapRows(l.text, iw);
    else if (l.kind === "list") rows += wrapRows(l.text, listw);
    else rows += wrapRows(l.text, iw);
  }
  return rows;
}

/**
 * The last whole source lines of `text` whose markdown render fits in `budgetRows` rows at content
 * width `interior`. Bounds the LIVE streaming preview so the dynamic (re-diffed) region never
 * exceeds the screen; the finalized reply is printed in full to scrollback via <Static>. Always
 * keeps at least the final line.
 */
export function tailToFit(text: string, interior: number, budgetRows: number): string {
  const lines = text.split("\n");
  if (budgetRows <= 0 || lines.length === 0) return "";
  const iw = Math.max(1, interior);
  const listw = Math.max(1, interior - 4);
  // Classify the FULL text once: a slice that starts mid-fence must not re-classify code
  // as prose (a `# comment` code line would gain a phantom marginTop row -> render >
  // estimate -> the scrollback-wiping class), so per-line heights come from the whole-text
  // classification and mid-fence slices get their real opener line prepended.
  const md = classifyMarkdownLines(text);
  const lineH = (l: MdLine): number => {
    if (l.kind === "heading") return 1 + wrapRows(l.text, iw);
    if (l.kind === "list") return wrapRows(l.text, listw);
    return wrapRows(l.text, iw);
  };
  let rows = 0;
  let start = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = lineH(md[i]!);
    if (i < lines.length - 1 && rows + h > budgetRows) break;
    rows += h;
    start = i;
  }
  const sliceFrom = (s: number): string => {
    const first = md[s]!;
    const opener =
      (first.kind === "code" || first.kind === "fence-close") && first.openerIdx !== undefined
        ? `${lines[first.openerIdx]}\n`
        : "";
    return opener + lines.slice(s).join("\n");
  };
  let out = sliceFrom(start);
  // The opener prepend adds a row the accumulate loop didn't count — measure the EXACT
  // final string with the fence-aware height and advance until it fits (estimate == render
  // by construction; touches only O(budget) short lines).
  while (start < lines.length - 1 && markdownBodyHeight(out, interior) > budgetRows) {
    start++;
    out = sliceFrom(start);
  }
  // A streamed paragraph is ONE source line until the model emits "\n" — when even the
  // final line alone exceeds the budget, drop the prepended opener (budget is king; the
  // sliced string is measured and rendered identically, so height stays exact — one
  // pathological frame may style a code fragment as prose) and hard-slice its tail.
  // Otherwise the live region outgrows its reservation, reaches terminal height, and trips
  // Ink's scrollback-wiping clearTerminal.
  if (start === lines.length - 1 && markdownBodyHeight(out, interior) > budgetRows) {
    out = lines[start] ?? "";
    if (markdownBodyHeight(out, interior) > budgetRows) {
      out = out.slice(-(budgetRows * iw));
      while (out.length > iw && markdownBodyHeight(out, interior) > budgetRows) {
        out = out.slice(iw);
      }
    }
  }
  return out;
}

/**
 * Safety margin (rows) kept between the live region and the terminal height. Ink renders inline in
 * the MAIN screen buffer, and if the live frame height reaches `rows` its reconciler switches to a
 * full clearTerminal (CSI 3J) that WIPES the terminal scrollback — destroying the <Static> transcript
 * the user scrolls through. So the live region must stay strictly below `rows`; 2 rows also covers
 * log-update's trailing newline and small estimation slack.
 */
export const SCROLLBACK_SAFETY_ROWS = 2;

/**
 * The anchor-ledger kernel (2026-07-20). The live frame's next explicit height, holding THE
 * RULE's invariant structurally instead of via the estimate-decay minHeight:
 *
 *   H >= H_prev − K   and   H <= rows − SCROLLBACK_SAFETY_ROWS
 *
 * where K = transcript rows committed to <Static> with this frame. log-update rewrites each
 * frame TOP-anchored at the previous frame's top, so a frame that shrinks faster than the
 * static rows printed above it lands its bottom above the terminal bottom — the stranded-
 * composer float (perm/question teardown, busy teardown, wide-terminal stream commits where
 * the reply wraps to fewer rows than the stream-frame shrink). With the floor, K + H >=
 * H_prev keeps the bottom at/below the old bottom and the terminal scroll re-pins it; the
 * inequalities telescope across Ink's 32ms write throttle (H_n >= H_0 − ΣK_i), so skipped
 * intermediate frames cannot break it. The cap makes Ink's scrollback-wiping clearTerminal
 * unreachable from our own frames: the wipe threshold reads the root's Yoga height and
 * <Static> is position-absolute (excluded), so an explicit height <= rows − 2 can never
 * reach `rows`. Estimate errors degrade to transient padding (over-count) or a top-clip
 * under overflow="hidden" (under-count) — never a strand, never a wipe.
 *
 * Resets (R1): every ledger reset — mount, remount (/clear, rewind, resume), resize — seeds
 * prevHeight = `rows − SCROLLBACK_SAFETY_ROWS` (one full-height flex-end frame). A gen-start
 * frame that commits the banner books its rows as `committedRows`, so banner + frame fill
 * the screen exactly and the banner holds the top; resets that reprint an existing
 * transcript book nothing — the cap frame writes past the last row and the terminal scroll
 * re-anchors the composer at the bottom (the same physics the panel-close reseat used).
 */
export function nextLiveFrameHeight(
  prevHeight: number,
  committedRows: number,
  contentRows: number,
  rows: number,
): number {
  const cap = Math.max(1, rows - SCROLLBACK_SAFETY_ROWS);
  const floor = Math.max(0, Math.min(prevHeight, cap) - Math.max(0, committedRows));
  return Math.min(cap, Math.max(contentRows, floor));
}

/**
 * Rows to allot the live streaming-reply preview, given the terminal height `rows` and the rows
 * already reserved for the other live elements (input box, status/footer, busy, thoughts, header).
 * Keeps the total live frame `<= rows - SCROLLBACK_SAFETY_ROWS` so it never trips Ink's
 * scrollback-wiping clearTerminal. May be 0 on a cramped terminal — the full reply still commits to
 * <Static> when the turn ends, so nothing is lost, only the live peek is dropped.
 */
export function streamTailBudget(rows: number, reserved: number): number {
  return Math.max(0, rows - reserved - SCROLLBACK_SAFETY_ROWS);
}

/** Max wrapped rows the question text may occupy in the overlay (see questionDisplayText). */
export const QUESTION_TEXT_MAX_ROWS = 4;

/**
 * The question text as QuestionOverlay actually renders it: clamped to roughly
 * QUESTION_TEXT_MAX_ROWS rendered rows so a huge model-supplied question can't outgrow
 * the screen. Keeps whole source lines while they fit, then char-slices the first line
 * that doesn't (word wrap packs looser than a char slice, so the result may run one row
 * over — the height helper measures this same string, keeping estimate == render).
 * Shared by component and height math.
 */
export function questionDisplayText(question: string, cols: number): string {
  const interior = Math.max(20, cols - 4);
  const out: string[] = [];
  let rows = 0;
  for (const line of question.split("\n")) {
    const h = wrappedLineCount(line, interior);
    if (rows + h <= QUESTION_TEXT_MAX_ROWS) {
      out.push(line);
      rows += h;
      continue;
    }
    const remaining = QUESTION_TEXT_MAX_ROWS - rows;
    if (remaining > 0) out.push(`${line.slice(0, remaining * interior - 1)}…`);
    else if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]}…`;
    break;
  }
  return out.join("\n");
}

/**
 * Rows the `question` tool overlay occupies, mirroring QuestionOverlay in app.tsx:
 * round border (2) + clamped question text + one row per VISIBLE option (each option
 * renders wrap="truncate", so exactly one row; at most `maxOptionRows` are shown in a
 * cursor-following window) + up to 2 "↑/↓ +k more" marker rows when the window trims +
 * one truncated hint row. The typing view is never taller (draft row is truncated),
 * so this estimate stays >= the real render. `cols` is the terminal width; the overlay
 * interior is cols-4 (border + paddingX).
 */
export function questionOverlayHeight(
  q: {
    question: string;
    options: { label: string; description?: string | null }[];
    allow_freetext: boolean;
  },
  cols: number,
  maxOptionRows: number,
): number {
  const interior = Math.max(1, cols - 4);
  const totalRows = q.options.length + (q.allow_freetext ? 1 : 0);
  const visible = Math.min(totalRows, Math.max(1, maxOptionRows));
  const markers = totalRows > visible ? 2 : 0; // worst case: trimmed above AND below
  return (
    2 + wrappedLineCount(questionDisplayText(q.question, cols), interior) + visible + markers + 1
  );
}

/** The bold tool label the permission overlay renders before the prompt text. Shared by the
 * component and permOverlayHeight so the header row measurement can never drift. */
export function permToolLabel(toolName: string): string {
  switch (toolName) {
    case "read":
    case "ls":
    case "glob":
    case "grep":
      return "READ";
    case "write":
      return "WRITE (new file)";
    case "edit":
      return "EDIT (modify file)";
    case "bash":
      return "RUN COMMAND";
    default:
      return toolName.toUpperCase();
  }
}

/** The explicit truncation marker under a clipped permission preview — content is never hidden
 * silently, because approving the prompt can authorize shell execution (todowrite verify). */
export function permHiddenMarker(hidden: number): string {
  return `… +${hidden} more lines not shown — reject if unsure`;
}

/** React key for a permission-preview row — POSITION first. Todowrite verify rows share a
 * fixed 39-char label prefix ("     verify (runs as a shell command): "), so a content-sliced
 * key collides whenever two verify commands start with the same character, and React may then
 * drop or duplicate rows on the one surface whose contract is that every command is visible
 * before approval (plus a stderr warning wall into scrollback). The preview is rebuilt
 * wholesale per prompt and static while shown, so the index is the identity; the content tail
 * is only a debugging aid. */
export function permPreviewKey(index: number, line: string): string {
  return `${index}:${line.slice(0, 24)}`;
}

/**
 * The permission-overlay preview clipped to its RENDERED-row budget: whole source lines are
 * kept while the wrapped total stays within 12 rows when everything fits, else 11 so the
 * explicit marker row shares the same budget. A shown line is never char-truncated — a verify
 * shell command the user is approving must stay visible in full, so each kept line still
 * word-wraps and the first line is always kept even when it alone exceeds the budget (its true
 * wrapped height is what permOverlayHeight then counts). `cols` is the terminal width; the
 * overlay interior is cols-4 (border + paddingX), floored at 20 to match wrappedLineCount.
 */
export function permPreviewLines(
  preview: string,
  cols: number,
): { lines: string[]; hidden: number } {
  const w = Math.max(20, cols - 4);
  const lines = preview.split("\n");
  let total = 0;
  for (const line of lines) total += wrapRows(line, w);
  if (total <= 12) return { lines, hidden: 0 };
  let rendered = 0;
  let kept = 0;
  for (const line of lines) {
    const r = wrapRows(line, w);
    if (kept > 0 && rendered + r > 11) break;
    rendered += r;
    kept++;
  }
  return { lines: lines.slice(0, kept), hidden: lines.length - kept };
}

/**
 * Rows the permission overlay occupies, mirroring PermissionOverlay in app.tsx: round border (2)
 * + the wrapped label+prompt line + the wrapped ` target:` line (only when there is no preview)
 * + the wrapped rows of every shown preview line + the wrapped marker row when lines are hidden
 * + one truncated hint row. Component and reservation consume the SAME helpers, so estimate ==
 * render by construction — the source-line count this replaces under-reserved whenever a preview
 * line word-wrapped at narrow widths, letting the live frame overflow its reservation and trip
 * Ink's scrollback-wiping clearTerminal.
 */
export function permOverlayHeight(
  p: { toolName: string; promptText: string; argsSummary: string; diffPreview?: string | null },
  cols: number,
): number {
  const interior = Math.max(20, cols - 4);
  let rows = 2 + wrappedLineCount(`${permToolLabel(p.toolName)} ${p.promptText}`, interior);
  if (p.argsSummary && !p.diffPreview) {
    rows += wrappedLineCount(` target: ${p.argsSummary.slice(0, 80)}`, interior);
  }
  if (p.diffPreview) {
    const { lines, hidden } = permPreviewLines(p.diffPreview, cols);
    for (const line of lines) rows += wrapRows(line, interior);
    if (hidden > 0) rows += wrapRows(permHiddenMarker(hidden), interior);
  }
  return rows + 1;
}

/**
 * Rows the ChildTree panel occupies, mirroring child_tree.tsx: round border (2) +
 * header (1) + one row per visible child (capped at `maxRows`, with a "+k more" row
 * when the cap trims) + marginBottom (1). Zero when there are no children — the
 * component renders null.
 */
export function childTreeHeight(childCount: number, maxRows: number): number {
  if (childCount <= 0) return 0;
  const visible = Math.min(childCount, Math.max(1, maxRows));
  return 4 + visible + (childCount > visible ? 1 : 0);
}

/**
 * Rendered rows a single message occupies, mirroring `MessageRow` in messages.tsx exactly.
 * CONSERVATIVE bias (>= actual): each role uses the accurate word-wrap helpers at the *narrowest*
 * width the real render could use, so we never under-count (an under-count would let content
 * render past its budget and desync Ink — the garble class). `cols` is the terminal width.
 */
export function computeMsgHeight(msg: ChatMessage, cols: number): number {
  if (msg.role === "banner") {
    return bannerRowCount(msg.text || null, cols);
  }
  if (msg.role === "user") {
    // marginTop(1) + "▸ you" header(1) + body (` ${text} ` — pad 2 cols; wrap at &lt;= cols-2).
    return 2 + wrappedLineCount(msg.text, cols - 2);
  }
  if (msg.role === "tool") {
    // marginTop(1) + wrapped "⚙ tool:" header (a long MCP tool name can wrap at narrow
    // cols — a flat 1 under-counted) + body + optional hint. The inline MessageRow paints
    // the body unindented at the full box width, so the ruler must wrap at `cols` — counting
    // at an interior width over-reserves and floats the composer off the terminal bottom.
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    const header = `  ⚙ ${msg.toolName ?? "tool"}:`;
    return (
      1 + wrappedLineCount(header, cols) + wrappedLineCount(body, cols) + (hiddenLines > 0 ? 1 : 0)
    );
  }
  if (msg.role === "thinking") {
    // marginTop(1) + single border(2) + header(1) + body wrapped at interior cols-4 (border 2 + padL 2).
    return 4 + wrappedLineCount(msg.text, cols - 4);
  }
  // assistant: marginTop(1) + "◆ assistant" header(1) + markdown body (headings/lists add rows).
  return 2 + markdownBodyHeight(msg.text, cols);
}

// ---------------------------------------------------------------------------
// Panels. The docked/overlay sidebar system (U2, MUB-140) died in MP2 (MUB-145) and the
// fullscreen renderer + rewind overlay in MP3 (MUB-146). TOC_MIN_COLS is the TUI-wide
// readable-width floor; clipPanelLines is kept for the D3b live-region panels (guide MP7+).
// ---------------------------------------------------------------------------

/**
 * Min readable width for full rendering. Since always-panel (2026-07-20) only /why still
 * degrades to text below it — Ctrl+T/Ctrl+G open the panel at any width the app renders.
 */
export const TOC_MIN_COLS = 60;

/**
 * Rows of the status group that stay mounted below an expanded live-region panel:
 * StatusBar marginTop(1) + its 2 truncated rows + the keys-legend row(1). ChildTree,
 * the quit-armed line, busy, and suggestions are suppressed/unreachable while a panel
 * captures keys, so they are deliberately NOT part of this constant.
 */
export const PANEL_STATUS_ROWS = 4;

/**
 * Outer height (border included) of an expanded live-region panel (D3b, and the MP4
 * spike that certified it): panel + composer box + status group must total EXACTLY
 * rows − SCROLLBACK_SAFETY_ROWS — an identity, not an estimate — so the live frame can
 * never reach `rows` (Ink's scrollback-wiping clearTerminal). `inputBoxHeight` is the
 * app's reserve for the composer group (marginTop + border + input rows + plan banner).
 */
export function panelOuterHeight(rows: number, inputBoxHeight: number): number {
  return rows - SCROLLBACK_SAFETY_ROWS - PANEL_STATUS_ROWS - inputBoxHeight;
}

/**
 * Window `lines` to exactly `innerHeight` rows with `cursorLine` visible: scrolls down
 * only as far as needed (cursor rides the bottom edge when moving down), clamps to the
 * content end, and pads with "" so every panel row paints — an unpainted row would let
 * the content underneath bleed through.
 */
export function clipPanelLines(
  lines: string[],
  innerHeight: number,
  cursorLine: number,
): { lines: string[]; top: number } {
  const maxTop = Math.max(0, lines.length - innerHeight);
  let top = Math.max(0, Math.min(cursorLine - innerHeight + 1, maxTop));
  if (cursorLine < top) top = Math.min(cursorLine, maxTop);
  const windowed = lines.slice(top, top + innerHeight);
  while (windowed.length < innerHeight) windowed.push("");
  return { lines: windowed, top };
}
