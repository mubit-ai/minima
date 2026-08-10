/**
 * Reading source files the ledger recorded, and handing one to an editor.
 *
 * The security shape here is deliberate and worth reading before changing it: **a request never
 * supplies a filesystem path.** It supplies a *ledger row reference* — a plan id plus the exact
 * `file_changes.path` string as recorded. The server looks that row up, resolves it itself
 * against the run's `runs.project_key`, and only then touches the disk. Path traversal is
 * therefore not filtered, it is structurally impossible: there is no user-controlled string on
 * the path that reaches `open()`.
 *
 * Two things still need checking, because a recorded path is not automatically a safe one:
 *  - a RELATIVE row must still resolve (after realpath, so symlinks are followed) to somewhere
 *    inside the project root — a repo file symlinked to /etc/passwd is a real shape;
 *  - reads are capped, because an uncapped read is the one way this server eats RAM, which is
 *    the constraint the whole dashboard is built around.
 *
 * The fs lives here rather than in `stats.ts` so that module stays pure over row arrays.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/** Hard read ceiling. Past this a head/tail excerpt is served with an explicit banner. */
export const MAX_BYTES = 512 * 1024;
/** Rendering ceiling — a 40k-line file would produce megabytes of HTML. */
export const MAX_LINES = 2_000;
const EXCERPT_HEAD = 400;
const EXCERPT_TAIL = 120;

export type FileStatus = "ok" | "truncated" | "missing" | "binary" | "escaped" | "unresolvable";

export interface FileContent {
  /** The path as the ledger recorded it — relative for 234 of 241 rows on a real ledger. */
  path: string;
  /** Resolved absolute path, or null when the run recorded no project root to resolve against. */
  absPath: string | null;
  status: FileStatus;
  bytes: number | null;
  /** Total lines in the file, even when only an excerpt is returned. */
  lines: number | null;
  /** Rendered lines, each with its 1-based number. A gap marks an elided middle. */
  shown: { n: number; text: string }[];
  /** Set when `shown` skips a middle section. */
  elided: number | null;
  /** Human-readable reason, always present for a non-`ok` status. */
  note: string | null;
}

/**
 * Resolve a recorded path to an absolute one. Relative rows join the run's project root; the 7
 * absolute rows in a real ledger are already absolute and pass through.
 */
export function resolveRecorded(projectKey: string | null, path: string): string | null {
  if (!path) return null;
  if (isAbsolute(path)) return path;
  if (!projectKey) return null;
  return resolve(projectKey, path);
}

/** True when `child` is `root` itself or sits underneath it. Both must already be realpath'd. */
export function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Read a recorded file for display. Never throws for the ordinary failures — a deleted file, an
 * escaping symlink and a binary blob are all reported as states, because a viewer that 500s on a
 * path the ledger legitimately contains is worse than one that explains itself.
 */
export async function readRecorded(projectKey: string | null, path: string): Promise<FileContent> {
  const base: FileContent = {
    path,
    absPath: null,
    status: "unresolvable",
    bytes: null,
    lines: null,
    shown: [],
    elided: null,
    note: null,
  };

  const absPath = resolveRecorded(projectKey, path);
  if (!absPath) {
    return {
      ...base,
      note: "this run recorded no project root, so a relative path cannot be resolved",
    };
  }

  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    return {
      ...base,
      absPath,
      status: "missing",
      note: "not in this checkout — the file was deleted, or its project directory moved",
    };
  }

  // A relative row must stay inside the project root even after symlinks are followed.
  if (!isAbsolute(path) && projectKey) {
    let root: string;
    try {
      root = await realpath(projectKey);
    } catch {
      root = resolve(projectKey);
    }
    if (!isInside(root, real)) {
      return {
        ...base,
        absPath,
        status: "escaped",
        note: "resolves outside its project root through a symlink — refusing to read it",
      };
    }
  }

  const info = await stat(real).catch(() => null);
  if (!info || !info.isFile()) {
    return {
      ...base,
      absPath,
      status: "missing",
      note: info ? "not a regular file" : "not in this checkout",
    };
  }

  const bytes = info.size;
  const slice =
    bytes > MAX_BYTES
      ? await Bun.file(real).slice(0, MAX_BYTES).text()
      : await Bun.file(real).text();

  // A NUL byte anywhere in the read is the cheap, reliable binary tell.
  if (slice.includes("\u0000")) {
    return {
      ...base,
      absPath,
      status: "binary",
      bytes,
      note: "binary file — not rendered",
    };
  }

  const all = slice.split("\n");
  const overBytes = bytes > MAX_BYTES;
  const overLines = all.length > MAX_LINES;
  if (!overBytes && !overLines) {
    return {
      ...base,
      absPath,
      status: "ok",
      bytes,
      lines: all.length,
      shown: all.map((text, i) => ({ n: i + 1, text })),
    };
  }

  const head = all.slice(0, EXCERPT_HEAD).map((text, i) => ({ n: i + 1, text }));
  const tailStart = Math.max(EXCERPT_HEAD, all.length - EXCERPT_TAIL);
  const tail = all.slice(tailStart).map((text, i) => ({ n: tailStart + i + 1, text }));
  return {
    ...base,
    absPath,
    status: "truncated",
    bytes,
    lines: all.length,
    shown: [...head, ...tail],
    elided: Math.max(0, tailStart - EXCERPT_HEAD),
    note: overBytes
      ? `file is ${Math.round(bytes / 1024)}KB, over the ${Math.round(MAX_BYTES / 1024)}KB read cap — showing the first ${EXCERPT_HEAD} and last ${EXCERPT_TAIL} lines of the capped read`
      : `file has ${all.length} lines, over the ${MAX_LINES}-line render cap — showing the first ${EXCERPT_HEAD} and last ${EXCERPT_TAIL}`,
  };
}

