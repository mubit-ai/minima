/**
 * `.minima/config.toml` — the harness's first COMMITTED config surface — and the env-layer
 * loader that resolves it.
 *
 * Every other config surface (`.env.harness`, `.env`, the per-user store) is uncommitted,
 * and trusted precisely because the user wrote it. A committed file inverts that: it arrives
 * with `git clone`, written by someone else, which turns `git clone && minima` into an
 * execution path the repo author controls. That inversion is the whole design here, and it
 * gives three rules:
 *
 *  1. An ALLOWLIST is the gate. Keys not on the list are ignored — not a blocklist, because a
 *     blocklist is a promise to have thought of everything.
 *  2. A project file may only move a value toward the SAFER side. That is the general rule,
 *     not a spend special case: each allowlisted key declares a merge direction, or it is
 *     neutral and plainly shadows.
 *  3. The clamp happens HERE, in the loader, before anything reaches `process.env`. The
 *     safety property is then structural — no downstream read site can observe an unclamped
 *     value. (`process.env` erases provenance: once a value is env you cannot tell which
 *     layer set it, so a later pass could not re-derive what to clamp against.)
 *
 * Rule 3 is why this is one resolution over all the layers rather than another gap-filling
 * pass appended to the chain: clamping needs the project and user values in hand at the same
 * time, whereas the old loaders filled gaps in sequence and the per-user store hydrated last.
 *
 * Precedence, earlier wins: CLI flags → shell env → `.env.harness`/`.env` →
 * `.minima/config.toml` → `~/.minima-harness/config.env` + keychain → defaults. The clamp
 * cuts ACROSS that order in one direction only: a project value that is safer than the
 * user's wins even though it sits below them, and a project value that is less safe loses
 * even where it would otherwise have shadowed.
 *
 * Search paths are deliberately absent from the allowlist. They are directional too
 * (narrowing is safe, widening is not), so a project file could only ever remove one — which
 * is why the default list has to be legislated in code rather than configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { errText } from "../errtext.ts";
import { BUDGET_MODE_STRICTNESS, DEFAULT_BUDGET_MODE, parseBudgetMode } from "./budget.ts";
import { DEFAULT_CANDIDATES } from "./config.ts";

/** Where a project keeps its committed config, relative to the working directory. */
export const PROJECT_CONFIG_RELPATH = ".minima/config.toml";

/** The user's own project-scoped env files, highest precedence first. */
const ENV_FILES = [".env.harness", ".env"] as const;

/**
 * How a project value merges with the user's:
 * - `lower-wins` / `strictest-wins` / `intersect` — directional: the project may only move
 *   the value toward the safer side, whatever the layer order says.
 * - `neutral` — no side is safer, so it plainly shadows: it fills a gap the user left.
 */
export type MergeDirection = "lower-wins" | "strictest-wins" | "intersect" | "neutral";

export interface AllowedKey {
  /** Dotted path in the TOML file. */
  path: string;
  /** The environment variable it materialises as. */
  env: string;
  direction: MergeDirection;
}

/**
 * The v1 allowlist. Thinking level, judge sampling and the default model are deliberately
 * NOT here — not because they are dangerous, but because nobody can yet name their safer
 * side. The list grows by argument, not by default.
 */
export const PROJECT_CONFIG_ALLOWLIST: readonly AllowedKey[] = [
  { path: "budget.limit_usd", env: "MINIMA_BUDGET_USD", direction: "lower-wins" },
  { path: "budget.mode", env: "MINIMA_BUDGET_MODE", direction: "strictest-wins" },
  { path: "routing.candidates", env: "MINIMA_CANDIDATES", direction: "intersect" },
  { path: "compaction.artifact_spill", env: "MINIMA_TUI_COMPACT2", direction: "neutral" },
];

