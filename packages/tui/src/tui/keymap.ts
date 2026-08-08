/**
 * The app-level binding registry: one declarative table, one pure lookup.
 *
 *   resolveBinding(keyEvent, keymap) -> BindingAction | null
 *
 * Scope is deliberately narrow — the TEN app-level actions and nothing else. This layer
 * sits ABOVE key production and ownership: it decides what an already-resolved key event
 * MEANS, never how the event was produced (input-filter.ts), who is allowed to see it
 * (the overlay/panel capture guards in app.tsx), or how a two-key sequence latches
 * (editor_chord.ts). Those three keep their existing shape on purpose.
 *
 * NOT in here, and unreachable through it: the readline core (Ctrl+A/U/K/W/D/V, Alt+B/F),
 * abort (Esc, Ctrl+C), suspend (Ctrl+Z), Enter, Escape and the arrows. Readline chords are
 * conventions, not preferences; abort and suspend are not bindings at all.
 *
 * MODIFIER MATCHING IS EXACT by default — a chord matches only when ctrl/shift/meta all
 * agree, where the inline predicates it replaces tested just the modifiers they happened to
 * care about. For the nine single-key chords that is provably the same behaviour: they are
 * C0 control bytes, and Ink parses those with shift and meta false (Ctrl+T is
 * `{ input: "t", ctrl: true }`), while an ESC-prefixed control byte never parses as `ctrl`
 * at all. Exactness is what will let a user keymap bind Ctrl+E and Ctrl+Alt+E apart.
 *
 * Shift+Tab is the exception and carries `looseModifiers` — see the note on that field.
 */

/** The ten app-level actions. Everything else stays hardcoded where it lives. */
export type BindingAction =
  | "thinking.cycle"
  | "model.picker"
  | "command.palette"
  | "route.mode"
  | "toc.panel"
  | "plan.overview"
  | "task.panel"
  | "reply.copy"
  | "permission.cycle"
  | "editor.open";

/** Ink's named keys — a chord may name one of these instead of a printable character. */
const NAMED_KEYS = [
  "tab",
  "return",
  "escape",
  "upArrow",
  "downArrow",
  "leftArrow",
  "rightArrow",
  "pageUp",
  "pageDown",
  "backspace",
  "delete",
] as const;

export type NamedKey = (typeof NAMED_KEYS)[number];

const NAMED = new Set<string>(NAMED_KEYS);

/** One keystroke: a printable character (`"e"`) or a named key (`"tab"`), plus modifiers. */
export interface Chord {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  /**
   * Undeclared modifiers are unconstrained instead of required-absent. Set on exactly one
   * default binding, and load-bearing there: Shift+Tab arrives as the CSI sequence `ESC[Z`,
   * whose modifier bits are real, so Ctrl+Shift+Tab (`ESC[1;5Z`) and Alt+Shift+Tab
   * (`ESC ESC [Z`) reach Ink as tab+shift with ctrl/meta ALSO set. The inline predicate this
   * replaced was `key.tab && key.shift`, so all three cycle the permission mode today and
   * must keep doing so. A user keymap has no reason to set this.
   */
  readonly looseModifiers?: boolean;
}

/**
 * One action and the keys that trigger it. Two chords = a prefix sequence (the $EDITOR
 * chord's Ctrl+X Ctrl+E): the first chord arms, the second completes. Longer sequences are
 * not supported — the latch that would drive them is single-prefix by design.
 */
export interface Binding {
  readonly action: BindingAction;
  readonly keys: readonly [Chord] | readonly [Chord, Chord];
}

export type Keymap = readonly Binding[];