/**
 * argv builders per editor. An ARRAY, never a shell string — nothing here is ever interpolated
 * into a command line, so a path containing `;` or `$(…)` is inert rather than clever.
 */
const EDITORS: Record<string, (abs: string, line: number | null) => string[]> = {
  code: (abs, line) => (line ? ["code", "-g", `${abs}:${line}`] : ["code", abs]),
  cursor: (abs, line) => (line ? ["cursor", "-g", `${abs}:${line}`] : ["cursor", abs]),
  windsurf: (abs, line) => (line ? ["windsurf", "-g", `${abs}:${line}`] : ["windsurf", abs]),
  zed: (abs, line) => (line ? ["zed", `${abs}:${line}`] : ["zed", abs]),
  subl: (abs, line) => (line ? ["subl", `${abs}:${line}`] : ["subl", abs]),
  idea: (abs, line) => (line ? ["idea", "--line", String(line), abs] : ["idea", abs]),
  webstorm: (abs, line) => (line ? ["webstorm", "--line", String(line), abs] : ["webstorm", abs]),
  vim: (abs, line) => (line ? ["vim", `+${line}`, abs] : ["vim", abs]),
  nvim: (abs, line) => (line ? ["nvim", `+${line}`, abs] : ["nvim", abs]),
};

export const EDITOR_NAMES = Object.keys(EDITORS);

/** The argv a given editor would be launched with. Exported so the shape is testable. */
export function editorArgv(editor: string, absPath: string, line: number | null): string[] | null {
  const build = EDITORS[editor];
  return build ? build(absPath, line) : null;
}

/**
 * Which editor to launch: the explicit flag, else the first known one on PATH, else none.
 * Sync, so `startDashboard` does not have to become async just to resolve a command name.
 */
export function detectEditor(explicit?: string | null): string | null {
  if (explicit === "none") return null;
  if (explicit) return explicit in EDITORS ? explicit : null;
  for (const name of ["cursor", "code", "windsurf", "zed", "subl", "nvim", "vim"]) {
    if (Bun.which(name)) return name;
  }
  return null;
}

export interface OpenResult {
  ok: boolean;
  error?: string;
  argv?: string[];
}

/**
 * Hand an absolute path to the editor. `line` is coerced through parseInt by the caller so a
 * crafted value can never arrive as anything but a number or null.
 */
export async function openInEditor(
  editor: string | null,
  absPath: string,
  line: number | null,
): Promise<OpenResult> {
  if (!editor) return { ok: false, error: "no_editor" };
  const argv = editorArgv(editor, absPath, line);
  if (!argv) return { ok: false, error: "unknown_editor" };
  try {
    // Detached, and every stream IGNORED rather than piped. A pipe nobody reads is the
    // non-draining shape that has bitten this codebase before: `proc.unref()` returns
    // immediately, so a `stderr: "pipe"` here had no reader at all, and an editor chatty
    // enough to fill the ~64KB pipe buffer would block on write forever.
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
    return { ok: true, argv };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
