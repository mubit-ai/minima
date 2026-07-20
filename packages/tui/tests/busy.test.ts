import { describe, expect, test } from "bun:test";
import {
  SPINNER_FRAMES,
  VERBS,
  councilProgressLine,
  pickVerb,
  spinnerFrame,
} from "../src/tui/busy.tsx";

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

describe("pickVerb", () => {
  test("returns the verb at the index, in order", () => {
    expect(pickVerb(0)).toBe(VERBS[0]!);
    expect(pickVerb(1)).toBe(VERBS[1]!);
  });

  test("wraps around the verb list, tolerating negatives", () => {
    expect(pickVerb(VERBS.length)).toBe(VERBS[0]!);
    expect(pickVerb(-1)).toBe(VERBS[VERBS.length - 1]!);
  });

  test("no verb reuses another tool's signature spinner vocabulary", () => {
    // Guard against reintroducing borrowed spinner words like "thinking"/"working".
    for (const v of VERBS) {
      expect(v).not.toBe("thinking");
      expect(v).not.toBe("working");
    }
  });
});

describe("councilProgressLine — the busy-row council progress string (MP14)", () => {
  test("critic-active matches the guide string byte-exact", () => {
    expect(councilProgressLine("critic")).toBe(
      "council: researcher ✓ · keeper ✓ · critic … · synth ·",
    );
  });
  test("scope folds into an active researcher (prep, not a fifth role)", () => {
    expect(councilProgressLine("scope")).toBe(
      "council: researcher … · keeper · · critic · · synth ·",
    );
    expect(councilProgressLine("research")).toBe(councilProgressLine("scope"));
  });
  test("keeper marks the researcher done", () => {
    expect(councilProgressLine("keeper")).toBe(
      "council: researcher ✓ · keeper … · critic · · synth ·",
    );
  });
  test("synth marks everyone before it done", () => {
    expect(councilProgressLine("synth")).toBe(
      "council: researcher ✓ · keeper ✓ · critic ✓ · synth …",
    );
  });
  test("done marks every role ✓", () => {
    expect(councilProgressLine("done")).toBe(
      "council: researcher ✓ · keeper ✓ · critic ✓ · synth ✓",
    );
  });
});
