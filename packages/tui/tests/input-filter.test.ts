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
    const s = fresh();
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

describe("splitKeypressUnits (batched-arrows fix)", () => {
  test("three arrows in one chunk become three units (Ink parses one keypress per read)", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits(`${ESC}[D${ESC}[D${ESC}[D`)).toEqual([
      `${ESC}[D`,
      `${ESC}[D`,
      `${ESC}[D`,
    ]);
  });

  test("text runs stay whole (ICRNL 'text\\n' submit path depends on it)", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits("hello\n")).toEqual(["hello\n"]);
    expect(splitKeypressUnits(`ab${ESC}[C cd`)).toEqual(["ab", `${ESC}[C`, " cd"]);
  });

  test("CSI with parameters, SS3, meta+char, and a lone trailing ESC each split correctly", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits(`${ESC}[1;3D`)).toEqual([`${ESC}[1;3D`]); // Option-arrow CSI form
    expect(splitKeypressUnits(`${ESC}OD${ESC}OC`)).toEqual([`${ESC}OD`, `${ESC}OC`]); // DECCKM app mode
    expect(splitKeypressUnits(`${ESC}f`)).toEqual([`${ESC}f`]); // meta word-jump
    expect(splitKeypressUnits(`x${ESC}`)).toEqual(["x", ESC]); // Esc key at chunk end
  });
});

describe("splitKeypressUnits (solo C0 split)", () => {
  const CTRL_X = String.fromCharCode(0x18);
  const CTRL_E = String.fromCharCode(0x05);

  test("Ctrl+X Ctrl+E in ONE chunk becomes two units", async () => {
    // Ink's parse-keypress classifies a control key with `s.length === 1 && s <= '\\x1a'`, so
    // the 2-byte pair matched neither that branch nor any escape regex: it dispatched once
    // with name "" and ctrl false, i.e. NEITHER key registered and the raw bytes were offered
    // to the composer as printable input. tmux/ssh batching produces exactly this chunk.
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits(`${CTRL_X}${CTRL_E}`)).toEqual([CTRL_X, CTRL_E]);
  });

  test("text runs STILL stay whole — re-asserted here so the coupling is visible", async () => {
    // The C0 split must not touch the ICRNL submit path pinned above: \n, \r and \t stay
    // INSIDE the run. If this ever fails, the split's exclusion list is the culprit.
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits("hello\n")).toEqual(["hello\n"]);
    expect(splitKeypressUnits("hello\r")).toEqual(["hello\r"]);
    expect(splitKeypressUnits("hi\tthere")).toEqual(["hi\tthere"]);
  });

  test("a control byte embedded in text splits the run into three units", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    const CTRL_A = String.fromCharCode(0x01);
    expect(splitKeypressUnits(`a${CTRL_A}b`)).toEqual(["a", CTRL_A, "b"]);
  });

  test("a run of control bytes becomes one unit each", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    const u = splitKeypressUnits(`${CTRL_X}${CTRL_X}${CTRL_E}`);
    expect(u).toEqual([CTRL_X, CTRL_X, CTRL_E]);
  });

  test("DEL (0x7f) is deliberately left inside the run — out of scope, same class of bug", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    const DEL = String.fromCharCode(0x7f);
    expect(splitKeypressUnits(`${DEL}${DEL}`)).toEqual([`${DEL}${DEL}`]);
  });

  test("the split composes with escape sequences in the same chunk", async () => {
    const { splitKeypressUnits } = await import("../src/tui/input-filter.ts");
    expect(splitKeypressUnits(`a${CTRL_X}${ESC}[D${CTRL_E}b`)).toEqual([
      "a",
      CTRL_X,
      `${ESC}[D`,
      CTRL_E,
      "b",
    ]);
  });
});

