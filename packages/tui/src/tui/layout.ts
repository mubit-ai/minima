/**
 * Pure layout math for the TUI — no React/Ink, so it is unit-testable in isolation.
 *
 * Two consumers:
 *   - The INLINE renderer prints the finalized transcript via Ink's <Static> (native scrollback) and
 *     only re-diffs a small live region; the helpers below size that region.
 *   - The FULLSCREEN renderer owns an alternate-screen viewport and windows the whole transcript
 *     itself (getScrollableMessages + computeMsgHeight), because <Static>/native scroll is gone.
 *
 * Helpers:
 *   - wrappedLineCount     — input-box height as the typed text wraps
 *   - tailToFit            — the last lines of a streaming reply that fit the live area
 *   - clampToolText        — bound a huge tool result so the preview can't dwarf the screen
 *   - markdownBodyHeight   — rendered rows of a markdown body, mirroring MarkdownRenderer
 *   - computeMsgHeight     — rendered rows of one MessageRow (per role), the fullscreen window's ruler
 *   - getScrollableMessages — bottom-anchored window of the transcript for the fullscreen viewport
 *
 * The cardinal rule for these estimates: they MUST be >= the real rendered rows in messages.tsx (a
 * CONSERVATIVE bias). An under-count would let content grow past the space reserved for it and desync
 * Ink's frame diff (inline) or overflow the flex-end viewport (fullscreen) — the garbled-overlap /
 * decimation class of bug this module guards against.
 */

import stringWidth from "string-width";

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "thinking";
  text: string;
  toolName?: string;
  isError?: boolean;
  thoughtDurationSecs?: number;
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
  const w = Math.max(20, cols - 4);
  const lines = text.split("\n");
  let rendered = 0;
  let kept = 0;
  for (const line of lines) {
    const r = wrapRows(line, w);
    if (kept > 0 && rendered + r > MAX_TOOL_LINES) break;
    rendered += r;
    kept++;
  }
  if (kept >= lines.length) return { text, hiddenLines: 0 };
  return { text: lines.slice(0, kept).join("\n"), hiddenLines: lines.length - kept };
}

/**
 * Rows a single logical line occupies when word-wrapped to `width` display columns — matching Ink's
 * wrap-ansi ({ wordWrap: true, hard: true }): greedily pack space-separated words, wrap to a new row
 * when the next word (plus a joining space) won't fit, and hard-break any single word wider than a
 * full row. A char-based ceil(width) UNDER-counts this (words don't pack tightly), which is exactly
 * what desynced Ink's diff into garbled overlap — so we replicate the real algorithm to keep the
 * estimate >= actual. Uses display columns (stringWidth) so emoji/CJK (💡🧠⚙◆▸) count as 2.
 */
