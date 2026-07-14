/**
 * Per-project persistence for the Shift+Tab permission mode (~/.minima-harness/ui-modes.json).
 * Deliberately tiny and synchronous — read once at startup, written on mode change. `bypass`
 * is NEVER persisted: it must be re-consented every session (CLI flag or /mode bypass).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMode } from "../agent/modes.ts";

const PERSISTABLE: readonly AgentMode[] = ["build", "acceptEdits", "plan"];

function prefsDir(): string {
  return process.env.MINIMA_HARNESS_DIR?.trim() || join(homedir(), ".minima-harness");
}

function prefsPath(): string {
  return join(prefsDir(), "ui-modes.json");
}

function readAll(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {}; // missing/corrupt file — start fresh
  }
}

/** The persisted mode for a project, or null (unknown project / bad value). */
export function loadPersistedMode(projectKey: string): AgentMode | null {
  const raw = readAll()[projectKey];
  return PERSISTABLE.includes(raw as AgentMode) ? (raw as AgentMode) : null;
}

/** Persist the mode for a project; bypass (or an unknown value) is ignored. */
export function persistMode(projectKey: string, mode: AgentMode): void {
  if (!PERSISTABLE.includes(mode)) return;
  try {
    const all = readAll();
    if (all[projectKey] === mode) return;
    all[projectKey] = mode;
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(prefsPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort — never let it break the TUI.
  }
}
