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
 *   setMouseScrollCallback((dir) => setScrollOffset(...));  // in component mount
 */

// The registered scroll handler; called on each wheel notch.
let scrollCallback: ((direction: "up" | "down") => void) | null = null;

export function setMouseScrollCallback(fn: ((direction: "up" | "down") => void) | null): void {
  scrollCallback = fn;
}

// Complete SGR mouse sequence: ESC [ < button ; col ; row (M|m).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is intentional for SGR mouse
const MOUSE_SEQ = /\[<(\d+);(-?\d+);(-?\d+)([Mm])/g;
// A trailing fragment worth holding for the next read: ONLY a plausible INCOMPLETE
// SGR mouse prefix — ESC, ESC[, ESC[<, ESC[<digits;… — still awaiting its M/m
// terminator. Anything else (a lone control byte like Ctrl+C 0x03 that landed
// right after a stray ESC, a focus/cursor report, an SS3 arrow) MUST flush
// through. The old "any ESC tail without a letter" rule trapped 0x03 behind a
// held-back ESC[ forever, silently swallowing every Ctrl+C after the terminal
// emitted an escape fragment (e.g. on focus change / suspend-resume).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is intentional for SGR mouse
const MOUSE_PREFIX = /^(\[(<[\d;]*)?)?$/;

/**
 * Pure core of the stdin filter: given the carried-over `buffer` and an `incoming`
 * chunk, dispatch any complete mouse sequences and return the bytes to emit plus
 * the fragment to carry forward. Exported for tests — the installer wraps it.
 */
export function filterMouseChunk(
  buffer: string,
  incoming: string,
): { emit: string; buffer: string; scrolls: ("up" | "down")[] } {
  const combined = buffer + incoming;
  const scrolls: ("up" | "down")[] = [];
  MOUSE_SEQ.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MOUSE_SEQ.exec(combined)) !== null) {
    const button = Number.parseInt(match[1]!, 10);
    if (button === 64) scrolls.push("up");
    else if (button === 65) scrolls.push("down");
  }

  let cleaned = combined.replace(MOUSE_SEQ, "");
  let carry = "";
  const escIdx = cleaned.lastIndexOf("");
  if (escIdx !== -1 && cleaned.length - escIdx < 20 && MOUSE_PREFIX.test(cleaned.slice(escIdx))) {
    carry = cleaned.slice(escIdx);
    cleaned = cleaned.slice(0, escIdx);
  }
  return { emit: cleaned, buffer: carry, scrolls };
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
      const { emit, buffer: carry, scrolls } = filterMouseChunk(buffer, str);
      buffer = carry;
      for (const dir of scrolls) scrollCallback?.(dir);

      if (emit.length > 0) {
        return typeof chunk === "string" ? emit : Buffer.from(emit, "utf8");
      }

      // All data was mouse (or a held-back fragment) — loop and read() again
      // until real stdin is drained.
    }
  };
}
