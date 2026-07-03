import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, spinnerFrame } from "../src/tui/busy.tsx";

describe("spinnerFrame", () => {
  test("returns the frame at the tick, in order", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]!);
    expect(spinnerFrame(1)).toBe(SPINNER_FRAMES[1]!);
  });

  test("wraps around the frame list", () => {
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]!);
    expect(spinnerFrame(SPINNER_FRAMES.length + 2)).toBe(SPINNER_FRAMES[2]!);
  });

  test("tolerates negative ticks", () => {
    expect(spinnerFrame(-1)).toBe(SPINNER_FRAMES[SPINNER_FRAMES.length - 1]!);
  });
});
