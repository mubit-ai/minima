/**
 * Mouse wheel scroll support for the Ink TUI.
 *
 * Ink v5 reads stdin via `'readable'` + `stdin.read()` polling (not `'data'` events).
 * To intercept SGR mouse escape sequences before Ink's parseKeypress sees them,
 * we override `stdin.read()` itself — the exact point Ink pulls data from the stream.
 *
 * Usage:
 *   import { installMouseScrollFilter, setMouseScrollCallback } from "./mouse-scroll.ts";
 *   installMouseScrollFilter();   // call once before render()
 *   setMouseScrollCallback((notches) => setScrollOffset(...));  // in component mount
 *
 * Notches are coalesced (see WHEEL_FLUSH_MS): the callback receives the net notch count of a
 * ~33ms window (positive = up), so a wheel storm costs ~30 React updates/s instead of hundreds.
 */

// The registered scroll handler; receives the NET wheel notches (positive = up) of one
// coalescing window rather than one call per notch.
let scrollCallback: ((notches: number) => void) | null = null;
let pendingNotches = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Wheel coalescing window (ms). A fast wheel/trackpad flick delivers dozens of notches spread
 * across many stdin chunks within tens of ms; forwarding each notch as its own callback forces
 * one full React commit per notch (the fullscreen renderer repaints the whole frame per commit).
 * Leading edge fires immediately — the first notch of a burst has zero added latency — then
 * everything inside the window nets into a single callback (~30 updates/s while scrolling).
 */
export const WHEEL_FLUSH_MS = 33;

function flushNotches(): void {
  const n = pendingNotches;
  pendingNotches = 0;
  if (n !== 0) scrollCallback?.(n);
}

/** Feed one decoded wheel notch into the coalescer. Production caller: the stdin read filter. */
export function enqueueWheelNotch(direction: "up" | "down"): void {
  pendingNotches += direction === "up" ? 1 : -1;
  if (flushTimer === null) {
    flushNotches(); // leading edge
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNotches(); // trailing edge: whatever accumulated during the window
    }, WHEEL_FLUSH_MS);
  }
}

export function setMouseScrollCallback(fn: ((notches: number) => void) | null): void {
  scrollCallback = fn;
  if (fn === null) {
    // Unmount/replace: drop pending notches and the timer so nothing fires into the void.
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    pendingNotches = 0;
  }
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

export function installMouseScrollFilter(): void {
  const stdin = process.stdin;
  const realRead = stdin.read.bind(stdin);
  let buffer = "";

  // Ink calls stdin.setEncoding('utf8'), so read() returns strings.
  // We handle both string and Buffer for safety.
  (stdin as any).read = (size?: number): string | Buffer | null => {
    for (;;) {
      const chunk = realRead(size);
      if (chunk === null || chunk === undefined) return null;

      const str: string = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const res = processMouseChunk(buffer, str);
      buffer = res.buffer;
      for (const dir of res.scrolls) enqueueWheelNotch(dir);

      if (res.output.length > 0) {
        return typeof chunk === "string" ? res.output : Buffer.from(res.output, "utf8");
      }
      // All data was mouse / held — loop and try read() again until real stdin is drained.
    }
  };
}