describe("resetInputFilter", () => {
  test("is a safe no-op when the filter was never installed", async () => {
    const { resetInputFilter } = await import("../src/tui/input-filter.ts");
    expect(() => resetInputFilter()).not.toThrow();
  });

  // installInputFilter only replaces `read`, so restoring the saved one fully undoes the
  // patch and the monkey-patch cannot leak into another file of the same `bun test` process.
  interface Harness {
    read: () => unknown;
    /** Bytes the "terminal" makes available; drained to null like a real stream. */
    feed: (...chunks: string[]) => void;
  }

  function withPatchedStdin(fn: (h: Harness) => void): void {
    const stdin = process.stdin as unknown as { read: (size?: number) => unknown };
    const savedRead = stdin.read;
    try {
      const queue: string[] = [];
      stdin.read = () => queue.shift() ?? null;
      fn({
        read: () => stdin.read(),
        feed: (...chunks) => queue.push(...chunks),
      });
    } finally {
      stdin.read = savedRead;
    }
  }

  test("drops a held partial CSI, so a stale prefix cannot fuse with post-editor bytes", async () => {
    const mod = await import("../src/tui/input-filter.ts");
    withPatchedStdin((h) => {
      mod.installInputFilter();
      h.feed(`${ESC}[`);
      expect(h.read()).toBeNull(); // the incomplete CSI is HELD, nothing delivered yet
      mod.resetInputFilter();
      // Without the reset the held `ESC[` would fuse with the next byte into a left arrow.
      h.feed("D");
      expect(h.read()).toBe("D");
    });
  });

  test("drops queued keypress units", async () => {
    const mod = await import("../src/tui/input-filter.ts");
    const CTRL_A = String.fromCharCode(0x01);
    withPatchedStdin((h) => {
      mod.installInputFilter();
      h.feed(`a${CTRL_A}b`);
      expect(h.read()).toBe("a"); // three units queued; one delivered
      mod.resetInputFilter();
      expect(h.read()).toBeNull(); // the remaining two are gone, not replayed
    });
  });

  test("DRAINS bytes already buffered in the real stream", async () => {
    const mod = await import("../src/tui/input-filter.ts");
    withPatchedStdin((h) => {
      mod.installInputFilter();
      h.feed("stale", "bytes"); // typed AT the editor, still sitting in our reader
      mod.resetInputFilter();
      h.feed("fresh");
      expect(h.read()).toBe("fresh");
    });
  });
});

describe("home/end nav side-channel", () => {
  test("every encoding splits to one unit and diverts to the nav consumer", async () => {
    const { consumeNavUnit, setNavCallback, splitKeypressUnits } = await import(
      "../src/tui/input-filter.ts"
    );
    const got: string[] = [];
    setNavCallback((k) => got.push(k));
    try {
      for (const [seq, want] of [
        [`${ESC}[H`, "home"],
        [`${ESC}[F`, "end"],
        [`${ESC}OH`, "home"],
        [`${ESC}OF`, "end"],
        [`${ESC}[1~`, "home"],
        [`${ESC}[4~`, "end"],
        [`${ESC}[7~`, "home"],
        [`${ESC}[8~`, "end"],
      ] as const) {
        expect(splitKeypressUnits(seq)).toEqual([seq]); // one unit — divertable
        expect(consumeNavUnit(seq)).toBe(true);
        expect(got.pop()).toBe(want);
      }
    } finally {
      setNavCallback(null);
    }
  });

  test("without a consumer nothing is diverted; arrows are never nav", async () => {
    const { consumeNavUnit, setNavCallback } = await import("../src/tui/input-filter.ts");
    expect(consumeNavUnit(`${ESC}[H`)).toBe(false); // no consumer registered
    setNavCallback(() => {});
    try {
      expect(consumeNavUnit(`${ESC}[D`)).toBe(false); // plain arrow passes to Ink
      expect(consumeNavUnit("h")).toBe(false);
    } finally {
      setNavCallback(null);
    }
  });
});

describe("click detection (selection-attempt hint)", () => {
  test("button presses count; releases and wheel notches do not", async () => {
    const { processMouseChunk } = await import("../src/tui/input-filter.ts");
    const r = processMouseChunk(
      "",
      `${ESC}[<0;10;10M${ESC}[<0;10;10m${ESC}[<64;5;5M${ESC}[<2;3;3M`,
    );
    expect(r.clicks).toBe(2); // left press + right press; release (m) and wheel excluded
    expect(r.scrolls).toEqual(["up"]);
    expect(r.output).toBe("");
  });

  test("clicks inside a bracketed paste are data, not clicks", async () => {
    const { processInputChunk } = await import("../src/tui/input-filter.ts");
    const start = `${ESC}[200~`;
    const end = `${ESC}[201~`;
    const r = processInputChunk(
      { csiBuffer: "", paste: null },
      `${start}${ESC}[<0;1;1M${end}${ESC}[<0;2;2M`,
    );
    expect(r.pastes).toEqual([`${ESC}[<0;1;1M`]);
    expect(r.clicks).toBe(1); // only the one outside the paste
  });
});
