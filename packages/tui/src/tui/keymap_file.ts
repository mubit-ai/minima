/**
 * The user keymap file: `~/.minima-harness/keymap.toml` merged over `DEFAULT_KEYMAP`.
 *
 *   [keys]
 *   "toc.panel"   = "ctrl+n"
 *   "editor.open" = "ctrl+x ctrl+e"
 *
 * GLOBAL ONLY, and that is not a special case. Under ADR 0010 a project-config key must have
 * a nameable safer side; a keybinding has none (a repo that could rebind your keys could
 * rebind them onto anything), so it is not on the project allowlist at all.
 *
 * Scope is exactly the registry's: the ten app-level actions. The readline core, abort,
 * suspend, Enter, Escape, Tab and the arrows are not in the registry, so a keymap cannot
 * reach them by rebinding — and this loader ALSO refuses to bind an action ONTO one of them,
 * which is the half the registry cannot enforce. A user who rebinds away their ability to
 * stop a running agent has no way back.
 *
 * Three rules the parser holds, in order of how often they bite:
 *  1. A printable key needs Ctrl or Alt. A bare `k` would fire the action AND type `k` —
 *     both useInput handlers see the same keypress, so an unmodified binding is never just
 *     a binding. Shift+<char> is refused for the mirror reason: a terminal delivers Ctrl+K
 *     and Ctrl+Shift+K as the same byte, so the binding would be a promise nothing keeps.
 *  2. A two-key sequence is `editor.open`'s alone. The latch that drives one (editor_chord.ts)
 *     is a single-prefix module singleton, and the completion is wired to the composer's
 *     $EDITOR hand-off — a second sequence would have no dispatch site to land in.
 *  3. Two actions on one chord is REPORTED, never silently resolved: picking a winner hides
 *     a user error. Every action on a duplicated chord reverts to its DEFAULT binding, which
 *     can itself re-collide (a default landing on a chord some other override took), so the
 *     pass repeats to a fixed point. It terminates: an action reverts at most once, and the
 *     defaults never collide with each other.
 *
 * Nothing here can block startup. A missing file is silence; anything else — unparseable
 * TOML, an unknown action, a refused chord — reports and leaves the affected action on its
 * default. `MINIMA_TUI_KEYMAP=0` skips the file entirely.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Binding,
  type BindingAction,
  type Chord,
  DEFAULT_KEYMAP,
  type Keymap,
  type NamedKey,
  chordId,
  describeKeys,
  formatChord,
} from "./keymap.ts";

export const KEYMAP_FILENAME = "keymap.toml";

/** Same global harness directory as the other cross-project preferences (mode_prefs.ts). */
export function keymapPath(): string {
  const dir = process.env.MINIMA_HARNESS_DIR?.trim() || join(homedir(), ".minima-harness");
  return join(dir, KEYMAP_FILENAME);
}

export interface KeymapLoad {
  readonly keymap: Keymap;
  /** Everything wrong with the file, in file order, each naming the action it cost. */
  readonly problems: readonly string[];
}

const ACTIONS = new Set<string>(DEFAULT_KEYMAP.map((b) => b.action));

/** Modifier spellings a user might reasonably type. `cmd`/`super` are deliberately absent:
 * a terminal never delivers them as a distinct key event. */
const MODIFIERS: Record<string, "ctrl" | "shift" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "meta",
  opt: "meta",
  option: "meta",
  meta: "meta",
};

/** Named-key spellings → Ink's own name for the key. */
const KEY_ALIASES: Record<string, NamedKey> = {
  tab: "tab",
  enter: "return",
  return: "return",
  esc: "escape",
  escape: "escape",
  up: "upArrow",
  uparrow: "upArrow",
  down: "downArrow",
  downarrow: "downArrow",
  left: "leftArrow",
  leftarrow: "leftArrow",
  right: "rightArrow",
  rightarrow: "rightArrow",
  pageup: "pageUp",
  pagedown: "pageDown",
  backspace: "backspace",
  del: "delete",
  delete: "delete",
};

/** The composer's readline core (text-input.tsx) — Ctrl+E is NOT here, it is a binding. */
const READLINE_CTRL = new Set(["a", "u", "k", "w", "d", "v"]);
/** Alt+B / Alt+F word jumps, when ctrl is not also down (the ctrl branch wins that case). */
const READLINE_META = new Set(["b", "f"]);
/** Named keys the composer or the terminal owns outright. `tab` is handled separately.
 * Each reason is written to read inside the parentheses of the refusal message. */
const RESERVED_NAMED: Record<string, string> = {
  return: "it submits the prompt",
  escape: "it aborts the run",
  upArrow: "the arrows move the cursor and walk history",
  downArrow: "the arrows move the cursor and walk history",
  leftArrow: "the arrows move the cursor and walk history",
  rightArrow: "the arrows move the cursor and walk history",
  backspace: "the readline editing keys own it",
  delete: "the readline editing keys own it",
  pageUp: "the terminal's own scrollback uses it",
  pageDown: "the terminal's own scrollback uses it",
};

