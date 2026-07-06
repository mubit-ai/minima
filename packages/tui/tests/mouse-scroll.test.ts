import { describe, expect, test } from "bun:test";
import { processMouseChunk } from "../src/tui/mouse-scroll.ts";

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