export interface EnvLayers {
  /**
   * Assign each of these into `process.env` verbatim: precedence AND the safer-side clamps
   * are already applied, so an entry here is final. Keys the user already set only appear
   * when a project value legitimately overrode them downward.
   */
  values: Record<string, string>;
  /** stderr lines — refused values, keys off the allowlist, a file that would not parse. */
  notices: string[];
  /** The project config in effect, or null (absent, switched off, or unparseable). */
  path: string | null;
}

interface Merged {
  /** The value to write, or null to leave the user's own value standing. */
  value: string | null;
  notice: string | null;
}

function readEnvFile(path: string, into: Record<string, string>): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (into[key] === undefined) into[key] = val;
  }
}

/** Every leaf of the parsed TOML as a dotted path, so an unknown key cannot hide in a table. */
function flattenLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (prefix) out.set(prefix, value);
}

/** Budget ceiling: the project may only lower it. No user ceiling = no ceiling to raise. */
function mergeLowerWins(raw: unknown, user: string | undefined, path: string): Merged {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { value: null, notice: `ignoring ${path} — expected a positive number` };
  }
  const parsed = user !== undefined ? Number(user) : Number.NaN;
  const ceiling = Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
  if (raw >= ceiling) {
    return {
      value: null,
      notice: `ignoring ${path} = ${raw} — a project file may only LOWER the budget ceiling (yours: ${ceiling})`,
    };
  }
  return { value: String(raw), notice: null };
}

/** Budget mode: the project may only tighten it, and never below the harness default. */
function mergeStrictestWins(raw: unknown, user: string | undefined, path: string): Merged {
  const wanted = typeof raw === "string" ? parseBudgetMode(raw) : null;
  if (wanted === null) {
    return { value: null, notice: `ignoring ${path} — expected one of shadow, warn, enforce` };
  }
  const effective = parseBudgetMode(user) ?? DEFAULT_BUDGET_MODE;
  if (BUDGET_MODE_STRICTNESS[wanted] > BUDGET_MODE_STRICTNESS[effective]) {
    return { value: wanted, notice: null };
  }
  // Agreeing with what is already in effect is a no-op, not a refusal — saying so on every
  // startup would train the user to ignore the line that reports a real one.
  if (wanted === effective) return { value: null, notice: null };
  return {
    value: null,
    notice: `ignoring ${path} = "${wanted}" — a project file may only make the budget mode STRICTER (in effect: ${effective})`,
  };
}

/**
 * Candidate pool: intersection only. The user's order is the preference order, so the
 * intersection keeps it. An empty intersection is REFUSED rather than written — an empty
 * pool is an absent constraint, which widens routing instead of narrowing it.
 */
function mergeIntersect(raw: unknown, user: string | undefined, path: string): Merged {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v.trim())) {
    return { value: null, notice: `ignoring ${path} — expected an array of model ids` };
  }
  const project = new Set((raw as string[]).map((s) => s.trim()));
  const mine =
    user !== undefined
      ? user
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [...DEFAULT_CANDIDATES];
  const mineSet = new Set(mine);
  const kept = mine.filter((id) => project.has(id));
  const dropped = [...project].filter((id) => !mineSet.has(id));
  if (kept.length === 0) {
    return {
      value: null,
      notice: `ignoring ${path} — none of [${[...project].join(", ")}] is in your candidate pool, and an empty pool would widen routing rather than narrow it`,
    };
  }
  const notice = dropped.length
    ? `${path}: dropped ${dropped.join(", ")} — a project file may only NARROW your candidate pool`
    : null;
  // No narrowing happened: leave the user's own value (and its ordering) untouched.
  if (kept.length === mine.length) return { value: null, notice };
  return { value: kept.join(","), notice };
}

/** Neutral key: no safer side, so it fills a gap the user left and shadows the store. */
function mergeNeutral(raw: unknown, user: string | undefined, path: string): Merged {
  let text: string | null = null;
  if (typeof raw === "boolean") text = raw ? "1" : "0";
  else if (typeof raw === "string" && raw.trim()) text = raw.trim();
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  if (text === null) {
    return { value: null, notice: `ignoring ${path} — expected a boolean, string or number` };
  }
  return user !== undefined ? { value: null, notice: null } : { value: text, notice: null };
}

