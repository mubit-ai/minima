import { describe, expect, test } from "bun:test";

import {
  type BindingAction,
  DEFAULT_KEYMAP,
  keyEvent,
  matchPrefix,
  prefixChordFor,
  resolveBinding,
} from "../src/tui/keymap.ts";

const CTRL_X = { key: "x", ctrl: true } as const;

describe("the default keymap reproduces today's bindings", () => {
  const singles: [BindingAction, string, Record<string, boolean>][] = [
    ["thinking.cycle", "e", { ctrl: true }],
    ["model.picker", "l", { ctrl: true }],
    ["command.palette", "p", { ctrl: true }],
    ["route.mode", "r", { ctrl: true }],
    ["toc.panel", "t", { ctrl: true }],
    ["plan.overview", "g", { ctrl: true }],
    ["task.panel", "b", { ctrl: true }],
    ["reply.copy", "y", { ctrl: true }],
    ["permission.cycle", "", { tab: true, shift: true }],
  ];

  for (const [action, input, flags] of singles) {
    test(`${action} resolves`, () => {
      expect(resolveBinding(keyEvent(input, flags))).toBe(action);
    });
  }

  test("all ten actions are declared exactly once", () => {
    const actions = DEFAULT_KEYMAP.map((b) => b.action);
    expect(actions.length).toBe(10);
    expect(new Set(actions).size).toBe(10);
    expect(new Set(actions)).toEqual(
      new Set([...singles.map(([a]) => a), "editor.open"] as BindingAction[]),
    );
  });

  test("resolution does not depend on declaration order", () => {
    const reversed = [...DEFAULT_KEYMAP].reverse();
    for (const [action, input, flags] of singles) {
      expect(resolveBinding(keyEvent(input, flags), reversed)).toBe(action);
    }
  });
});

describe("the $EDITOR chord is a two-key sequence", () => {
  test("the prefix alone resolves to nothing — Ctrl+X is not an action", () => {
    expect(resolveBinding(keyEvent("x", { ctrl: true }))).toBe(null);
  });

  test("matchPrefix recognises Ctrl+X as a sequence opener", () => {
    expect(matchPrefix(keyEvent("x", { ctrl: true }))).toEqual(CTRL_X);
    expect(matchPrefix(keyEvent("e", { ctrl: true }))).toBe(null);
    expect(matchPrefix(keyEvent("x", {}))).toBe(null);
  });

  test("prefixChordFor exposes the armed chord to the latch", () => {
    expect(prefixChordFor("editor.open")).toEqual(CTRL_X);
    expect(prefixChordFor("toc.panel")).toBe(null);
  });

  test("Ctrl+E completes the sequence only under the Ctrl+X prefix", () => {
    expect(resolveBinding(keyEvent("e", { ctrl: true }, CTRL_X))).toBe("editor.open");
    expect(resolveBinding(keyEvent("e", { ctrl: true }))).toBe("thinking.cycle");
  });

  test("the second key is STRICT — a plain 'e' under the prefix is not the chord", () => {
    expect(resolveBinding(keyEvent("e", {}, CTRL_X))).toBe(null);
  });

  test("a prefixed lookup asks ONE question: does this key complete the sequence?", () => {
    // Not "what else could this key mean" — the latch cancels, and app.tsx (which never
    // sets a prefix) still resolves the key to its own binding on the same dispatch.
    expect(resolveBinding(keyEvent("l", { ctrl: true }, CTRL_X))).toBe(null);
    expect(resolveBinding(keyEvent("l", { ctrl: true }))).toBe("model.picker");
  });
});

describe("everything deliberately left out is unreachable from the registry", () => {
  const readline: [string, Record<string, boolean>][] = [
    ["a", { ctrl: true }],
    ["u", { ctrl: true }],
    ["k", { ctrl: true }],
    ["w", { ctrl: true }],
    ["d", { ctrl: true }],
    ["v", { ctrl: true }],
    ["x", { ctrl: true }],
    ["b", { meta: true }],
    ["f", { meta: true }],
  ];
  for (const [input, flags] of readline) {
    test(`readline ${JSON.stringify(flags)}+${input} is not a binding`, () => {
      expect(resolveBinding(keyEvent(input, flags))).toBe(null);
    });
  }

  test("abort and suspend are not bindings", () => {
    expect(resolveBinding(keyEvent("c", { ctrl: true }))).toBe(null);
    expect(resolveBinding(keyEvent("z", { ctrl: true }))).toBe(null);
    // Ink reports Escape with meta set (see parse-keypress) and a blank input.
    expect(resolveBinding(keyEvent("", { escape: true, meta: true }))).toBe(null);
  });

  test("Enter, arrows and a bare Tab are not bindings", () => {
    expect(resolveBinding(keyEvent("", { return: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { upArrow: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { downArrow: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { leftArrow: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { rightArrow: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { tab: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { backspace: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { delete: true }))).toBe(null);
  });

  test("a printable letter with no modifier is not a binding", () => {
    for (const ch of ["e", "l", "p", "r", "t", "g", "b", "y", "a", "s", "v"]) {
      expect(resolveBinding(keyEvent(ch, {}))).toBe(null);
    }
  });

  test("an empty keymap resolves nothing", () => {
    expect(resolveBinding(keyEvent("e", { ctrl: true }), [])).toBe(null);
  });
});

describe("modifier matching is exact by default", () => {
  test("an undeclared modifier defeats the match", () => {
    expect(resolveBinding(keyEvent("t", { ctrl: true, meta: true }))).toBe(null);
    expect(resolveBinding(keyEvent("t", { ctrl: true, shift: true }))).toBe(null);
  });

  test("a declared modifier is required", () => {
    expect(resolveBinding(keyEvent("t", {}))).toBe(null);
    expect(resolveBinding(keyEvent("", { tab: true, shift: false }))).toBe(null);
  });

  test("a named-key chord ignores `input`, a printable chord requires it", () => {
    expect(resolveBinding(keyEvent("\t", { tab: true, shift: true }))).toBe("permission.cycle");
    expect(resolveBinding(keyEvent("q", { ctrl: true }))).toBe(null);
  });
});

describe("Shift+Tab keeps its loose predicate (the one `looseModifiers` binding)", () => {
  // `key.tab && key.shift` never read ctrl or meta, and unlike the C0 ctrl chords those bits
  // are REAL for a CSI sequence: verified against ink's parse-keypress, Ctrl+Shift+Tab
  // (ESC[1;5Z) and Alt+Shift+Tab (ESC ESC [Z) both arrive as tab+shift with an extra
  // modifier. All three cycled the permission mode before this ticket; all three still do.
  test("Ctrl+Shift+Tab still cycles the mode", () => {
    expect(resolveBinding(keyEvent("", { tab: true, shift: true, ctrl: true }))).toBe(
      "permission.cycle",
    );
  });

  test("Alt+Shift+Tab still cycles the mode", () => {
    expect(resolveBinding(keyEvent("", { tab: true, shift: true, meta: true }))).toBe(
      "permission.cycle",
    );
  });

  test("the DECLARED modifier is still required — a bare Tab is not the chord", () => {
    expect(resolveBinding(keyEvent("", { tab: true }))).toBe(null);
    expect(resolveBinding(keyEvent("", { tab: true, ctrl: true }))).toBe(null);
  });

  test("looseness is opt-in per chord, not a global relaxation", () => {
    expect(DEFAULT_KEYMAP.filter((b) => b.keys.some((c) => c.looseModifiers)).length).toBe(1);
  });
});
