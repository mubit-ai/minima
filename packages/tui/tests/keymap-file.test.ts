import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chordReduce, feedChordKey, resetChord } from "../src/tui/editor_chord.ts";
import { DEFAULT_KEYMAP, describeKeys, keyEvent, resolveBinding } from "../src/tui/keymap.ts";
import {
  activeKeymap,
  initKeymap,
  keymapPath,
  keymapProblems,
  loadKeymap,
  parseKeymap,
  resetKeymapState,
} from "../src/tui/keymap_file.ts";

// The seam is the SAME pure resolveBinding — every assertion below asks which action a key
// resolves to, never what the parse tree looked like. Ctrl+N/O/F/Q are the chords used as
// "some free key": they are neither defaults nor readline's, and none of them is a C0 byte a
// terminal reports as a named key (Ctrl+I/M/H arrive as Tab/Enter/Backspace, so a keymap that
// named them would be a lie about what the terminal sends).

const ctrl = (k: string) => keyEvent(k, { ctrl: true });
const alt = (k: string) => keyEvent(k, { meta: true });

/** Load a keymap from TOML text and assert it produced no problems. */
function clean(toml: string) {
  const { keymap, problems } = parseKeymap(toml);
  expect(problems).toEqual([]);
  return keymap;
}

describe("no keymap file — today's behaviour, unchanged", () => {
  test("a missing file loads the defaults with nothing to report", () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-keymap-none-"));
    try {
      const { keymap, problems } = loadKeymap({ enabled: true, path: join(dir, "keymap.toml") });
      expect(keymap).toBe(DEFAULT_KEYMAP);
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty file is not an error", () => {
    expect(clean("")).toBe(DEFAULT_KEYMAP);
    expect(clean("[keys]\n")).toBe(DEFAULT_KEYMAP);
  });
});

describe("rebinding the ten actions", () => {
  test("a rebound chord resolves to its action and the vacated one to nothing", () => {
    const km = clean('[keys]\n"toc.panel" = "ctrl+n"\n');
    expect(resolveBinding(ctrl("n"), km)).toBe("toc.panel");
    expect(resolveBinding(ctrl("t"), km)).toBe(null);
  });

  test("unlisted actions keep their defaults", () => {
    const km = clean('[keys]\n"toc.panel" = "ctrl+n"\n');
    expect(resolveBinding(ctrl("e"), km)).toBe("thinking.cycle");
    expect(resolveBinding(ctrl("y"), km)).toBe("reply.copy");
    expect(resolveBinding(keyEvent("", { tab: true, shift: true }), km)).toBe("permission.cycle");
  });

  test("the [keys] table is optional — top-level entries work too", () => {
    const km = clean('"model.picker" = "alt+m"\n');
    expect(resolveBinding(alt("m"), km)).toBe("model.picker");
    expect(resolveBinding(ctrl("l"), km)).toBe(null);
  });

  test("Alt is spelled alt/option/meta, Ctrl is ctrl/control, and case is free", () => {
    for (const spelling of ["alt+n", "Option+N", "META+n", "opt+n"]) {
      const km = clean(`[keys]\n"task.panel" = "${spelling}"\n`);
      expect(resolveBinding(alt("n"), km)).toBe("task.panel");
    }
    for (const spelling of ["ctrl+n", "Control+N"]) {
      const km = clean(`[keys]\n"task.panel" = "${spelling}"\n`);
      expect(resolveBinding(ctrl("n"), km)).toBe("task.panel");
    }
  });

  test("modifiers stay exact — Ctrl+Alt+F is not the Ctrl+F binding", () => {
    const km = clean('[keys]\n"task.panel" = "ctrl+f"\n');
    expect(resolveBinding(keyEvent("f", { ctrl: true, meta: true }), km)).toBe(null);
    const both = clean('[keys]\n"task.panel" = "ctrl+alt+f"\n');
    expect(resolveBinding(keyEvent("f", { ctrl: true, meta: true }), both)).toBe("task.panel");
    expect(resolveBinding(ctrl("f"), both)).toBe(null);
  });

  test("restating Shift+Tab keeps the loose modifier matching its CSI bits need", () => {
    const km = clean('[keys]\n"permission.cycle" = "shift+tab"\n');
    // Ctrl+Shift+Tab (ESC[1;5Z) and Alt+Shift+Tab reach Ink as tab+shift with ctrl/meta set.
    expect(resolveBinding(keyEvent("", { tab: true, shift: true, ctrl: true }), km)).toBe(
      "permission.cycle",
    );
    expect(resolveBinding(keyEvent("", { tab: true, shift: true, meta: true }), km)).toBe(
      "permission.cycle",
    );
  });

  test("two actions may swap keys — that is not a conflict", () => {
    const km = clean('[keys]\n"toc.panel" = "ctrl+y"\n"reply.copy" = "ctrl+t"\n');
    expect(resolveBinding(ctrl("y"), km)).toBe("toc.panel");
    expect(resolveBinding(ctrl("t"), km)).toBe("reply.copy");
  });
});

