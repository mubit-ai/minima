import { describe, expect, test } from "bun:test";

import { DEFAULT_KEYMAP } from "../src/tui/keymap.ts";
import { readSource } from "./_source.ts";

// A LAST RESORT (see _source.ts:1-19). resolveBinding itself is tested by behavior in
// keymap.test.ts; what cannot be exercised through bun test is that app.tsx's two key
// handlers actually ASK it. These guards stop a future edit reintroducing an inline chord
// match for one of the ten — the exact regression MUB-232 exists to make impossible.

const app = readSource("tui/app.tsx");
const chord = readSource("tui/editor_chord.ts");

/**
 * `key.ctrl && input === "<letter>"` and its mirror — the shape the registry replaces.
 * A FRESH regex per call: `/g` carries `lastIndex` across `.test()`, so a shared instance
 * would make these assertions order-dependent the first time one of them matched.
 */
const inlineCtrl = () => /key\.ctrl && input === "(\w)"|input === "(\w)" && key\.ctrl/g;

/** Ctrl chords that are NOT bindings and stay hardcoded on purpose. */
const NOT_BINDINGS = new Set(["c", "d", "z"]);

describe("app.tsx asks the registry", () => {
  test("every one of the ten actions has a dispatch site", () => {
    for (const { action } of DEFAULT_KEYMAP) {
      if (action === "editor.open") continue; // dispatched by the latch, not by app.tsx
      expect(app).toContain(`action === "${action}"`);
    }
  });

  test("no inline Ctrl chord matching survives for a bound key", () => {
    const found = [...app.matchAll(inlineCtrl())].map((m) => m[1] ?? m[2]);
    expect(found.length).toBeGreaterThan(0); // the abort/quit/suspend keys are still inline
    for (const letter of found) {
      expect(NOT_BINDINGS.has(letter as string)).toBe(true);
    }
  });

  test("Shift+Tab is no longer matched by hand either", () => {
    expect(app).not.toMatch(/key\.tab\s*&&\s*key\.shift/);
    expect(app).not.toMatch(/key\.shift\s*&&\s*key\.tab/);
  });

  test("the registry is consulted once per dispatch, in both key handlers", () => {
    expect(app.split("const action = resolveBinding(keyEvent(input, key));").length - 1).toBe(2);
  });
});

describe("the $EDITOR latch owns latching, not matching", () => {
  test("editor_chord.ts spells no chord of its own", () => {
    expect(chord).not.toMatch(inlineCtrl());
    expect(chord).not.toMatch(/input === "[xe]"/);
  });

  test("it reads its prefix chord from the registry", () => {
    expect(chord).toContain('prefixChordFor("editor.open")');
  });
});
