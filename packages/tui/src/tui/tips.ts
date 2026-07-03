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

function readIndex(): number {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as { index?: unknown };
    const i = Number(raw.index);
    return Number.isFinite(i) ? i : 0;
  } catch {
    // missing / corrupt / unreadable state → start from 0
    return 0;
  }
}

/**
 * Advance the rotation cursor, persist it (best-effort), and return the tip at the
 * new index. An unwritable HOME never crashes the app — it just means the next
 * launch re-reads the old value.
 */
export function advance(): string {
  const nxt = nextIndex(readIndex());
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ index: nxt }));
  } catch {
    // read-only HOME / no perms: fall back to the in-memory rotation
  }
  return pick(nxt);
}
