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
      buffer += str;

      // Extract + dispatch SGR mouse sequences: \u001b[<button;col;row M or m
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is intentional for SGR mouse
      const re = /\u001b\[<(\d+);(-?\d+);(-?\d+)([Mm])/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(buffer)) !== null) {
        const button = Number.parseInt(match[1]!, 10);
        if (button === 64 && scrollCallback) scrollCallback("up");
        else if (button === 65 && scrollCallback) scrollCallback("down");
      }

      // Strip all complete mouse sequences
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is intentional for SGR mouse
      let cleaned = buffer.replace(/\u001b\[<(\d+);(-?\d+);(-?\d+)([Mm])/g, "");

      // Hold back a trailing incomplete escape sequence for the next read
      const escIdx = cleaned.lastIndexOf("\u001b");
      if (escIdx !== -1 && cleaned.length - escIdx < 20) {
        const tail = cleaned.slice(escIdx);
        // If the tail doesn't look like a complete CSI sequence yet, hold it
        if (!/[A-Za-z]/.test(tail)) {
          buffer = tail;
          cleaned = cleaned.slice(0, escIdx);
        } else {
          buffer = "";
        }
      } else {
        buffer = "";
      }

      if (cleaned.length > 0) {
        return typeof chunk === "string" ? cleaned : Buffer.from(cleaned, "utf8");
      }

      // All data was mouse — loop and try read() again until real stdin is drained
    }
  };
}
