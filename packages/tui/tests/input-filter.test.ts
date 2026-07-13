import { describe, expect, test } from "bun:test";
import { processMouseChunk } from "../src/tui/input-filter.ts";

const ESC = String.fromCharCode(27);

describe("processMouseChunk", () => {
  test("a lone ESC passes through (regression: Esc key was buffered forever, breaking abort)", () => {
    const r = processMouseChunk("", ESC);
    expect(r.output).toBe(ESC); // emitted to Ink, NOT held
    expect(r.buffer).toBe("");
    expect(r.scrolls).toEqual([]);
  });

  test("a full arrow-key sequence passes through untouched", () => {
    const r = processMouseChunk("", `${ESC}[A`);
    expect(r.output).toBe(`${ESC}[A`);
    expect(r.buffer).toBe("");
  });

  test("strips a wheel-up SGR mouse report and emits a scroll", () => {
    const r = processMouseChunk("", `${ESC}[<64;10;20M`);
    expect(r.scrolls).toEqual(["up"]);
    expect(r.output).toBe("");
  });

  test("wheel-down maps to a down scroll", () => {
    const r = processMouseChunk("", `${ESC}[<65;1;1M`);
    expect(r.scrolls).toEqual(["down"]);
  });

  test("mouse sequence mixed with real input keeps the real bytes", () => {
    const r = processMouseChunk("", `a${ESC}[<64;1;1Mb`);
    expect(r.scrolls).toEqual(["up"]);
    expect(r.output).toBe("ab");
  });

  test("holds an incomplete CSI tail, completes it on the next chunk", () => {
    const first = processMouseChunk("", `${ESC}[<64;10`);
    expect(first.output).toBe(""); // nothing emitted yet
    expect(first.buffer).toBe(`${ESC}[<64;10`); // held
    const second = processMouseChunk(first.buffer, ";20M");
    expect(second.scrolls).toEqual(["up"]);
    expect(second.output).toBe("");
  });

  test("ESC followed by a printable is not treated as an incomplete CSI", () => {
    // "ESC a" — no "[" after ESC, so it must not be held; both bytes pass through.
    const r = processMouseChunk("", `${ESC}a`);
    expect(r.buffer).toBe("");
    expect(r.output).toBe(`${ESC}a`);
  });
});

describe("wheel coalescing", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("leading edge fires immediately; the window nets into one trailing callback", async () => {
    const { setMouseScrollCallback, enqueueWheelNotch, WHEEL_FLUSH_MS } = await import(
      "../src/tui/input-filter.ts"
    );
    const calls: number[] = [];
    setMouseScrollCallback((n) => calls.push(n));

    enqueueWheelNotch("up");
    expect(calls).toEqual([1]); // first notch of a burst: zero added latency

    enqueueWheelNotch("up");
    enqueueWheelNotch("up");
    enqueueWheelNotch("down");
    expect(calls).toEqual([1]); // still inside the window — accumulated, not forwarded

    await sleep(WHEEL_FLUSH_MS + 20);
    expect(calls).toEqual([1, 1]); // trailing edge: net of up+up+down after the leading up
    setMouseScrollCallback(null);
  });

  test("all-cancelling notches inside the window produce no trailing callback", async () => {
    const { setMouseScrollCallback, enqueueWheelNotch, WHEEL_FLUSH_MS } = await import(
      "../src/tui/input-filter.ts"
    );
    const calls: number[] = [];
    setMouseScrollCallback((n) => calls.push(n));

    enqueueWheelNotch("down"); // leading edge: -1
    enqueueWheelNotch("up");
    enqueueWheelNotch("down");
    enqueueWheelNotch("up");
    enqueueWheelNotch("down");
    await sleep(WHEEL_FLUSH_MS + 20);
    expect(calls).toEqual([-1]); // the four windowed notches net to 0 → trailing suppressed
    setMouseScrollCallback(null);
  });

  test("unsetting the callback clears the timer and pending notches (no leak, no late fire)", async () => {
    const { setMouseScrollCallback, enqueueWheelNotch, WHEEL_FLUSH_MS } = await import(
      "../src/tui/input-filter.ts"
    );
    const calls: number[] = [];
    setMouseScrollCallback((n) => calls.push(n));

    enqueueWheelNotch("up");
    enqueueWheelNotch("up");
    setMouseScrollCallback(null); // unmount mid-window
    await sleep(WHEEL_FLUSH_MS + 20);
    expect(calls).toEqual([1]); // only the leading edge; nothing fired after unset

    // A fresh subscriber starts clean — no stale notches from before the unset.
    setMouseScrollCallback((n) => calls.push(n));
    enqueueWheelNotch("down");
    expect(calls).toEqual([1, -1]);
    setMouseScrollCallback(null);
  });
});

describe("processInputChunk (bracketed paste)", () => {
  const start = `${ESC}[200~`;
  const end = `${ESC}[201~`;
  const fresh = () => ({ csiBuffer: "", paste: null });

  test("a whole paste in one chunk is captured, not passed to Ink", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    const r = processInputChunk(fresh(), `${start}hello\nworld\n${end}`);
    expect(r.pastes).toEqual(["hello\nworld\n"]);
    expect(r.output).toBe("");
    expect(r.state).toEqual(fresh());
  });

  test("a paste spanning chunks — split start marker, body, split end marker — assembles", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    let s = fresh();
    let r = processInputChunk(s, `typed${ESC}[200`); // split start marker held
    expect(r.output).toBe("typed");
    r = processInputChunk(r.state, "~line one\nline ");
    expect(r.output).toBe("");
    expect(r.pastes).toEqual([]);
    r = processInputChunk(r.state, `two${ESC}[201`); // split end marker held in the paste
    expect(r.pastes).toEqual([]);
    r = processInputChunk(r.state, "~after");
    expect(r.pastes).toEqual(["line one\nline two"]);
    expect(r.output).toBe("after");
    expect(r.state.paste).toBeNull();
  });

  test("ESC and mouse sequences INSIDE a paste are data, not keys/scrolls", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    const body = `has ${ESC} escape and ${ESC}[<64;1;1M wheel bytes`;
    const r = processInputChunk(fresh(), `${start}${body}${end}`);
    expect(r.pastes).toEqual([body]);
    expect(r.scrolls).toEqual([]);
  });

  test("wheel sequences outside a paste still scroll; lone ESC still passes (abort regression)", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    const r = processInputChunk(fresh(), `${ESC}[<64;1;1M${ESC}${start}x${end}${ESC}[<65;1;1M`);
    expect(r.scrolls).toEqual(["up", "down"]);
    expect(r.output).toBe(ESC);
    expect(r.pastes).toEqual(["x"]);
  });

  test("two pastes in one chunk both deliver, with the text between them intact", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    const r = processInputChunk(fresh(), `${start}a${end}mid${start}b${end}tail`);
    expect(r.pastes).toEqual(["a", "b"]);
    expect(r.output).toBe("midtail");
  });
});
