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
    expect(
      app.split("const action = resolveBinding(keyEvent(input, key), activeKeymap());").length - 1,
    ).toBe(2);
  });

  test("both handlers resolve against the LOADED keymap, never the default table", () => {
    // The whole point of the keymap file: a dispatch site that named DEFAULT_KEYMAP would
    // ignore it silently, and no behavioural test can see the difference without a file.
    expect(app).not.toContain("DEFAULT_KEYMAP");
  });

  test("the help block prints the effective chords, not hardcoded ones", () => {
    const help = app.slice(app.indexOf("\\n\\nKeyboard:"), app.indexOf("Scroll with your terminal"));
    for (const action of [
      "reply.copy",
      "permission.cycle",
      "thinking.cycle",
      "model.picker",
      "command.palette",
      "route.mode",
      "toc.panel",
      "plan.overview",
      "editor.open",
    ]) {
      expect(help).toContain(`\${keyHelp("${action}")}`);
    }
    // The readline half stays hardcoded — those keys are not bindings.
    expect(help).toContain("Ctrl+C abort run");
  });

  test("no user-visible string spells a bound chord by hand", () => {
    // `/help` also prints the COMMANDS list, and the palette prints it on its own; both used
    // to hardcode `(Ctrl+B)`, `(Ctrl+Y)`, `Ctrl+X Ctrl+E` and `Shift+Tab`. Comment lines are
    // exempt — they describe the code, and a comment cannot lie to a user.
    const spoken = app
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const chord of ["Ctrl+B", "Ctrl+Y", "Ctrl+T", "Ctrl+G", "Ctrl+L", "Shift+Tab"]) {
      expect(spoken).not.toContain(chord);
    }
  });

  test("the footer legend prints the effective chords too", () => {
    // The legend is the only keyboard hint most users ever read; a hardcoded `ctrl+l` there
    // would lie to everyone who rebound the picker, help block or no help block.
    for (const action of [
      "model.picker",
      "route.mode",
      "permission.cycle",
      "thinking.cycle",
      "task.panel",
      "plan.overview",
      "command.palette",
    ]) {
      expect(app).toContain(`{keyLegend("${action}")}`);
    }
    expect(app).not.toMatch(/<Text color="yellow">ctrl\+[a-z] <\/Text>/);
    expect(app).not.toContain('<Text color="yellow">⇧tab </Text>');
  });
});

describe("the $EDITOR latch owns latching, not matching", () => {
  test("editor_chord.ts spells no chord of its own", () => {
    expect(chord).not.toMatch(inlineCtrl());
    expect(chord).not.toMatch(/input === "[xe]"/);
  });

  test("it reads its prefix chord from the registry", () => {
    expect(chord).toContain('prefixChordFor("editor.open", keymap)');
  });

  test("the prefix is looked up per call, not frozen at module load", () => {
    // A module-level constant would be computed before main.ts reads the keymap file, so a
    // rebound sequence would arm on the user's prefix and complete only on Ctrl+E.
    expect(chord).not.toMatch(/^const EDITOR_PREFIX/m);
  });

  test("the app suppresses the sequence's SECOND key, whatever it is bound to", () => {
    // Without this the composer would launch $EDITOR while the app also fired that key's own
    // action — one keypress, two effects. It used to be spelled as a thinking-only guard,
    // which was only ever correct because Ctrl+E is the default second key.
    expect(app).toContain("if (editorChordKey && matchesSecondChord(input, key)) return;");
    expect(app).not.toContain("if (!editorChordKey) cycleThinkingLevel();");
  });
});

describe("the reserved chords mirror their real owner", () => {
  const textInput = readSource("tui/text-input.tsx");
  const loader = readSource("tui/keymap_file.ts");

  test("the readline Ctrl set the loader refuses is the set text-input.tsx actually handles", () => {
    // The loader hand-mirrors another file's key handling; nothing but this pin stops the two
    // drifting apart, and drift here means either a dead binding or a refused legal one.
    const ctrlBlock = textInput.slice(
      textInput.indexOf("if (key.ctrl) {"),
      textInput.indexOf("if (key.meta) {"),
    );
    const handled = new Set([...ctrlBlock.matchAll(/input === "(\w)"/g)].map((m) => m[1]!));
    const refused = new Set(
      (loader.match(/const READLINE_CTRL = new Set\(\[([^\]]*)\]/) as RegExpMatchArray)[1]
        ?.match(/"(\w)"/g)
        ?.map((s) => s.replaceAll('"', "")),
    );
    expect(refused).toEqual(handled);
  });

  test("the readline Alt set matches too", () => {
    const metaBlock = textInput.slice(textInput.indexOf("if (key.meta) {"));
    const handled = new Set([...metaBlock.matchAll(/input === "(\w)"/g)].map((m) => m[1]!));
    const refused = new Set(
      (loader.match(/const READLINE_META = new Set\(\[([^\]]*)\]/) as RegExpMatchArray)[1]
        ?.match(/"(\w)"/g)
        ?.map((s) => s.replaceAll('"', "")),
    );
    expect(refused).toEqual(handled);
  });
});
