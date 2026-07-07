import { describe, expect, test } from "bun:test";
import { filterMouseChunk } from "../src/tui/mouse-scroll.ts";

const ESC = "\x1b";
const ETX = "\x03"; // Ctrl+C

describe("filterMouseChunk", () => {
  test("passes a bare Ctrl+C straight through", () => {
    const r = filterMouseChunk("", ETX);
    expect(r.emit).toBe(ETX);
    expect(r.buffer).toBe("");
    expect(r.scrolls).toEqual([]);
  });

  test("REGRESSION: Ctrl+C after a held-back ESC[ fragment is never swallowed", () => {
    // Terminal emits a stray CSI intro (e.g. a focus/cursor fragment on resume)...
    const first = filterMouseChunk("", `${ESC}[`);
    expect(first.emit).toBe(""); // held back as a possible mouse prefix
    expect(first.buffer).toBe(`${ESC}[`);

    // ...then the user hits Ctrl+C. It MUST flush, not get trapped behind the ESC[.
    const second = filterMouseChunk(first.buffer, ETX);
    expect(second.emit).toContain(ETX);
    expect(second.buffer).toBe(""); // nothing left stuck in the buffer
  });

  test("dispatches a complete scroll-up sequence and emits nothing", () => {
    const r = filterMouseChunk("", `${ESC}[<64;10;20M`);
    expect(r.scrolls).toEqual(["up"]);
    expect(r.emit).toBe("");
  });

  test("dispatches scroll-down", () => {
    expect(filterMouseChunk("", `${ESC}[<65;1;1M`).scrolls).toEqual(["down"]);
  });

  test("reassembles a mouse sequence split across two reads", () => {
    const a = filterMouseChunk("", `${ESC}[<64;10`);
    expect(a.emit).toBe(""); // incomplete prefix held
    expect(a.buffer).toBe(`${ESC}[<64;10`);
    const b = filterMouseChunk(a.buffer, ";20M");
    expect(b.scrolls).toEqual(["up"]);
    expect(b.emit).toBe("");
  });

  test("ordinary keystrokes pass through untouched", () => {
    const r = filterMouseChunk("", "hello");
    expect(r.emit).toBe("hello");
    expect(r.buffer).toBe("");
  });

  test("an SS3 arrow (ESC O A) is not trapped", () => {
    const r = filterMouseChunk("", `${ESC}OA`);
    expect(r.emit).toBe(`${ESC}OA`);
    expect(r.buffer).toBe("");
  });

  test("Ctrl+C mixed with a real scroll: scroll dispatched, Ctrl+C emitted", () => {
    const r = filterMouseChunk("", `${ESC}[<64;5;5M${ETX}`);
    expect(r.scrolls).toEqual(["up"]);
    expect(r.emit).toBe(ETX);
  });
});