function wrapRows(line: string, width: number): number {
  const w = Math.max(1, width);
  if (line === "") return 1;
  let rows = 1;
  let col = 0;
  for (const word of line.split(" ")) {
    const wlen = stringWidth(word);
    const needed = col === 0 ? wlen : col + 1 + wlen;
    if (needed <= w) {
      col = needed;
      continue;
    }
    if (col !== 0) rows += 1; // this word starts a fresh row
    if (wlen <= w) {
      col = wlen;
    } else {
      // hard-break an over-long word across full rows; the remainder sits on the last row
      rows += Math.ceil(wlen / w) - 1;
      col = wlen % w || w;
    }
  }
  return rows;
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
 * Rendered rows of an assistant markdown body, mirroring MarkdownRenderer in messages.tsx so the
 * live-streaming reservation in app.tsx agrees with what actually renders:
 *   - `#` heading   -> a marginTop={1} row + the wrapped heading text
 *   - `-`/`* ` list  -> body wrapped at interior-4 (marginLeft 2 + "- " bullet 2)
 *   - any other line -> wrapped at the full interior width
 * `interior` is the content width (stream box interior = cols-4).
 */
export function markdownBodyHeight(text: string, interior: number): number {
  const iw = Math.max(1, interior);
  const listw = Math.max(1, interior - 4);
  let rows = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const depth = (trimmed.match(/^#+/) ?? [""])[0].length;
      rows += 1 + wrapRows(trimmed.slice(depth).trim(), iw);
    } else if (trimmed.startsWith("-") || trimmed.startsWith("* ")) {
      rows += wrapRows(trimmed.slice(1).trim(), listw);
    } else {
      rows += wrapRows(line, iw);
    }
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
  let rows = 0;
  let start = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = markdownBodyHeight(lines[i]!, interior);
    if (i < lines.length - 1 && rows + h > budgetRows) break;
    rows += h;
    start = i;
  }
  let out = lines.slice(start).join("\n");
  // A streamed paragraph is ONE source line until the model emits "\n" — when even the
  // final line alone exceeds the budget, hard-slice its tail. Otherwise the live region
  // outgrows the viewport: fullscreen re-enters the overflow garble class, and inline can
  // reach terminal height and trip Ink's scrollback-wiping clearTerminal.
  if (start === lines.length - 1 && markdownBodyHeight(out, interior) > budgetRows) {
    const iw = Math.max(1, interior);
    out = out.slice(-(budgetRows * iw));
    while (out.length > iw && markdownBodyHeight(out, interior) > budgetRows) {
      out = out.slice(iw);
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
 * line word-wrapped at narrow widths, letting the live frame overflow its reservation (inline:
 * Ink's scrollback-wiping clearTerminal; fullscreen: a clipped footer).
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
 * Fit the up-to-three Ground-Truth footer rows (🔴 block prompt, plan strip, 🟡 flagged note)
 * into `budget` spare rows, granting in priority order block → strip → note (the block is the
 * approval surface for a halted step, the strip is orientation, the note is the most droppable).
 * Absent rows are never granted, so an all-absent input is all-absent out at ANY budget — the
 * default (ground-truth off) path is structurally unaffected. Display only: dropping the 🔴 row
 * changes nothing about the done-gate, which is enforced in the tool dispatcher.
 */
export function gtFooterFit(
  budget: number,
  present: { block: boolean; strip: boolean; note: boolean },
): { block: boolean; strip: boolean; note: boolean } {
  let left = budget;
  const grant = (want: boolean): boolean => {
    if (!want || left <= 0) return false;
    left -= 1;
    return true;
  };
  return { block: grant(present.block), strip: grant(present.strip), note: grant(present.note) };
}

/**
 * Rendered rows a single message occupies, mirroring `MessageRow` in messages.tsx exactly, so the
 * fullscreen viewport (getScrollableMessages) can window history without overflowing the frame.
 * CONSERVATIVE bias (>= actual): each role uses the accurate word-wrap helpers at the *narrowest*
 * width the real render could use, so we never under-count (an under-count would let the viewport
 * render past its budget and desync Ink — the garble class). `cols` is the terminal width.
 */
export function computeMsgHeight(msg: ChatMessage, cols: number): number {
  if (msg.role === "user") {
    // marginTop(1) + "▸ you" header(1) + body (` ${text} ` — pad 2 cols; wrap at &lt;= cols-2).
    return 2 + wrappedLineCount(msg.text, cols - 2);
  }
  if (msg.role === "tool") {
    // marginTop(1) + "⚙ tool:" header(1) + clamped body (rows at interior cols-4) + optional hint.
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    return 2 + wrappedLineCount(body, cols - 4) + (hiddenLines > 0 ? 1 : 0);
  }
  if (msg.role === "thinking") {
    // marginTop(1) + single border(2) + header(1) + body wrapped at interior cols-4 (border 2 + padL 2).
    return 4 + wrappedLineCount(msg.text, cols - 4);
  }
  // assistant: marginTop(1) + "◆ assistant" header(1) + markdown body (headings/lists add rows).
  return 2 + markdownBodyHeight(msg.text, cols);
}

/** A windowed view of the transcript for the fullscreen renderer. */
export interface ScrollWindow {
  /** Whole messages overlapping the visible window (the region clips the top fold). */
  visible: ChatMessage[];
  /** Total estimated rows of the whole transcript. */
  totalHeight: number;
  /** True when scrolled as far up as content allows. */
  atTop: boolean;
  /** True when pinned to the newest content (offset 0). */
  atBottom: boolean;
}

/**
 * Select the messages visible in a `maxHeight`-row viewport at `scrollOffset` (0 = newest pinned to
 * the bottom; positive = scrolled up N rows). Sums per-message heights, clamps the offset to
 * `[0, total-maxHeight]`, and returns the whole messages overlapping the window `[end-maxHeight,
 * end]` where `end = total - offset`. Renders per-message (no turn boxes); the viewport bottom-aligns
 * with overflow:"hidden", so the message straddling the top fold is clipped (oldest content first).
 */
export function getScrollableMessages(
  messages: ChatMessage[],
  maxHeight: number,
  scrollOffset: number,
  cols: number,
): ScrollWindow {
  if (messages.length === 0) return { visible: [], totalHeight: 0, atTop: true, atBottom: true };

  const heights = messages.map((m) => computeMsgHeight(m, cols));
  const totalHeight = heights.reduce((a, b) => a + b, 0);

  const maxOffset = Math.max(0, totalHeight - maxHeight);
  const effectiveOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const endLine = totalHeight - effectiveOffset;
  const startLine = Math.max(0, endLine - maxHeight);

  let currentLine = 0;
  const visible: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const start = currentLine;
    const end = currentLine + heights[i]!;
    currentLine = end;
    if (end <= startLine || start >= endLine) continue; // entirely outside the window
    const dropTop = Math.max(0, startLine - start);
    const dropBottom = Math.max(0, end - endLine);
    if (dropTop === 0 && dropBottom === 0) {
      visible.push(messages[i]!);
      continue;
    }
    // This message straddles a fold. Clip it to the rows the window actually allots it. Clipping to a
    // rendered HEIGHT (not a raw source-line count) is essential: MessageRow always re-adds chrome
    // (marginTop + header + >=1 body row, and a border for thinking), so a naive text-line trim can
    // still render TALLER than its slot and overflow the viewport — the exact cause of the scroll
    // garble. clipMessageToHeight returns null when even the chrome floor can't fit; we then drop the
    // message (a blank sliver at the fold, which justifyContent:"flex-end" handles cleanly).
    const slot = Math.min(end, endLine) - Math.max(start, startLine);
    const clipped = clipMessageToHeight(messages[i]!, slot, cols, dropTop, dropBottom);
    if (clipped) visible.push(clipped);
  }

  // Belt-and-suspenders: guarantee the rendered stack never exceeds the viewport. The per-message
  // clip already bounds each child to its disjoint slot (so the sum fits), but any height-parity
  // drift between computeMsgHeight and MessageRow would otherwise re-introduce the overflow → Ink
  // decimation. Trim/drop from the top (oldest) until the sum fits. Because computeMsgHeight >= the
  // real render, `sum <= maxHeight` here implies the actual rendered stack is <= maxHeight too.
  let sum = visible.reduce((n, m) => n + computeMsgHeight(m, cols), 0);
  while (sum > maxHeight && visible.length > 0) {
    const first = visible[0]!;
    const firstH = computeMsgHeight(first, cols);
    const shrunk = clipMessageToHeight(first, firstH - (sum - maxHeight), cols, 1, 0);
    if (shrunk && computeMsgHeight(shrunk, cols) < firstH) visible[0] = shrunk;
    else visible.shift();
    sum = visible.reduce((n, m) => n + computeMsgHeight(m, cols), 0);
  }

  return {
    visible,
    totalHeight,
    atTop: effectiveOffset >= maxOffset,
    atBottom: effectiveOffset === 0,
  };
}

/**
 * Clip `msg` so its rendered height (computeMsgHeight — which INCLUDES the chrome MessageRow always
 * re-adds: marginTop + header + border/padding) is `<= budget` rows, by dropping whole source lines
 * from the fold end(s): `dropTop > 0` keeps a suffix (top scrolled off), `dropBottom > 0` keeps a
 * prefix (bottom scrolled off), both keep a middle slice (a single message taller than the whole
 * viewport). Returns null when even an empty body exceeds `budget` (the role's irreducible chrome
 * floor won't fit) — the caller then leaves the slot blank, which is correct under
 * justifyContent:"flex-end" (a small gap at the fold, never an overflow).
 *
 * Height is strictly monotone as lines are trimmed (each source line renders >= 1 row and per-line
 * rows are position-independent), so every loop terminates at or before the empty body.
 */
function clipMessageToHeight(
  msg: ChatMessage,
  budget: number,
  cols: number,
  dropTop: number,
  dropBottom: number,
): ChatMessage | null {
  if (computeMsgHeight({ ...msg, text: "" }, cols) > budget) return null; // chrome floor won't fit
  const full = computeMsgHeight(msg, cols);
  const lines = msg.text.split("\n");
  let lo = 0;
  let hi = lines.length;
  const heightOf = () => computeMsgHeight({ ...msg, text: lines.slice(lo, hi).join("\n") }, cols);
  // Honor the top fold: drop leading lines until the remaining height reflects `dropTop` rows gone.
  // For a top-fold-only message this trims straight to the budget; for a both-folds message it seats
  // the top of the middle slice before the bottom trim below.
  if (dropTop > 0) {
    const target = full - dropTop;
    while (lo < hi && heightOf() > target) lo++;
  }
  // Honor the bottom fold: drop trailing lines until it fits the budget.
  if (dropBottom > 0) {
    while (lo < hi && heightOf() > budget) hi--;
  }
  // Final safety against any residual over-count: trim from the top until it fits.
  while (lo < hi && heightOf() > budget) lo++;
  return { ...msg, text: lines.slice(lo, hi).join("\n") };
}

// ---------------------------------------------------------------------------
// U2 (MUB-140): sidebar geometry + anchor jumps. REVISED 2026-07-14: the ToC and GT
// sidebars are DOCKED (in-flow) — sidebarGeometry.contentCols feeds the transcript's
// width math, so opening one deliberately reflows the characters-per-line beside it.
// The original absolute-overpaint contract (PanelGeometry + clipPanelLines padding,
// never reflows) survives only for the transient B5 rewind picker.
// ---------------------------------------------------------------------------

/** Below this terminal width the sidebar doesn't open; Ctrl+T falls back to a text block. */
export const TOC_MIN_COLS = 60;

export interface SidebarGeometry {
  /** Total docked sidebar width incl. border(2) + padding(2) columns. */
  sidebarWidth: number;
  /** Transcript columns beside it (cols − sidebarWidth) — feeds getScrollableMessages,
   * computeMsgHeight, offsetForMessage, and every MessageRow while docked. */
  contentCols: number;
  /** Sidebar height — the full chat-region height. */
  height: number;
  /** Text columns inside borders + 1-col padding each side. */
  innerWidth: number;
  /** Text rows inside the borders. */
  innerHeight: number;
}

/**
 * Docked right-sidebar geometry, or null when the terminal is too narrow/short — callers
 * then print the one-shot text block instead (same fallback as the inline renderer).
 * Width caps at 40 and always leaves ≥30 transcript columns beside it.
 */
export function sidebarGeometry(cols: number, regionHeight: number): SidebarGeometry | null {
  if (cols < TOC_MIN_COLS || regionHeight < 5) return null;
  const sidebarWidth = Math.min(40, cols - 30);
  return {
    sidebarWidth,
    contentCols: cols - sidebarWidth,
    height: regionHeight,
    innerWidth: sidebarWidth - 4,
    innerHeight: regionHeight - 2,
  };
}

export interface PanelGeometry {
  /** Columns left of the panel (transcript stays fully visible there). */
  left: number;
  /** Total panel width incl. borders. */
  width: number;
  /** Total panel height incl. borders — always the FULL region height (top- and
   * bottom-aligned coincide, which pins Yoga's absolute static-position ambiguity). */
  height: number;
  /** Text columns inside borders + 1-col padding each side. */
  innerWidth: number;
  /** Text rows inside the borders. */
  innerHeight: number;
}

/**
 * Right-anchored OVERLAY geometry, or null when the terminal is too narrow/short —
 * callers then print the one-shot text block instead. Width caps at 40 and always
 * leaves ≥30 transcript columns visible. Remaining consumer: the B5 rewind picker
 * (the ToC/GT sidebars dock via sidebarGeometry above).
 */
export function tocPanelGeometry(cols: number, regionHeight: number): PanelGeometry | null {
  if (cols < TOC_MIN_COLS || regionHeight < 5) return null;
  const width = Math.min(40, cols - 30);
  const height = regionHeight;
  return { left: cols - width, width, height, innerWidth: width - 4, innerHeight: height - 2 };
}

/**
 * Window `lines` to exactly `innerHeight` rows with `cursorLine` visible: scrolls down
 * only as far as needed (cursor rides the bottom edge when moving down), clamps to the
 * content end, and pads with "" so every panel row paints — an unpainted row would let
 * the transcript underneath bleed through the overpaint.
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

/**
 * The scrollOffset that puts message `k`'s top row at the top of a `maxHeight`-row
 * viewport (the U2 Enter-jump): offset = total − maxHeight − prefix(k), clamped to
 * [0, total − maxHeight]. A `k` inside the last page clamps to 0 — pinned to newest,
 * matching getScrollableMessages' offset semantics exactly.
 */
export function offsetForMessage(
  messages: ChatMessage[],
  k: number,
  maxHeight: number,
  cols: number,
): number {
  let prefix = 0;
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const h = computeMsgHeight(messages[i]!, cols);
    if (i < k) prefix += h;
    total += h;
  }
  const maxOffset = Math.max(0, total - maxHeight);
  return Math.max(0, Math.min(total - maxHeight - prefix, maxOffset));
}
