import { describe, expect, test } from "bun:test";
import { bellSequence, notify, osc9Sequence, shouldNotifyTurnEnd } from "../src/tui/notify.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Minimal stdout stand-in: records writes, so the impure path is testable without a TTY. */
function fakeStream(isTTY: boolean): {
  isTTY: boolean;
  writes: string[];
  write: (s: string) => boolean;
} {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(s: string) {
      writes.push(s);
      return true;
    },
  };
}

describe("osc9Sequence", () => {
  test("emits ESC ]9; body BEL outside tmux", () => {
    expect(osc9Sequence("done", false)).toBe(`${ESC}]9;done${BEL}`);
  });

  test("wraps in the tmux DCS passthrough with the inner ESC doubled", () => {
    expect(osc9Sequence("done", true)).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;done${BEL}${ESC}\\`);
  });

  test("strips a BEL from the body — a raw BEL would terminate the OSC string early", () => {
    const seq = osc9Sequence(`ok${BEL}rest`, false);
    expect(seq).toBe(`${ESC}]9;okrest${BEL}`);
    // Exactly one BEL in the whole sequence: the terminator.
    expect(seq.split(BEL).length - 1).toBe(1);
  });

  test("strips a raw ESC from the body — the escape-injection guard", () => {
    const seq = osc9Sequence(`ok${ESC}[31mred`, false);
    expect(seq).toBe(`${ESC}]9;ok[31mred${BEL}`);
    expect(seq.split(ESC).length - 1).toBe(1);
  });

  test("strips newlines, tabs, CR, NUL and DEL", () => {
    expect(osc9Sequence("a\nb\tc\rd\x00e\x7ff", false)).toBe(`${ESC}]9;abcdef${BEL}`);
  });

  test("sanitizing happens before the tmux wrap, so the envelope survives", () => {
    const seq = osc9Sequence(`x${BEL}${ESC}y`, true);
    expect(seq).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;xy${BEL}${ESC}\\`);
    // The envelope's own ESCs survive: DCS opener + the doubled inner pair + the ST.
    expect(seq.split(ESC).length - 1).toBe(4);
    expect(seq.split(BEL).length - 1).toBe(1);
  });

  test("caps a long body at 120 chars", () => {
    const seq = osc9Sequence("x".repeat(500), false);
    expect(seq).toBe(`${ESC}]9;${"x".repeat(120)}${BEL}`);
  });

  test("an empty body still produces a well-formed sequence", () => {
    expect(osc9Sequence("", false)).toBe(`${ESC}]9;${BEL}`);
  });
});

describe("bellSequence", () => {
  test("is exactly one BEL byte", () => {
    expect(bellSequence()).toBe(BEL);
  });
});

describe("shouldNotifyTurnEnd", () => {
  test("below the threshold is silent", () => {
    expect(shouldNotifyTurnEnd(9_999, 10_000)).toBe(false);
    expect(shouldNotifyTurnEnd(0, 10_000)).toBe(false);
  });

  test("at or above the threshold fires", () => {
    expect(shouldNotifyTurnEnd(10_000, 10_000)).toBe(true);
    expect(shouldNotifyTurnEnd(60_000, 10_000)).toBe(true);
  });

  test("a threshold of 0 always fires", () => {
    expect(shouldNotifyTurnEnd(0, 0)).toBe(true);
    expect(shouldNotifyTurnEnd(1, 0)).toBe(true);
  });
});

describe("notify", () => {
  test("writes nothing and reports both channels false when stdout is not a TTY", () => {
    const out = fakeStream(false);
    expect(notify("done", out as unknown as NodeJS.WriteStream)).toEqual({
      osc9: false,
      bell: false,
    });
    expect(out.writes).toEqual([]);
  });

  test("writes OSC 9 then BEL on a TTY and reports both channels", () => {
    const out = fakeStream(true);
    expect(notify("done", out as unknown as NodeJS.WriteStream)).toEqual({
      osc9: true,
      bell: true,
    });
    expect(out.writes).toEqual([osc9Sequence("done"), BEL]);
  });

  test("a hostile body is sanitized on the way out — no injected escapes reach the terminal", () => {
    const out = fakeStream(true);
    notify(`edit ${ESC}]0;pwned${BEL} file`, out as unknown as NodeJS.WriteStream);
    // Identical to what an already-clean body would have produced.
    expect(out.writes[0]).toBe(osc9Sequence("edit ]0;pwned file"));
  });

  test("a throwing stream is swallowed, never breaking the hot path", () => {
    const out = {
      isTTY: true,
      write() {
        throw new Error("EPIPE");
      },
    };
    expect(notify("done", out as unknown as NodeJS.WriteStream)).toEqual({
      osc9: false,
      bell: false,
    });
  });
});
