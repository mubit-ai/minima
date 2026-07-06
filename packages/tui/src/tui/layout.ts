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