/** The Ink `Key` flags a chord can test. Ink's own `Key` is assignable to this. */
export interface KeyFlags {
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly tab?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

/**
 * One dispatched keypress, as the registry sees it: Ink's `(input, key)` pair plus the
 * prefix chord currently armed, if any. `prefix` is an INPUT to resolution, not the latch —
 * editor_chord.ts still owns arming, cancelling and the order-independent read.
 */
export interface KeyEvent extends KeyFlags {
  readonly input: string;
  readonly prefix?: Chord | null;
}

/** Adapt Ink's `useInput` arguments (and the panel's narrower key shape) to a KeyEvent. */
export function keyEvent(input: string, key: KeyFlags, prefix: Chord | null = null): KeyEvent {
  return { ...key, input, prefix };
}

/**
 * Today's bindings, verbatim. Order is not load-bearing: exact modifier matching makes the
 * single-chord entries mutually exclusive, and the sequence entry is invisible to an
 * unprefixed lookup.
 */
export const DEFAULT_KEYMAP: Keymap = [
  { action: "thinking.cycle", keys: [{ key: "e", ctrl: true }] },
  { action: "model.picker", keys: [{ key: "l", ctrl: true }] },
  { action: "command.palette", keys: [{ key: "p", ctrl: true }] },
  { action: "route.mode", keys: [{ key: "r", ctrl: true }] },
  { action: "toc.panel", keys: [{ key: "t", ctrl: true }] },
  { action: "plan.overview", keys: [{ key: "g", ctrl: true }] },
  { action: "task.panel", keys: [{ key: "b", ctrl: true }] },
  { action: "reply.copy", keys: [{ key: "y", ctrl: true }] },
  { action: "permission.cycle", keys: [{ key: "tab", shift: true, looseModifiers: true }] },
  {
    action: "editor.open",
    keys: [
      { key: "x", ctrl: true },
      { key: "e", ctrl: true },
    ],
  },
];

/** ctrl/shift/meta as a fixed triple, so every comparison below reads the same way. */
function mods(x: KeyFlags): [boolean, boolean, boolean] {
  return [x.ctrl ?? false, x.shift ?? false, x.meta ?? false];
}

/** The two chords of a prefix sequence, or null for a single-chord binding. */
function sequenceKeys(binding: Binding): readonly [Chord, Chord] | null {
  return binding.keys.length === 2 ? (binding.keys as readonly [Chord, Chord]) : null;
}

function chordMatches(chord: Chord, ev: KeyFlags & { readonly input: string }): boolean {
  const [wantCtrl, wantShift, wantMeta] = mods(chord);
  const [gotCtrl, gotShift, gotMeta] = mods(ev);
  if (chord.looseModifiers) {
    // Only the modifiers the chord DECLARES are checked; the rest are unconstrained.
    if (wantCtrl && !gotCtrl) return false;
    if (wantShift && !gotShift) return false;
    if (wantMeta && !gotMeta) return false;
  } else if (wantCtrl !== gotCtrl || wantShift !== gotShift || wantMeta !== gotMeta) {
    return false;
  }
  if (NAMED.has(chord.key)) return ev[chord.key as NamedKey] === true;
  return ev.input === chord.key;
}

/**
 * A chord's identity — key plus the three modifiers, and deliberately NOT `looseModifiers`,
 * which widens what a chord MATCHES without changing which chord it is. Two chords with the
 * same id are the same keystroke; the keymap loader uses it to find a chord bound twice.
 */
export function chordId(chord: Chord): string {
  const [ctrl, shift, meta] = mods(chord);
  return `${chord.key}|${ctrl ? 1 : 0}|${shift ? 1 : 0}|${meta ? 1 : 0}`;
}

function sameChord(a: Chord, b: Chord): boolean {
  return chordId(a) === chordId(b);
}

/** Does this key event press exactly this chord? The predicate resolution itself uses. */
export function matchesChord(ev: KeyFlags & { readonly input: string }, chord: Chord): boolean {
  return chordMatches(chord, ev);
}

/**
 * What does this key event mean? `null` = nothing app-level; the caller's own handling (or
 * the layer below it) still applies.
 *
 * With `ev.prefix` set the lookup asks ONE question — does this key complete the armed
 * sequence? — and answers null otherwise. It deliberately does not fall back to single-chord
 * bindings: the latch needs "not the chord" so it can cancel and let the key through, and
 * app.tsx resolves the very same dispatch without a prefix to get the key's own action.
 */
export function resolveBinding(
  ev: KeyEvent,
  keymap: Keymap = DEFAULT_KEYMAP,
): BindingAction | null {
  const prefix = ev.prefix ?? null;
  for (const binding of keymap) {
    const sequence = sequenceKeys(binding);
    if (sequence) {
      const [first, second] = sequence;
      if (prefix && sameChord(first, prefix) && chordMatches(second, ev)) return binding.action;
      continue;
    }
    if (!prefix && chordMatches(binding.keys[0], ev)) return binding.action;
  }
  return null;
}

/** How each named key is written for a human. Only `tab` is reachable — the rest are
 * reserved (keymap_file.ts) — but a label table with holes in it is a trap for the next
 * binding that needs one. */
const NAMED_LABELS: Record<NamedKey, string> = {
  tab: "Tab",
  return: "Enter",
  escape: "Esc",
  upArrow: "↑",
  downArrow: "↓",
  leftArrow: "←",
  rightArrow: "→",
  pageUp: "PageUp",
  pageDown: "PageDown",
  backspace: "Backspace",
  delete: "Delete",
};

/**
 * `help` is the prose spelling (`Ctrl+E`, `Shift+Tab`); `legend` is the footer's compact one
 * (`ctrl+e`, `⇧tab`), which has to stay short — that row is clipped to one line.
 */
export type ChordStyle = "help" | "legend";

/** One chord, spelled for a human. */
export function formatChord(chord: Chord, style: ChordStyle = "help"): string {
  const named = NAMED.has(chord.key);
  if (style === "legend") {
    const key = (named ? NAMED_LABELS[chord.key as NamedKey] : chord.key).toLowerCase();
    return `${chord.ctrl ? "ctrl+" : ""}${chord.meta ? "alt+" : ""}${chord.shift ? "⇧" : ""}${key}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.meta) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(named ? NAMED_LABELS[chord.key as NamedKey] : chord.key.toUpperCase());
  return parts.join("+");
}

/** The keys bound to an action, or null when the keymap does not bind it at all. */
export function keysFor(
  action: BindingAction,
  keymap: Keymap = DEFAULT_KEYMAP,
): readonly Chord[] | null {
  return keymap.find((b) => b.action === action)?.keys ?? null;
}

/**
 * What the in-app help must print for an action — `Ctrl+T`, or `Ctrl+X Ctrl+E` for a
 * sequence. Reads the EFFECTIVE keymap, so a rebound key never leaves the help lying.
 */
export function describeKeys(
  action: BindingAction,
  keymap: Keymap = DEFAULT_KEYMAP,
  style: ChordStyle = "help",
): string {
  const keys = keysFor(action, keymap);
  return keys ? keys.map((c) => formatChord(c, style)).join(" ") : "(unbound)";
}

/** The prefix chord this event opens, when it is the first key of a sequence binding. */
export function matchPrefix(ev: KeyEvent, keymap: Keymap = DEFAULT_KEYMAP): Chord | null {
  for (const binding of keymap) {
    const sequence = sequenceKeys(binding);
    if (sequence && chordMatches(sequence[0], ev)) return sequence[0];
  }
  return null;
}

/** The chord that arms `action`, for a latch that has to hold it across two dispatches. */
export function prefixChordFor(
  action: BindingAction,
  keymap: Keymap = DEFAULT_KEYMAP,
): Chord | null {
  for (const binding of keymap) {
    if (binding.action !== action) continue;
    const sequence = sequenceKeys(binding);
    if (sequence) return sequence[0];
  }
  return null;
}