describe("the $EDITOR sequence", () => {
  test("a rebound sequence arms on its own prefix and launches on its own second key", () => {
    const km = clean('[keys]\n"editor.open" = "ctrl+q ctrl+o"\n');
    expect(chordReduce(false, "q", { ctrl: true }, km)).toEqual({
      armed: true,
      action: "arm",
      consumed: true,
    });
    expect(chordReduce(true, "o", { ctrl: true }, km)).toEqual({
      armed: false,
      action: "launch",
      consumed: true,
    });
    // The vacated Ctrl+X no longer arms anything.
    expect(chordReduce(false, "x", { ctrl: true }, km).action).toBe("none");
  });

  test("a sequence chord may carry shift or meta — the latch sees the whole key", () => {
    const km = clean('[keys]\n"editor.open" = "alt+q ctrl+o"\n');
    expect(chordReduce(false, "q", { meta: true }, km).action).toBe("arm");
    expect(chordReduce(false, "q", { ctrl: true }, km).action).toBe("none");
  });

  test("editor.open may be a single chord — it launches with no prefix at all", () => {
    const km = clean('[keys]\n"editor.open" = "ctrl+o"\n');
    expect(chordReduce(false, "o", { ctrl: true }, km)).toEqual({
      armed: false,
      action: "launch",
      consumed: true,
    });
    expect(chordReduce(false, "x", { ctrl: true }, km).action).toBe("none");
  });

  test("only editor.open may be a two-key sequence", () => {
    const { keymap, problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+q ctrl+o"\n');
    expect(problems.join("\n")).toContain("toc.panel");
    expect(problems.join("\n")).toContain("two-key sequence");
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel"); // default kept
  });

  test("a sequence's prefix conflicting with a single chord is a conflict", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+x"\n');
    expect(problems.join("\n")).toContain("Ctrl+X");
    expect(problems.join("\n")).toContain("editor.open");
  });
});

