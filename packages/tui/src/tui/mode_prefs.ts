/**
 * Per-project persistence for the Shift+Tab permission mode (~/.minima-harness/ui-modes.json).
 * Deliberately tiny and synchronous — read once at startup, written on mode change.
 *
 * Only `acceptEdits` and `build` persist — the two that describe a standing preference about
 * a project ("I trust edits here"). The RESTRICTIVE modes are per-task state and must be
 * re-entered each session:
 *   bypass — must be re-consented every session (CLI flag or /mode bypass).
 *   plan   — denies write/edit/bash/apply_patch outright. Restoring it days after a
 *            Shift+Tab press gives the user a harness that refuses to do any work with no
 *            visible cause; "why does it start in plan mode?" is the reported symptom.
 * Because loadPersistedMode validates against PERSISTABLE, a `plan` written by an older
 * build reads back as null — existing prefs files self-heal with no migration.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMode } from "../agent/modes.ts";

const PERSISTABLE: readonly AgentMode[] = ["build", "acceptEdits"];

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

// D3a task-panel override (MP5). Same flat ui-modes.json, a SUFFIXED key — old builds
// only ever read all[projectKey] and validate against PERSISTABLE, so the extra key is
// invisible to them. Only the explicit HIDE persists; showing deletes the key, so new
// projects keep the auto-show default.
const TASK_PANEL_SUFFIX = "::task-panel";

/** True when the user explicitly hid the task panel for this project. */
export function loadTaskPanelHidden(projectKey: string): boolean {
  return readAll()[projectKey + TASK_PANEL_SUFFIX] === "hidden";
}

/** Persist (hidden=true) or clear (hidden=false) the per-project task-panel override. */
export function persistTaskPanelHidden(projectKey: string, hidden: boolean): void {
  try {
    const all = readAll();
    const key = projectKey + TASK_PANEL_SUFFIX;
    if (hidden) {
      if (all[key] === "hidden") return;
      all[key] = "hidden";
    } else {
      if (!(key in all)) return;
      delete all[key];
    }
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(prefsPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort — never let it break the TUI.
  }
}

// Fullscreen renderer preference (ADR decision-inline-renderer.md, 2026-07-31 amendments;
// fullscreen became the DEFAULT the same day by user decision). Tri-state on purpose: the
// /fullscreen toggle persists the user's explicit choice in either direction, and null
// (no key) lets main.ts apply the shipped default — so a future default flip never fights
// a stale stored value.
const FULLSCREEN_SUFFIX = "::fullscreen";

/** The persisted /fullscreen choice for a project: true, false, or null (never chosen). */
export function loadFullscreenPref(projectKey: string): boolean | null {
  const raw = readAll()[projectKey + FULLSCREEN_SUFFIX];
  return raw === "on" ? true : raw === "off" ? false : null;
}

/** Persist the explicit per-project /fullscreen choice (both directions). */
export function persistFullscreenPref(projectKey: string, on: boolean): void {
  try {
    const all = readAll();
    const key = projectKey + FULLSCREEN_SUFFIX;
    const value = on ? "on" : "off";
    if (all[key] === value) return;
    all[key] = value;
    mkdirSync(prefsDir(), { recursive: true });
    writeFileSync(prefsPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  } catch {
    // Persistence is best-effort — never let it break the TUI.
  }
}