/**
 * Control bytes a terminal ALREADY spends on a named key: Ctrl+I is 0x09, which Ink reports
 * as `tab`, never as ctrl+i. Binding one produces a chord no keypress can ever match — the
 * same empty promise `shift`+printable is refused for — and the key it aliases is reserved
 * under its own name anyway.
 */
const C0_ALIASES: Record<string, string> = {
  i: "Tab",
  m: "Enter",
  j: "Enter",
  h: "Backspace",
  "[": "Escape",
};

/** Why a chord is off limits, or null when it is free to bind. */
function reservedReason(chord: Chord): string | null {
  if (chord.key === "tab") {
    if (!chord.shift) return "it completes slash commands";
    // Shift+Tab is an app chord (the permission ring) and the ONE default binding matching
    // loosely: Ctrl+Shift+Tab (ESC[1;5Z) and Alt+Shift+Tab reach Ink as tab+shift with
    // ctrl/meta also set, and whatever holds `shift+tab` answers all three. Binding those
    // spellings separately would quietly steal two of them from it, and the conflict scan —
    // which compares chords exactly — could not see it happen.
    return chord.ctrl || chord.meta
      ? "Ctrl+Shift+Tab and Alt+Shift+Tab arrive as Shift+Tab, which is bindable on its own"
      : null;
  }
  const named = RESERVED_NAMED[chord.key];
  if (named) return named;
  if (chord.ctrl && C0_ALIASES[chord.key])
    return `it is the ${C0_ALIASES[chord.key]} byte, and arrives as ${C0_ALIASES[chord.key]}`;
  if (chord.ctrl && chord.key === "c") return "it aborts the run and quits";
  if (chord.ctrl && chord.key === "z") return "it suspends to the shell";
  if (chord.ctrl && READLINE_CTRL.has(chord.key)) return "the readline editing keys own it";
  if (chord.meta && !chord.ctrl && READLINE_META.has(chord.key))
    return "the readline word jumps own it";
  return null;
}

/**
 * Split a chord token on `+`. A DOUBLED trailing `+` is the plus key itself (`ctrl++`); a
 * single trailing one is a typo, and reading it as Ctrl+Plus would bind a key nobody asked
 * for instead of reporting the line.
 */
function splitChord(token: string): string[] {
  const parts = token.split("+").filter((part) => part !== "");
  if (token.endsWith("++")) parts.push("+");
  return parts;
}

type ChordResult = { chord: Chord } | { error: string };

function parseChord(token: string): ChordResult {
  const parts = splitChord(token);
  if (parts.length === 0) return { error: `\`${token}\` names no key` };
  const rawKey = parts[parts.length - 1] as string;
  let ctrl = false;
  let shift = false;
  let meta = false;
  for (const raw of parts.slice(0, -1)) {
    const mod = MODIFIERS[raw.toLowerCase()];
    if (!mod) return { error: `\`${raw}\` is not a modifier (use ctrl, alt or shift)` };
    if (mod === "ctrl") ctrl = true;
    else if (mod === "shift") shift = true;
    else meta = true;
  }

  const lower = rawKey.toLowerCase();
  const named = KEY_ALIASES[lower];
  const key = named ?? lower;
  if (!named && [...lower].length !== 1) return { error: `\`${rawKey}\` is not a key` };

  const chord: Chord = { key, ctrl, shift, meta };
  const reserved = reservedReason(chord);
  if (reserved)
    return { error: `${formatChord(chord)} is deliberately not rebindable (${reserved})` };
  if (!named) {
    if (!ctrl && !meta)
      return {
        error: `${formatChord(chord)} needs Ctrl or Alt (a bare key would also type into the prompt)`,
      };
    if (shift)
      return {
        error: `${formatChord(chord)} is not deliverable (a terminal sends the same bytes with and without Shift)`,
      };
  }
  // Shift+Tab's modifier bits are real CSI bits, so Ctrl+Shift+Tab and Alt+Shift+Tab arrive
  // as tab+shift with ctrl/meta ALSO set. Loose matching is what makes all three cycle the
  // permission ring today; restating the default binding must not quietly drop two of them.
  if (key === "tab" && shift && !ctrl && !meta)
    return { chord: { ...chord, looseModifiers: true } };
  return { chord };
}

function defaultFor(action: BindingAction): Binding {
  return DEFAULT_KEYMAP.find((b) => b.action === action) as Binding;
}

/** One `action = "chords"` row → a Binding, or the reason it was refused. */
function parseRow(action: BindingAction, value: unknown): { binding: Binding } | { error: string } {
  if (typeof value !== "string") return { error: 'expected a string like "ctrl+n"' };
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { error: "names no key" };
  if (tokens.length > 2) return { error: "names more than two keys — the longest chord is two" };
  if (tokens.length === 2 && action !== "editor.open")
    return { error: "only editor.open may use a two-key sequence" };

  const chords: Chord[] = [];
  for (const token of tokens) {
    const parsed = parseChord(token);
    if ("error" in parsed) return { error: parsed.error };
    chords.push(parsed.chord);
  }
  const keys =
    chords.length === 2
      ? ([chords[0], chords[1]] as readonly [Chord, Chord])
      : ([chords[0]] as readonly [Chord]);
  return { binding: { action, keys } };
}

