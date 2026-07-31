/**
 * The Ctrl+X Ctrl+E chord (readline's edit-and-execute-command), as a pure reducer plus a
 * module-level singleton. Shaped after the `gg` chord in panel_state.ts.
 *
 *   any    + Ctrl+X       -> arm (idempotent)          consumed
 *   armed  + Ctrl+E       -> launch                    consumed
 *   armed  + anything else-> cancel                    NOT consumed — the key still types
 *   idle   + anything else-> nothing                   not consumed
 *
 * The cancelling key is deliberately not swallowed, so Ctrl+X then `h` disarms AND inserts
 * `h` — an accidental prefix costs nothing.
 *
 * NO TIMEOUT. readline has none; a timer is another async surface needing unmount cleanup;
 * and it could fire BETWEEN the two keys of a slow chunk, turning a working chord into a
 * flaky one. The only way `armed` strands is losing the keyboard mid-chord, which the
 * composer's disabled/suspended effect resets.
 *
 * WHY A MODULE SINGLETON AND NOT REACT STATE — two independent reasons:
 *  1. Same-chunk synchrony, exactly the argument at text-input.tsx:80-85. After the C0 split
 *     in input-filter.ts the two keys dispatch back-to-back inside ONE handleReadable loop
 *     with no re-render between them, so React state would still read `armed === false` when
 *     the second key arrives.
 *  2. app.tsx needs to read it too (to suppress its own Ctrl+E thinking cycle), and a
 *     component ref is invisible to it.
 *
 * THE ORDER-INDEPENDENT LATCH. Ink's useInput re-subscribes every render and EventEmitter
 * appends, so the listener order between app.tsx and TextInput is NOT stable — neither may
 * assume it runs first. `chordOwnsKey()` therefore answers `armed || justConsumed`: composer
 * first leaves `justConsumed` true, app first leaves `armed` still true, and a plain Ctrl+E
 * leaves both false so thinking cycles exactly as before. It must be read ONCE per dispatch,
 * as the first statement of the app handler above every early return — read later, a busy
 * dispatch that returns early would leave `justConsumed` set and poison the next Ctrl+E.
 */

const CTRL_X = String.fromCharCode(24);
const CTRL_E = String.fromCharCode(5);

export type ChordAction = "arm" | "launch" | "cancel" | "none";

export interface ChordResult {
  armed: boolean;
  action: ChordAction;
  /** True when the key belongs to the chord and must NOT also reach the draft. */
  consumed: boolean;
}

/** Pure reducer: given whether the chord is armed, classify one keypress. */
export function chordReduce(armed: boolean, input: string, ctrl: boolean): ChordResult {
  if (ctrl && input === "x") return { armed: true, action: "arm", consumed: true };
  if (armed && ctrl && input === "e") return { armed: false, action: "launch", consumed: true };
  if (armed) return { armed: false, action: "cancel", consumed: false };
  return { armed: false, action: "none", consumed: false };
}

let armed = false;
let justConsumed = false;

/**
 * Feed one keypress into the singleton. `input`/`ctrl` are Ink's useInput arguments — Ink
 * reports a control key as `input: "x", key.ctrl: true`, never the raw byte.
 */
export function feedChordKey(input: string, ctrl: boolean): ChordResult {
  const res = chordReduce(armed, input, ctrl);
  armed = res.armed;
  if (res.consumed) justConsumed = true;
  return res;
}

/**
 * Did the chord own the key currently being dispatched? Reads the latch and clears the
 * one-shot half, so it is safe whichever useInput listener ran first (see the header).
 */
export function chordOwnsKey(): boolean {
  const owned = armed || justConsumed;
  justConsumed = false;
  return owned;
}

/** True while Ctrl+X is armed — drives the composer's `· ^X` title hint. */
export function isChordArmed(): boolean {
  return armed;
}

/** Disarm completely. The composer calls this when it loses the keyboard or unmounts. */
export function resetChord(): void {
  armed = false;
  justConsumed = false;
}

/** The raw bytes, for tests that assert what a terminal actually sends. */
export const CHORD_BYTES = { ctrlX: CTRL_X, ctrlE: CTRL_E } as const;
