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

import stringWidth from "string-width";

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "thinking";
  text: string;
  toolName?: string;
  isError?: boolean;
  thoughtDurationSecs?: number;
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

/**
 * Wrapped row count of `text` at content `width` (>=1 per source line; floors width at 20).
 * Uses display columns (stringWidth) — the same measure Ink wraps by — so emoji/CJK (💡🧠⚙◆▸)
 * count as 2 cols and the estimate stays >= the real rendered rows.
 */
export function wrappedLineCount(text: string, width: number): number {
  const w = Math.max(20, width);
  let n = 0;
  for (const line of text.split("\n")) n += Math.max(1, Math.ceil(stringWidth(line) / w));
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
    // /help, /perms, /model lists, etc. are all multi-line tool messages.)
    return 1 + wrappedLineCount(msg.text, interior);
  }
  if (msg.role === "thinking") {
    // single border (2) + marginY (2) + header line (1) = 5 chrome; body is paddingLeft={2} => cols-8.
    return 5 + wrappedLineCount(msg.text, cols - 8);
  }
  if (msg.role === "user") {
    // marginBottom (1) + "▸ you" header (1) + body. The body renders as ` ${text} ` (+2 chars).
    const w = Math.max(20, interior);
    let body = 0;
    for (const line of msg.text.split("\n"))
      body += Math.max(1, Math.ceil((stringWidth(line) + 2) / w));
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