/**
 * Every action on a duplicated chord reverts to its default, repeating until no chord
 * answers two actions. A sequence is identified by its PREFIX: Ctrl+X Ctrl+E and a plain
 * Ctrl+X binding do collide — the prefix would arm the latch and fire the action at once.
 */
function resolveConflicts(effective: Binding[], problems: string[]): void {
  for (let pass = 0; pass < effective.length; pass++) {
    const groups = new Map<string, number[]>();
    for (const [i, binding] of effective.entries()) {
      const id = chordId(binding.keys[0]);
      const at = groups.get(id);
      if (at) at.push(i);
      else groups.set(id, [i]);
    }
    let reverted = false;
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      const bindings = indices.map((i) => effective[i] as Binding);
      const actions = bindings.map((b) => b.action);
      const names =
        actions.length === 2
          ? `both ${actions.join(" and ")}`
          : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]}`;
      const kept = bindings.map((b) => `${b.action} keeps ${describeKeys(b.action)}`).join(", ");
      problems.push(
        `${formatChord(bindings[0]?.keys[0] as Chord)} is bound to ${names} — ` +
          `that is ambiguous, so none of them wins: ${kept}`,
      );
      for (const i of indices) {
        const fallback = defaultFor((effective[i] as Binding).action);
        if (effective[i] !== fallback) {
          effective[i] = fallback;
          reverted = true;
        }
      }
    }
    if (!reverted) return; // clean, or a collision between defaults that reverting cannot fix
  }
}

/** Parse keymap TOML into an effective keymap. Pure — no file, no environment. */
export function parseKeymap(text: string): KeymapLoad {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    return {
      keymap: DEFAULT_KEYMAP,
      problems: [
        `${KEYMAP_FILENAME} could not be read as TOML (${err instanceof Error ? err.message : String(err)}) — every key kept its default`,
      ],
    };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { keymap: DEFAULT_KEYMAP, problems: [] };

  // `[keys]` is the documented shape; a file that writes the rows at the top level means the
  // same thing, and rejecting it would be pedantry.
  const outer = parsed as Record<string, unknown>;
  const inner = outer.keys;
  const table =
    typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : outer;

  const problems: string[] = [];
  const overrides = new Map<BindingAction, Binding>();
  for (const [name, value] of Object.entries(table)) {
    if (!ACTIONS.has(name)) {
      problems.push(`\`${name}\` is not one of the bindable actions`);
      continue;
    }
    const action = name as BindingAction;
    const row = parseRow(action, value);
    if ("error" in row) {
      problems.push(`${action}: ${row.error} — keeping ${describeKeys(action)}`);
      continue;
    }
    overrides.set(action, row.binding);
  }
  if (overrides.size === 0 && problems.length === 0) return { keymap: DEFAULT_KEYMAP, problems };

  const effective = DEFAULT_KEYMAP.map((b) => overrides.get(b.action) ?? b);
  resolveConflicts(effective, problems);
  return { keymap: effective, problems };
}

/** Read and parse the keymap file. A missing file is silence, never a problem. */
export function loadKeymap(opts: { enabled?: boolean; path?: string } = {}): KeymapLoad {
  if (opts.enabled === false) return { keymap: DEFAULT_KEYMAP, problems: [] };
  const path = opts.path ?? keymapPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT")
      return { keymap: DEFAULT_KEYMAP, problems: [] };
    return {
      keymap: DEFAULT_KEYMAP,
      problems: [`${path} could not be read (${(err as Error).message}) — using the default keys`],
    };
  }
  return parseKeymap(text);
}

// The process-wide effective keymap. A module singleton for the same reason the chord latch
// is one: the composer's latch (editor_chord.ts) needs it and has no React tree to read from,
// and the file is a startup fact — it is read once, in main.ts, before the first keypress.
let active: KeymapLoad = { keymap: DEFAULT_KEYMAP, problems: [] };

/** Read the file (unless `MINIMA_TUI_KEYMAP=0`) and publish it. Called once, from main.ts. */
export function initKeymap(enabled: boolean): KeymapLoad {
  active = loadKeymap({ enabled });
  return active;
}

/** The bindings every dispatch resolves against — the defaults until initKeymap runs. */
export function activeKeymap(): Keymap {
  return active.keymap;
}

/** What was wrong with the file, for the startup notice. Empty when there was nothing. */
export function keymapProblems(): readonly string[] {
  return active.problems;
}

/** Drop back to the defaults. Tests only — nothing in the app un-loads a keymap. */
export function resetKeymapState(): void {
  active = { keymap: DEFAULT_KEYMAP, problems: [] };
}