describe("conflicts are reported, never silently resolved", () => {
  test("two actions on one chord: both are named and both keep their defaults", () => {
    const { keymap, problems } = parseKeymap(
      '[keys]\n"toc.panel" = "ctrl+n"\n"reply.copy" = "ctrl+n"\n',
    );
    const report = problems.join("\n");
    expect(report).toContain("Ctrl+N");
    expect(report).toContain("toc.panel");
    expect(report).toContain("reply.copy");
    expect(resolveBinding(ctrl("n"), keymap)).toBe(null);
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
    expect(resolveBinding(ctrl("y"), keymap)).toBe("reply.copy");
  });

  test("a rebind that lands on another action's untouched default conflicts too", () => {
    const { keymap, problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+y"\n');
    expect(problems.join("\n")).toContain("reply.copy");
    expect(resolveBinding(ctrl("y"), keymap)).toBe("reply.copy");
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
  });

  test("a revert that re-collides is resolved too — the map never ends up ambiguous", () => {
    // plan.overview and reply.copy collide on Ctrl+N, so both revert; plan.overview's
    // default Ctrl+G is itself taken by task.panel, so that pair reverts on the next pass.
    const { keymap, problems } = parseKeymap(
      '[keys]\n"plan.overview" = "ctrl+n"\n"reply.copy" = "ctrl+n"\n"task.panel" = "ctrl+g"\n',
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(resolveBinding(ctrl("g"), keymap)).toBe("plan.overview");
    expect(resolveBinding(ctrl("b"), keymap)).toBe("task.panel");
    expect(resolveBinding(ctrl("y"), keymap)).toBe("reply.copy");
    expect(resolveBinding(ctrl("n"), keymap)).toBe(null);
    // No chord answers two actions.
    const seen = new Set<string>();
    for (const b of keymap) {
      const c = b.keys[0];
      const id = `${c.key}|${c.ctrl}|${c.shift}|${c.meta}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("what a keymap file may never take away", () => {
  const RESERVED = [
    "ctrl+c",
    "ctrl+z",
    "ctrl+d",
    "ctrl+a",
    "ctrl+u",
    "ctrl+k",
    "ctrl+w",
    "ctrl+v",
    "alt+b",
    "alt+f",
    "enter",
    "escape",
    "up",
    "down",
    "left",
    "right",
    "backspace",
    "delete",
    "tab",
  ];

  for (const spelling of RESERVED) {
    test(`${spelling} is rejected as deliberately not rebindable`, () => {
      const { keymap, problems } = parseKeymap(`[keys]\n"toc.panel" = "${spelling}"\n`);
      expect(problems.join("\n")).toContain("not rebindable");
      expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
    });
  }

  test("Ctrl+K stays readline's even with another modifier along for the ride", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+alt+k"\n');
    expect(problems.join("\n")).toContain("not rebindable");
  });

  test("a C0 alias of a reserved key is refused, not left as a dead binding", () => {
    // Ctrl+I is 0x09: Ink reports it as `tab`, so the chord could never match anything.
    for (const [spelling, named] of [
      ["ctrl+i", "Tab"],
      ["ctrl+m", "Enter"],
      ["ctrl+j", "Enter"],
      ["ctrl+h", "Backspace"],
      ["ctrl+[", "Escape"],
    ]) {
      const { keymap, problems } = parseKeymap(`[keys]\n"toc.panel" = "${spelling}"\n`);
      expect(problems.join("\n")).toContain("not rebindable");
      expect(problems.join("\n")).toContain(named as string);
      expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
    }
  });

  test("Ctrl+Shift+Tab cannot be stolen from the loose Shift+Tab binding", () => {
    // permission.cycle matches tab+shift with ctrl/meta ALSO set; an exact ctrl+shift+tab
    // chord would win the scan by declaration order, and the conflict pass — which compares
    // chords exactly — would never see the collision. So the spelling is refused outright.
    for (const spelling of ["ctrl+shift+tab", "alt+shift+tab"]) {
      const { keymap, problems } = parseKeymap(`[keys]\n"toc.panel" = "${spelling}"\n`);
      expect(problems.join("\n")).toContain("not rebindable");
      expect(resolveBinding(keyEvent("", { tab: true, shift: true, ctrl: true }), keymap)).toBe(
        "permission.cycle",
      );
      expect(resolveBinding(keyEvent("", { tab: true, shift: true, meta: true }), keymap)).toBe(
        "permission.cycle",
      );
    }
  });

  test("Shift+Tab is bindable — it is an app chord, not a readline one", () => {
    // permission.cycle has to move first: Shift+Tab is its default, and leaving it there
    // would (rightly) be reported as a conflict rather than as a reserved chord.
    const km = clean('[keys]\n"toc.panel" = "shift+tab"\n"permission.cycle" = "ctrl+n"\n');
    expect(resolveBinding(keyEvent("", { tab: true, shift: true }), km)).toBe("toc.panel");
    expect(resolveBinding(ctrl("n"), km)).toBe("permission.cycle");
  });
});

describe("a bad file reports and falls back — startup is never blocked", () => {
  test("malformed TOML keeps every default and says so", () => {
    const { keymap, problems } = parseKeymap('[keys\n"toc.panel" = ctrl+n\n');
    expect(keymap).toBe(DEFAULT_KEYMAP);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("could not be read");
  });

  test("an unknown action is named and skipped; the valid rows still apply", () => {
    const { keymap, problems } = parseKeymap(
      '[keys]\n"toc.pannel" = "ctrl+n"\n"reply.copy" = "ctrl+f"\n',
    );
    expect(problems.join("\n")).toContain("toc.pannel");
    expect(resolveBinding(ctrl("f"), keymap)).toBe("reply.copy");
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
  });

  test("an unknown key name is named and skipped", () => {
    const { keymap, problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+f13"\n');
    expect(problems.join("\n")).toContain("f13");
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
  });

  test("an unknown modifier is named and skipped", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = "cmd+n"\n');
    expect(problems.join("\n")).toContain("cmd");
  });

  test("a non-string value is reported", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = 7\n');
    expect(problems.join("\n")).toContain("toc.panel");
  });

  test("a bare printable key is refused — it would also type into the prompt", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = "n"\n');
    expect(problems.join("\n")).toContain("Ctrl or Alt");
  });

  test("shift with a printable key is refused — terminals do not deliver it distinctly", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+shift+n"\n');
    expect(problems.join("\n")).toContain("Shift");
  });

  test("an empty binding is reported", () => {
    const { problems } = parseKeymap('[keys]\n"toc.panel" = ""\n');
    expect(problems.join("\n")).toContain("toc.panel");
  });

  test("a dangling `+` is a typo, not a silent Ctrl+Plus binding", () => {
    const { keymap, problems } = parseKeymap('[keys]\n"toc.panel" = "ctrl+"\n');
    expect(problems.join("\n")).toContain("toc.panel");
    expect(resolveBinding(ctrl("t"), keymap)).toBe("toc.panel");
    // Doubled, it IS the plus key.
    const km = clean('[keys]\n"toc.panel" = "ctrl++"\n');
    expect(resolveBinding(ctrl("+"), km)).toBe("toc.panel");
  });
});

describe("the loaded keymap is what the harness dispatches against", () => {
  let dir: string;
  let savedHarnessDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minima-keymap-"));
    savedHarnessDir = process.env.MINIMA_HARNESS_DIR;
    process.env.MINIMA_HARNESS_DIR = dir;
    resetKeymapState();
    resetChord();
  });

  afterEach(() => {
    if (savedHarnessDir === undefined) delete process.env.MINIMA_HARNESS_DIR;
    else process.env.MINIMA_HARNESS_DIR = savedHarnessDir;
    resetKeymapState();
    resetChord();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the file lives in the global harness directory", () => {
    expect(keymapPath()).toBe(join(dir, "keymap.toml"));
  });

  test("initKeymap publishes the file's bindings and its problems", () => {
    writeFileSync(keymapPath(), '[keys]\n"toc.panel" = "ctrl+n"\n"reply.copy" = "ctrl+n"\n');
    initKeymap(true);
    expect(resolveBinding(ctrl("n"), activeKeymap())).toBe(null);
    expect(keymapProblems().length).toBe(1);
  });

  test("the singleton feeds the chord latch without being passed around", () => {
    writeFileSync(keymapPath(), '[keys]\n"editor.open" = "ctrl+q ctrl+o"\n');
    initKeymap(true);
    expect(feedChordKey("q", { ctrl: true }).action).toBe("arm");
    expect(feedChordKey("o", { ctrl: true }).action).toBe("launch");
  });

  test("MINIMA_TUI_KEYMAP=0 ignores the file entirely", () => {
    writeFileSync(keymapPath(), '[keys]\n"toc.panel" = "ctrl+n"\n');
    initKeymap(false);
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP);
    expect(keymapProblems()).toEqual([]);
    expect(resolveBinding(ctrl("t"), activeKeymap())).toBe("toc.panel");
    expect(resolveBinding(ctrl("n"), activeKeymap())).toBe(null);
  });

  test("before any load, the active keymap is the default one", () => {
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP);
    expect(keymapProblems()).toEqual([]);
  });
});

describe("help text follows the effective bindings", () => {
  test("the defaults read the way the help block always did", () => {
    expect(describeKeys("thinking.cycle")).toBe("Ctrl+E");
    expect(describeKeys("permission.cycle")).toBe("Shift+Tab");
    expect(describeKeys("editor.open")).toBe("Ctrl+X Ctrl+E");
  });

  test("a rebound action reads as its new chord", () => {
    const km = clean('[keys]\n"toc.panel" = "alt+k"\n"editor.open" = "ctrl+o"\n');
    expect(describeKeys("toc.panel", km)).toBe("Alt+K");
    expect(describeKeys("editor.open", km)).toBe("Ctrl+O");
  });

  test("a conflicted action reverts to its default, and the help says the default", () => {
    const { keymap } = parseKeymap('[keys]\n"toc.panel" = "ctrl+n"\n"reply.copy" = "ctrl+n"\n');
    expect(describeKeys("toc.panel", keymap)).toBe("Ctrl+T");
  });

  test("the footer legend keeps its compact spelling, rebound or not", () => {
    // That row is clipped to one line — `Shift+Tab` where `⇧tab` used to be would cost five
    // columns of a row that is already tight at 80.
    expect(describeKeys("permission.cycle", DEFAULT_KEYMAP, "legend")).toBe("⇧tab");
    expect(describeKeys("model.picker", DEFAULT_KEYMAP, "legend")).toBe("ctrl+l");
    const km = clean('[keys]\n"model.picker" = "alt+m"\n');
    expect(describeKeys("model.picker", km, "legend")).toBe("alt+m");
  });
});
