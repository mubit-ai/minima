/**
 * Pure layout math for the TUI — no React/Ink, so it is unit-testable in isolation.
 *
 * The Ink app renders a fixed-height frame and keeps the scrollable conversation from
 * overflowing the terminal by (1) estimating each message's rendered height, (2) windowing
 * the history to a row budget, and (3) hard-clipping the chat region with overflow:"hidden"
 * as a safety net. These helpers implement (1) and (2).
 *
 * The cardinal rule for the height estimates: they MUST be >= the real rendered rows in
 * messages.tsx (a CONSERVATIVE bias). The window is selected against these estimates and then
 * clipped by the region; an over-estimate merely shows one fewer old line, whereas an
 * under-estimate would let content overflow and (before the clamp) desync Ink's diff — the
 * garbled-overlap bug this module exists to prevent.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "thinking";
  text: string;
  toolName?: string;
  isError?: boolean;
  thoughtDurationSecs?: number;
  /**
   * When true, long output is collapsed to a head/tail preview FOR DISPLAY ONLY (see
   * collapseToolText). Set on agent tool results (bash/read/grep/…) whose full text can flood
   * the transcript; the untouched output still lives in the model context and the DB. Left unset
   * on synthetic UI tool messages (/help, /perms, budget, …) which should always render in full.
   */
  collapsible?: boolean;
}

// ANSI escape sequences (CSI colour/cursor, OSC title, and single 2-byte escapes). Written
// with \x escapes so no literal control byte sits in the source.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control output
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// C0 control bytes + DEL, keeping tab (\x09) and newline (\x0a); \x0d (CR) IS removed since it
// returns the cursor to column 0 and makes later text overwrite earlier text (visible overlap).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control output
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Strip terminal control noise that corrupts Ink's line-based layout — ANSI escapes, carriage
 * returns, and other C0/DEL control bytes — keeping only newlines and tabs. Applied to tool
 * output at DISPLAY time (inline preview and the Ctrl+O pager); the raw bytes are untouched in
 * the model context and the DB.
 */
export function stripControl(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Head/tail line counts kept when collapsing a long tool result for display. */
export const TOOL_PREVIEW_HEAD = 10;
export const TOOL_PREVIEW_TAIL = 5;

/**
 * Collapse long tool output to `head` lines + a "… N more lines" marker + `tail` lines. This is a
 * DISPLAY transform only — callers keep the full text for the model. Returns the input unchanged
 * when collapsing would hide fewer than 2 lines (the marker itself costs a line, so there'd be no
 * saving). Pure and width-agnostic; wrapping is handled downstream by wrappedLineCount/Ink.
 */
export function collapseToolText(
  text: string,
  head: number = TOOL_PREVIEW_HEAD,
  tail: number = TOOL_PREVIEW_TAIL,
): string {
  const lines = text.split("\n");
  const hidden = lines.length - head - tail;
  if (hidden < 2) return text;
  const marker = `… ${hidden} more lines`;
  return [...lines.slice(0, head), marker, ...lines.slice(lines.length - tail)].join("\n");
}

/**
 * The text a tool message actually renders inline: collapsed preview when `collapsible`, else
 * full. The complete output stays reachable via the Ctrl+O pager (see app.tsx), so the inline
 * transcript never has to grow a box taller than the frame.
 */
export function toolDisplayText(msg: ChatMessage): string {
  const clean = stripControl(msg.text);
  return msg.collapsible ? collapseToolText(clean) : clean;
}

export interface PagerView {
  lines: string[];
  start: number; // 0-based index of the first shown line
  end: number; // exclusive index of the last shown line
  total: number;
  atTop: boolean;
  atBottom: boolean;
}

/**
 * Window `text` into at most `bodyRows` lines for the Ctrl+O pager overlay. `scroll` of 0 pins to
 * the bottom (latest output / exit code); increasing it walks toward the top, clamped so it never
 * scrolls past the first line. Each source line counts as exactly one row — the pager truncates
 * long lines rather than wrapping — so the returned slice can never be taller than `bodyRows`,
 * which is what keeps the overlay inside the frame.
 */
export function pagerSlice(text: string, bodyRows: number, scroll: number): PagerView {
  const all = text.split("\n");
  const rows = Math.max(1, bodyRows);
  const maxScroll = Math.max(0, all.length - rows);
  const off = Math.min(Math.max(0, scroll), maxScroll);
  const end = all.length - off;
  const start = Math.max(0, end - rows);
  return {
    lines: all.slice(start, end),
    start,
    end,
    total: all.length,
    atTop: off >= maxScroll,
    atBottom: off === 0,
  };
}

export interface Turn {
  user: ChatMessage;
  subsequent: ChatMessage[];
}

/** Per-turn box chrome in messages.tsx: round border (top+bottom = 2) + marginBottom (1). */
export const TURN_CHROME = 3;

/**
 * Group a flat message list into turns the way messages.tsx renders them: a `user` message
 * opens a turn and following non-user messages attach to it; any non-user message BEFORE the
 * first user message becomes its own (synthetic-user) turn.
 */
export function groupMessagesIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { user: msg, subsequent: [] };
    } else if (currentTurn) {
      currentTurn.subsequent.push(msg);
    } else {
      // Orphaned early (pre-user) message — messages.tsx wraps each in its own turn box.
      turns.push({ user: { role: "user", text: "" }, subsequent: [msg] });
    }
  }
  if (currentTurn) turns.push(currentTurn);
  return turns;
}