function merge(key: AllowedKey, raw: unknown, user: string | undefined): Merged {
  switch (key.direction) {
    case "lower-wins":
      return mergeLowerWins(raw, user, key.path);
    case "strictest-wins":
      return mergeStrictestWins(raw, user, key.path);
    case "intersect":
      return mergeIntersect(raw, user, key.path);
    case "neutral":
      return mergeNeutral(raw, user, key.path);
  }
}

/**
 * Resolve every config layer below the CLI flags into the exact set of values to write.
 *
 * Pure over its inputs — a project directory plus the per-user store's values — so the merge
 * rules are testable without touching (or restoring) the real environment. `env` is the shell
 * environment, passed in rather than read, for the same reason.
 */
export function resolveEnvLayers(opts: {
  projectDir: string;
  env: Record<string, string | undefined>;
  /** Values from the per-user store (keychain + `~/.minima-harness/config.env`). */
  stored?: Record<string, string>;
}): EnvLayers {
  const { projectDir, env } = opts;
  const stored = opts.stored ?? {};

  const envFiles: Record<string, string> = {};
  for (const name of ENV_FILES) readEnvFile(join(projectDir, name), envFiles);

  // The pre-existing chain, unchanged: shell env > .env.harness > .env > per-user store,
  // each layer filling only what the ones above it left unset.
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(envFiles)) if (env[k] === undefined) values[k] = v;
  for (const [k, v] of Object.entries(stored)) {
    if (env[k] === undefined && values[k] === undefined) values[k] = v;
  }

  const notices: string[] = [];
  // The kill switch is read from the USER's layers only — never from the project file, which
  // must not be able to switch off its own gate.
  const disabled =
    (env.MINIMA_TUI_PROJECT_CONFIG ??
      envFiles.MINIMA_TUI_PROJECT_CONFIG ??
      stored.MINIMA_TUI_PROJECT_CONFIG) === "0";
  const path = join(projectDir, PROJECT_CONFIG_RELPATH);
  if (disabled || !existsSync(path)) return { values, notices, path: null };

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    // Config must never block startup: a file that will not parse is reported and skipped.
    notices.push(`${PROJECT_CONFIG_RELPATH} ignored — ${errText(exc)}`);
    return { values, notices, path: null };
  }

  const leaves = new Map<string, unknown>();
  flattenLeaves(parsed, "", leaves);

  const applied: string[] = [];
  const refused: string[] = [];
  for (const key of PROJECT_CONFIG_ALLOWLIST) {
    if (!leaves.has(key.path)) continue;
    const raw = leaves.get(key.path);
    leaves.delete(key.path);
    // A neutral key shadows the store but not the user's own files; a directional one is
    // clamped against every layer the user controls, store included.
    const mine =
      key.direction === "neutral"
        ? (env[key.env] ?? envFiles[key.env])
        : (env[key.env] ?? envFiles[key.env] ?? stored[key.env]);
    const merged = merge(key, raw, mine);
    if (merged.value !== null) {
      values[key.env] = merged.value;
      applied.push(key.path);
    }
    if (merged.notice) refused.push(merged.notice);
  }

  // Silent is the wrong default for a file someone else committed: say what it changed, and
  // say what it was not allowed to change.
  if (applied.length) notices.push(`${PROJECT_CONFIG_RELPATH} applied: ${applied.join(", ")}`);
  for (const notice of refused) notices.push(`${PROJECT_CONFIG_RELPATH}: ${notice}`);
  for (const unknown of leaves.keys()) {
    notices.push(
      `${PROJECT_CONFIG_RELPATH}: ignoring "${unknown}" — not on the project-config allowlist`,
    );
  }
  return { values, notices, path };
}
