/**
 * Curated command tips — port of minima_harness/tui/tips.py.
 *
 * Each tip spotlights one distinctive Minima command a new user would never find
 * on their own. `/tip` shows the next one in order; a rotation cursor persists to
 * ~/.minima-harness/tips_state.json so each invocation surfaces a fresh tip rather
 * than a repeat.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Each entry leads with the `/command` so the takeaway is the command itself.
export const TIPS: readonly string[] = [
  "/recall pulls lessons from past sessions, even across projects",
  "/model auto lets Minima cost-route; /model <id> pins one",
  "/plan toggles read-only plan mode before you let it edit",
  "/budget set <usd> tracks spend against a session budget",
  "/judge toggles LLM quality judging of each answer",
  "/thoughts streams the model's reasoning live",
  "/cost opens the meter: estimated vs. actual spend per turn",
  "/compact summarizes older context when the window fills up",
  "/prompt inspects the layered Mubit + local system prompt",
  "/tree, /fork and /clone branch and revisit your session history",
  "/mouse toggles wheel-scroll vs. native terminal select/copy",
  "web_search + web_fetch give the model live web access (set EXA_API_KEY)",
  "apply_patch edits many files atomically in one call",
  "/resume reopens a past session or run by id",
  "/config manages your API keys (MUBIT, ANTHROPIC, EXA, …)",
];

// Rotation cursor lives next to the harness config. Overridable for tests.
let stateDir = resolve(homedir(), ".minima-harness");
export function setTipsStateDir(dir: string): void {
  stateDir = dir;
}
const stateFile = () => join(stateDir, "tips_state.json");

/** Prefix a tip body with the lightbulb glyph. */
export function formatTip(body: string): string {
  return `💡 ${body}`;
}

/** The tip at `index`, wrapping around the curated list. */
export function pick(index: number): string {
  const n = TIPS.length;
  return TIPS[((index % n) + n) % n] as string;
}

/** The index after `index`, wrapping around (pure). */
export function nextIndex(index: number): number {
  return (index + 1) % TIPS.length;
}

interface TipsState {
  index?: number;
  enabled?: boolean;
}

function readState(): TipsState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as TipsState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    // missing / corrupt / unreadable state → defaults
    return {};
  }
}

/** Best-effort persist. An unwritable HOME never crashes the app. */
function writeState(state: TipsState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // read-only HOME / no perms: fall back to the in-memory value
  }
}

function readIndex(): number {
  const i = Number(readState().index);
  return Number.isFinite(i) ? i : 0;
}

/**
 * Advance the rotation cursor, persist it (best-effort, preserving `enabled`), and
 * return the tip at the new index.
 */
export function advance(): string {
  const state = readState();
  const nxt = nextIndex(readIndex());
  writeState({ ...state, index: nxt });
  return pick(nxt);
}

/** Whether startup tips are enabled. Defaults to true when unset — tips are ON by default. */
export function isTipsEnabled(): boolean {
  return readState().enabled !== false;
}

/** Persist the startup-tips on/off preference (best-effort), preserving the rotation cursor. */
export function setTipsEnabled(enabled: boolean): void {
  writeState({ ...readState(), enabled });
}
