/**
 * Per-project persistence for bash command-family grants (~/.minima-harness/perm-grants.json).
 * "[a] Always allow `pip` commands" on the bash permission prompt lands here so the grant
 * survives restarts (Claude Code parity: prefix-scoped allowlist rules, per project). Same
 * deliberately tiny, synchronous, best-effort shape as mode_prefs.ts — read once at startup,
 * written on each new grant.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function prefsDir(): string {
  return process.env.MINIMA_HARNESS_DIR?.trim() || join(homedir(), ".minima-harness");
}

function grantsPath(): string {
  return join(prefsDir(), "perm-grants.json");
}

function readAll(): Record<string, { bash?: unknown }> {
  try {
    const parsed = JSON.parse(readFileSync(grantsPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {}; // missing/corrupt file — start fresh
  }
}

function sanitize(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && !!f) : [];
}

/** The persisted bash command families for a project ([] when none). */
export function loadBashGrants(projectKey: string): string[] {
  return sanitize(readAll()[projectKey]?.bash);
}

/** Persist bash command families for a project, merged with any existing grants. */
export function persistBashGrants(projectKey: string, families: string[]): void {
  try {
    const all = readAll();
    const current = sanitize(all[projectKey]?.bash);
    if (families.every((f) => current.includes(f))) return;
    all[projectKey] = { ...all[projectKey], bash: [...new Set([...current, ...families])].sort() };
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(grantsPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort — never let it break the TUI.
  }
}
