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
    expect(chordReduce(false, "x", { ctrl: true })).toEqual({ armed: true, action: "arm", consumed: true });
  });

  test("Ctrl+X while already armed re-arms (idempotent), still consumed", () => {
    expect(chordReduce(true, "x", { ctrl: true })).toEqual({ armed: true, action: "arm", consumed: true });
  });

  test("armed + Ctrl+E launches and is consumed", () => {
    expect(chordReduce(true, "e", { ctrl: true })).toEqual({ armed: false, action: "launch", consumed: true });
  });

  test("armed + any other key CANCELS and is NOT consumed (the key still types)", () => {
    expect(chordReduce(true, "a", {})).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
    expect(chordReduce(true, "k", { ctrl: true })).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
  });

  test("a plain (unarmed) Ctrl+E does nothing — thinking still cycles", () => {
    expect(chordReduce(false, "e", { ctrl: true })).toEqual({
      armed: false,
      action: "none",
      consumed: false,
    });
  });

  test("armed + plain 'e' (no ctrl) cancels — the second key is STRICT, for \\C-x\\C-e parity", () => {
    expect(chordReduce(true, "e", {})).toEqual({
      armed: false,
      action: "cancel",
      consumed: false,
    });
  });

  test("idle + any key is inert", () => {
    expect(chordReduce(false, "q", {}).action).toBe("none");
    expect(chordReduce(false, "a", { ctrl: true }).action).toBe("none");
  });
});

describe("the singleton", () => {
  test("arm -> launch fires exactly once, then disarms", () => {
    expect(feedChordKey("x", { ctrl: true }).action).toBe("arm");
    expect(isChordArmed()).toBe(true);
    expect(feedChordKey("e", { ctrl: true }).action).toBe("launch");
    expect(isChordArmed()).toBe(false);
    // A second Ctrl+E is now a plain one.
    expect(feedChordKey("e", { ctrl: true }).action).toBe("none");
  });

  test("Ctrl+X then 'a' cancels with consumed === false", () => {
    feedChordKey("x", { ctrl: true });
    const res = feedChordKey("a", {});
    expect(res.action).toBe("cancel");
    expect(res.consumed).toBe(false);
    expect(isChordArmed()).toBe(false);
  });

  test("re-arming after a cancel works", () => {
    feedChordKey("x", { ctrl: true });
    feedChordKey("a", {});
    expect(feedChordKey("x", { ctrl: true }).action).toBe("arm");
    expect(feedChordKey("e", { ctrl: true }).action).toBe("launch");
  });

  test("resetChord() clears both armed and the latch", () => {
    feedChordKey("x", { ctrl: true });
    resetChord();
    expect(isChordArmed()).toBe(false);
    expect(chordOwnsKey()).toBe(false);
    expect(feedChordKey("e", { ctrl: true }).action).toBe("none");
  });

  test("SAME-CHUNK: both keys dispatched synchronously fire exactly one launch", () => {
    // After the C0 split the two keys arrive back-to-back in ONE handleReadable loop with
    // no re-render between them — this is why the chord is a module singleton, not state.
    const launches: number[] = [];
    for (const input of ["x", "e"] as const) {
      const res = feedChordKey(input, { ctrl: true });
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
    feedChordKey("x", { ctrl: true });
    feedChordKey("e", { ctrl: true });
    expect(chordOwnsKey()).toBe(true);
  });

  test("true when read BEFORE feedChordKey sees Ctrl+E (app ran first, still armed)", () => {
    feedChordKey("x", { ctrl: true });
    expect(chordOwnsKey()).toBe(true);
  });

  test("Ctrl+X itself is owned, so the app never treats it as an unbound ctrl key", () => {
    feedChordKey("x", { ctrl: true });
    expect(chordOwnsKey()).toBe(true);
  });

  test("false for a plain Ctrl+E — thinking cycles exactly as before", () => {
    feedChordKey("e", { ctrl: true });
    expect(chordOwnsKey()).toBe(false);
  });

  test("the latch is ONE-SHOT: cleared after a single read", () => {
    feedChordKey("x", { ctrl: true });
    feedChordKey("e", { ctrl: true });
    expect(chordOwnsKey()).toBe(true);
    expect(chordOwnsKey()).toBe(false);
  });

  test("a cancelled chord does not own the cancelling key", () => {
    feedChordKey("x", { ctrl: true });
    chordOwnsKey(); // the app's read of the Ctrl+X dispatch
    feedChordKey("a", {});
    expect(chordOwnsKey()).toBe(false);
  });
});
