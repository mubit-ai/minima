/**
 * The stdin input filter for the Ink TUI: mouse wheel scroll + bracketed paste.
 *
 * Ink v5 reads stdin via `'readable'` + `stdin.read()` polling (not `'data'` events).
 * To intercept SGR mouse escapes and bracketed-paste blocks before Ink's parseKeypress
 * sees them, we override `stdin.read()` itself — the exact point Ink pulls data.
 *
 * Usage:
 *   import { installInputFilter, setMouseScrollCallback, setPasteCallback } from "./input-filter.ts";
 *   installInputFilter();   // call once before render()
 *   setMouseScrollCallback((notches) => setScrollOffset(...));  // in component mount
 *   setPasteCallback((text) => insertIntoDraft(text));          // in the text input
 *
 * Wheel notches are coalesced (see WHEEL_FLUSH_MS): the callback receives the net notch
 * count of a ~33ms window (positive = up), so a storm costs ~30 React updates/s.
 *
 * A bracketed paste (ESC[200~ … ESC[201~, sent by the terminal when ?2004h is set) is
 * captured whole — even split across many stdin chunks — and delivered as ONE event, so
 * a pasted block can never leak keypresses (its trailing newline used to auto-submit the
 * prompt, and any ESC inside pasted text used to abort the turn). With no paste consumer
 * registered, the inner text passes through to Ink markerless.
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

// -- bracketed paste --------------------------------------------------------------------------

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** Runaway guard: a "paste" this large with no end marker flushes through as plain input. */
const PASTE_MAX = 8 * 1024 * 1024;

// The registered paste consumer. With none registered, paste content passes through to Ink
// (markers stripped) — degraded but never lost.
let pasteCallback: ((text: string) => void) | null = null;

export function setPasteCallback(fn: ((text: string) => void) | null): void {
  pasteCallback = fn;
}

export interface InputFilterState {
  /** Incomplete trailing CSI held back for the next read (outside a paste). */
  csiBuffer: string;
  /** Non-null while inside a bracketed paste: content accumulated so far. */
  paste: string | null;
}

export interface InputChunkResult {
  /** Bytes to hand to Ink (mouse sequences and paste blocks stripped). */
  output: string;
  state: InputFilterState;
  /** Wheel notches detected, in order. */
  scrolls: ("up" | "down")[];
  /** Complete bracketed pastes captured in this chunk, in order. */
  pastes: string[];
}

/**
 * Pure outer layer of the stdin filter: extract bracketed-paste blocks FIRST (content inside
 * a paste is data — mouse sequences, ESC, newlines in it must never be interpreted), then run
 * the mouse filter over the non-paste segments. Both layers hold incomplete tails across
 * chunks: a split paste marker rides csiBuffer (it matches the incomplete-CSI shape), and an
 * unterminated paste body accumulates in `paste` until its end marker arrives.
 */
export function processInputChunk(state: InputFilterState, chunk: string): InputChunkResult {
  const scrolls: ("up" | "down")[] = [];
  const pastes: string[] = [];
  let output = "";
  let csi = state.csiBuffer;
  let paste = state.paste;
  let rest = chunk;

  for (;;) {
    if (paste !== null) {
      const acc = paste + rest;
      const end = acc.indexOf(PASTE_END);
      if (end === -1) {
        if (acc.length > PASTE_MAX) {
          output += acc; // runaway guard: not a real paste — flush as plain input
          paste = null;
          break;
        }
        paste = acc; // still inside the paste — hold everything
        break;
      }
      pastes.push(acc.slice(0, end));
      paste = null;
      rest = acc.slice(end + PASTE_END.length);
      continue;
    }

    const seg = csi + rest;
    csi = "";
    const start = seg.indexOf(PASTE_START);
    const pre = start === -1 ? seg : seg.slice(0, start);
    const m = processMouseChunk("", pre);
    output += m.output;
    scrolls.push(...m.scrolls);
    if (start === -1) {
      csi = m.buffer;
      break;
    }
    // Anything the mouse filter held right before a paste marker can't complete — emit it.
    output += m.buffer;
    paste = "";
    rest = seg.slice(start + PASTE_START.length);
  }

  return { output, state: { csiBuffer: csi, paste }, scrolls, pastes };
}

export function installInputFilter(): void {
  const stdin = process.stdin;
  const realRead = stdin.read.bind(stdin);
  let state: InputFilterState = { csiBuffer: "", paste: null };

  // Ink calls stdin.setEncoding('utf8'), so read() returns strings.
  // We handle both string and Buffer for safety.
  (stdin as any).read = (size?: number): string | Buffer | null => {
    for (;;) {
      const chunk = realRead(size);
      if (chunk === null || chunk === undefined) return null;

      const str: string = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const res = processInputChunk(state, str);
      state = res.state;
      for (const dir of res.scrolls) enqueueWheelNotch(dir);
      let output = res.output;
      for (const p of res.pastes) {
        if (pasteCallback) pasteCallback(p);
        else output += p; // no consumer: inner text passes through, markers stripped
      }

      if (output.length > 0) {
        return typeof chunk === "string" ? output : Buffer.from(output, "utf8");
      }
      // All data was mouse / paste / held — loop and try read() again until stdin is drained.
    }
  };
}
