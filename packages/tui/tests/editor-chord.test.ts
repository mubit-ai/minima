import { beforeEach, describe, expect, test } from "bun:test";

import {
  CHORD_BYTES,
  chordOwnsKey,
  chordReduce,
  feedChordKey,
  isChordArmed,
  resetChord,
} from "../src/tui/editor_chord.ts";

beforeEach(() => resetChord());

describe("chordReduce (pure)", () => {
  test("Ctrl+X arms and is consumed", () => {
    expect(chordReduce(false, "x", true)).toEqual({ armed: true, action: "arm", consumed: true });
  });

  test("Ctrl+X while already armed re-arms (idempotent), still consumed", () => {
    expect(chordReduce(true, "x", true)).toEqual({ armed: true, action: "arm", consumed: true });
  });

  test("armed + Ctrl+E launches and is consumed", () => {
    expect(chordReduce(true, "e", true)).toEqual({ armed: false, action: "launch", consumed: true });
  });

  test("armed + any other key CANCELS and is NOT consumed (the key still types)", () => {
    expect(chordReduce(true, "a", false)).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
    expect(chordReduce(true, "k", true)).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
  });

  test("a plain (unarmed) Ctrl+E does nothing — thinking still cycles", () => {
    expect(chordReduce(false, "e", true)).toEqual({
      armed: false,
      action: "none",
      consumed: false,
    });
  });

  test("armed + plain 'e' (no ctrl) cancels — the second key is STRICT, for \\C-x\\C-e parity", () => {
    expect(chordReduce(true, "e", false)).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
  });

  test("idle + any key is inert", () => {
    expect(chordReduce(false, "q", false).action).toBe("none");
    expect(chordReduce(false, "a", true).action).toBe("none");
  });
});

describe("the singleton", () => {
  test("arm -> launch fires exactly once, then disarms", () => {
    expect(feedChordKey("x", true).action).toBe("arm");
    expect(isChordArmed()).toBe(true);
    expect(feedChordKey("e", true).action).toBe("launch");
    expect(isChordArmed()).toBe(false);
    // A second Ctrl+E is now a plain one.
    expect(feedChordKey("e", true).action).toBe("none");
  });

  test("Ctrl+X then 'a' cancels with consumed === false", () => {
    feedChordKey("x", true);
    const res = feedChordKey("a", false);
    expect(res.action).toBe("cancel");
    expect(res.consumed).toBe(false);
    expect(isChordArmed()).toBe(false);
  });

  test("re-arming after a cancel works", () => {
    feedChordKey("x", true);
    feedChordKey("a", false);
    expect(feedChordKey("x", true).action).toBe("arm");
    expect(feedChordKey("e", true).action).toBe("launch");
  });

  test("resetChord() clears both armed and the latch", () => {
    feedChordKey("x", true);
    resetChord();
    expect(isChordArmed()).toBe(false);
    expect(chordOwnsKey()).toBe(false);
    expect(feedChordKey("e", true).action).toBe("none");
  });

  test("SAME-CHUNK: both keys dispatched synchronously fire exactly one launch", () => {
    // After the C0 split the two keys arrive back-to-back in ONE handleReadable loop with
    // no re-render between them — this is why the chord is a module singleton, not state.
    const launches: number[] = [];
    for (const [input, ctrl] of [
      ["x", true],
      ["e", true],
    ] as const) {
      const res = feedChordKey(input, ctrl);
      if (res.action === "launch") launches.push(1);
    }
    expect(launches.length).toBe(1);
  });

  test("the raw bytes a terminal sends are Ctrl+X = 0x18 and Ctrl+E = 0x05", () => {
    expect(CHORD_BYTES.ctrlX.charCodeAt(0)).toBe(0x18);
    expect(CHORD_BYTES.ctrlE.charCodeAt(0)).toBe(0x05);
  });
});

describe("chordOwnsKey — the order-independent latch", () => {
  test("true when read AFTER feedChordKey consumed the key (composer ran first)", () => {
    feedChordKey("x", true);
    feedChordKey("e", true);
    expect(chordOwnsKey()).toBe(true);
  });

  test("true when read BEFORE feedChordKey sees Ctrl+E (app ran first, still armed)", () => {
    feedChordKey("x", true);
    expect(chordOwnsKey()).toBe(true);
  });

  test("Ctrl+X itself is owned, so the app never treats it as an unbound ctrl key", () => {
    feedChordKey("x", true);
    expect(chordOwnsKey()).toBe(true);
  });

  test("false for a plain Ctrl+E — thinking cycles exactly as before", () => {
    feedChordKey("e", true);
    expect(chordOwnsKey()).toBe(false);
  });

  test("the latch is ONE-SHOT: cleared after a single read", () => {
    feedChordKey("x", true);
    feedChordKey("e", true);
    expect(chordOwnsKey()).toBe(true);
    expect(chordOwnsKey()).toBe(false);
  });

  test("a cancelled chord does not own the cancelling key", () => {
    feedChordKey("x", true);
    chordOwnsKey(); // the app's read of the Ctrl+X dispatch
    feedChordKey("a", false);
    expect(chordOwnsKey()).toBe(false);
  });
});
