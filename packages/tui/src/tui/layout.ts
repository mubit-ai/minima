/**
 * Pure layout math for the small LIVE region of the TUI — no React/Ink, so it is unit-testable in
 * isolation.
 *
 * The finalized transcript is NOT managed here: it renders via Ink's <Static> (see app.tsx /
 * messages.tsx), printed once into the terminal's native scrollback and never re-diffed — so there
 * is no history-windowing or region-clipping math anymore. What remains are the helpers for the
 * parts Ink still re-diffs every frame:
 *   - wrappedLineCount   — input-box height as the typed text wraps
 *   - tailToFit          — the last lines of a streaming reply that fit the live area
 *   - clampToolText      — bound a huge tool result so the (still-diffed) preview can't dwarf the screen
 *   - markdownBodyHeight — rendered rows of a markdown body, mirroring MarkdownRenderer
 *
 * The cardinal rule for these estimates: they MUST be >= the real rendered rows in messages.tsx (a
 * CONSERVATIVE bias). An under-count would let the live region grow past the space reserved for it
 * and desync Ink's cursor-relative frame diff — the garbled-overlap class of bug this module guards.
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
  return lines.slice(start).join("\n");
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
    // Trim the parts of a boundary message that fall outside the window so NO rendered message is
    // taller than the viewport. Stock Ink garbles a single child taller than an overflow:"hidden"
    // flex-end box (negative offset), but renders cleanly once content fits — so we clip the fold.
    // Dropping whole TEXT lines (each >= 1 rendered row) is a conservative over-trim that can never
    // leave the content overflowing.
    const dropTop = Math.max(0, startLine - start);
    const dropBottom = Math.max(0, end - endLine);
    visible.push(
      dropTop || dropBottom ? clipMessageRows(messages[i]!, dropTop, dropBottom) : messages[i]!,
    );
  }

  return {
    visible,
    totalHeight,
    atTop: effectiveOffset >= maxOffset,
    atBottom: effectiveOffset === 0,
  };
}

/** Drop `dropTop` leading and `dropBottom` trailing TEXT lines from a message (fold-clipping). */
function clipMessageRows(msg: ChatMessage, dropTop: number, dropBottom: number): ChatMessage {
  let lines = msg.text.split("\n");
  if (dropTop > 0) lines = lines.slice(dropTop);
  if (dropBottom > 0) lines = lines.slice(0, Math.max(0, lines.length - dropBottom));
  return { ...msg, text: lines.join("\n") };
}
