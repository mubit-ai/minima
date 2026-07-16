/**
 * Mouse wheel scroll support for the Ink TUI.
 *
 * main.ts feeds Ink a PassThrough proxy fed from the real TTY's flowing `'data'` stream;
 * `filterMouseChunk` strips SGR mouse escape sequences from each chunk before it reaches Ink.
 *
 * Usage:
 *   import { filterMouseChunk, setMouseScrollCallback } from "./mouse-scroll.ts";
 *   setMouseScrollCallback((dir) => setScrollOffset(...));  // in component mount
 *   stdin.on("data", (c) => proxy.write(filterMouseChunk(c)));  // in main, before render()
 */

// The registered scroll handler; called on each wheel notch.
let scrollCallback: ((direction: "up" | "down") => void) | null = null;

export function setMouseScrollCallback(fn: ((direction: "up" | "down") => void) | null): void {
  scrollCallback = fn;
}

// ESC (0x1b) built without a literal control char in source, so no regex/string control-char lint.
const ESC = String.fromCharCode(27);
// Complete SGR mouse report: ESC [ < button ; col ; row (M|m)
const MOUSE_RE = new RegExp(`${ESC}\\[<(\\d+);(-?\\d+);(-?\\d+)([Mm])`, "g");
// A tail that has STARTED a CSI ("ESC [" + optional "<", digits, ";") but not terminated — hold it
// for the next read. A LONE ESC does NOT match (it's the Escape key) so it passes straight through.
const INCOMPLETE_CSI = new RegExp(`^${ESC}\\[[<\\d;]*$`);

export interface MouseChunkResult {
  /** Bytes to hand to Ink (mouse sequences stripped). */
  output: string;
  /** Incomplete trailing CSI held back for the next read. */
  buffer: string;
  /** Wheel notches detected in this chunk, in order. */
  scrolls: ("up" | "down")[];
}

/**
 * Pure core of the stdin filter: given the previously-held buffer and a new chunk, strip complete
 * SGR mouse sequences (reporting any wheel notches), and hold back only a genuinely-incomplete CSI
 * tail. Crucially, a lone ESC is emitted (never buffered) so the Esc key reaches Ink.
 */
export function processMouseChunk(prevBuffer: string, chunk: string): MouseChunkResult {
  const combined = prevBuffer + chunk;
  const scrolls: ("up" | "down")[] = [];
  MOUSE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MOUSE_RE.exec(combined)) !== null) {
    const button = Number.parseInt(match[1]!, 10);
    if (button === 64) scrolls.push("up");
    else if (button === 65) scrolls.push("down");
  }

  let cleaned = combined.replace(MOUSE_RE, "");
  let buffer = "";
  const escIdx = cleaned.lastIndexOf(ESC);
  if (escIdx !== -1 && cleaned.length - escIdx < 20 && INCOMPLETE_CSI.test(cleaned.slice(escIdx))) {
    buffer = cleaned.slice(escIdx);
    cleaned = cleaned.slice(0, escIdx);
  }
  return { output: cleaned, buffer, scrolls };
}

// Stateful chunk filter for the flowing 'data' input path (main.ts feeds Ink a PassThrough,
// so mouse SGR is stripped here before Ink ever sees it). Returns the bytes to forward.
let dataBuffer = "";
export function filterMouseChunk(chunk: string): string {
  const res = processMouseChunk(dataBuffer, chunk);
  dataBuffer = res.buffer;
  for (const dir of res.scrolls) scrollCallback?.(dir);
  return res.output;
}