/** Wrapped row count of `text` at content `width` (>=1 per source line; floors width at 20). */
export function wrappedLineCount(text: string, width: number): number {
  const w = Math.max(20, width);
  let n = 0;
  for (const line of text.split("\n")) n += Math.max(1, Math.ceil(line.length / w));
  return n;
}

/**
 * Estimated rendered height (rows) of a single message, mirroring messages.tsx's box model.
 * Deliberately conservative (>= actual). The turn-box border/margin is added separately, once
 * per turn, by getScrollableMessages — NOT here.
 */
export function computeMsgHeight(msg: ChatMessage, cols: number): number {
  // Turn box interior width: round border (1 col/side) + paddingX(1) (1 col/side) = cols - 4.
  const interior = cols - 4;
  if (msg.role === "tool") {
    // ⚙ header line (1) + wrapped body. (Was hard-coded to 1 — the worst-offender undercount:
    // /help, /perms, /model lists, etc. are all multi-line tool messages.) Body must match what
    // messages.tsx renders, so honour the same collapse transform here.
    return 1 + wrappedLineCount(toolDisplayText(msg), interior);
  }
  if (msg.role === "thinking") {
    // single border (2) + marginY (2) + header line (1) = 5 chrome; body is paddingLeft={2} => cols-8.
    return 5 + wrappedLineCount(msg.text, cols - 8);
  }
  if (msg.role === "user") {
    // marginBottom (1) + "▸ you" header (1) + body. The body renders as ` ${text} ` (+2 chars).
    const w = Math.max(20, interior);
    let body = 0;
    for (const line of msg.text.split("\n")) body += Math.max(1, Math.ceil((line.length + 2) / w));
    return 2 + body;
  }
  // assistant: marginTop (1) + marginBottom (1) + "◆ assistant" header (1) + markdown body,
  // with +1 per markdown '#' heading (each renders in a marginTop={1} box).
  const headings = msg.text.split("\n").filter((l) => l.trim().startsWith("#")).length;
  return 3 + headings + wrappedLineCount(msg.text, interior);
}

/**
 * Mark which message indices open a turn (see groupMessagesIntoTurns): every `user` message,
 * plus each orphaned non-user message that precedes the first user message.
 */
export function markTurnStarts(messages: ChatMessage[]): boolean[] {
  const starts = new Array<boolean>(messages.length).fill(false);
  let sawUser = false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      starts[i] = true;
      sawUser = true;
    } else if (!sawUser) {
      starts[i] = true; // each leading orphan is its own turn
    }
  }
  return starts;
}

export interface ScrollWindow {
  visible: ChatMessage[];
  totalHeight: number;
  atTop: boolean;
  atBottom: boolean;
}

/**
 * Select the window of messages to render given a row budget and a scroll offset (0 = pinned to
 * the newest). Heights include per-turn chrome (TURN_CHROME on each turn's first message) so the
 * sum tracks the real rendered height. Whole messages are returned; the chat region is rendered
 * bottom-aligned with overflow:"hidden", so any message straddling the top fold is clipped there
 * (oldest content lost first) — no fragile text-slicing here.
 */
export function getScrollableMessages(
  messages: ChatMessage[],
  maxHeight: number,
  scrollOffset: number,
  cols: number,
): ScrollWindow {
  if (messages.length === 0) return { visible: [], totalHeight: 0, atTop: true, atBottom: true };

  const turnStart = markTurnStarts(messages);
  const heights = messages.map(
    (m, i) => computeMsgHeight(m, cols) + (turnStart[i] ? TURN_CHROME : 0),
  );
  const totalHeight = heights.reduce((a, b) => a + b, 0);

  const maxOffset = Math.max(0, totalHeight - maxHeight);
  const effectiveOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const endLine = totalHeight - effectiveOffset;
  const startLine = Math.max(0, endLine - maxHeight);

  let currentLine = 0;
  const visible: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msgEnd = currentLine + heights[i]!;
    if (msgEnd <= startLine) {
      currentLine = msgEnd;
      continue; // entirely above the window
    }
    if (currentLine >= endLine) break; // entirely below the window
    visible.push(messages[i]!); // include whole; region clips the top fold
    currentLine = msgEnd;
  }

  return {
    visible,
    totalHeight,
    atTop: effectiveOffset >= maxOffset,
    atBottom: effectiveOffset === 0,
  };
}
