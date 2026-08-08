/**
 * Compose the prompt in $EDITOR — the readline Ctrl+X Ctrl+E convention, plus /editor.
 *
 * The hard part is not spawning an editor, it is handing over the terminal and getting it
 * back. Ink owns raw mode, the cursor, bracketed paste and a stdin 'readable' pump; a
 * full-screen editor wants all four. suspend.ts is the mirror for most of this, but SIGTSTP
 * freezes the WHOLE process — a spawned child does not — so three steps are needed here that
 * job control never needs:
 *
 *  - detachStdin(): Ink's stdin listeners are REMOVED, not just paused, and re-added in
 *    original order afterwards. Otherwise Ink and the editor both read fd 0 and race for
 *    every keystroke. Ink's own setRawMode(false) is not usable — it is refcounted across
 *    every mounted useInput, so one call decrements without detaching. And Node's pause() is
 *    a no-op while a 'readable' listener is attached, which is why detach comes BEFORE pause.
 *  - resetFilter(): input-filter.ts may be holding a half-received CSI or queued keypress
 *    units that describe a terminal state which no longer exists. Called twice — before the
 *    spawn, and again in the restore as the safety net if the reader stole bytes anyway.
 *  - a no-op SIGINT listener: raw mode is off during the edit, so ISIG is live and Ctrl+C
 *    would signal the whole foreground process group, us included.
 *
 * Steps 5-18 sit inside try/finally so a throwing spawn can never leave a cooked terminal
 * with a hidden cursor and detached stdin. The restore is the exact reverse of the teardown.
 * The `?1049l` in the restore is DEFENSIVE: it leaves the alternate screen in case a
 * full-screen editor was SIGKILLed without restoring it itself.
 *
 * Everything impure is behind the EditorIo seam (the deps.write pattern from
 * plan_finalize.ts), so the ORDER of the handover is directly assertable in bun test — which
 * matters because nothing else here is: that the child really gets the controlling terminal
 * was verified by spike, not by the suite.
 *
 * OUTCOMES follow git's `git commit` contract, because a draft has no undo: a non-zero exit
 * (vim's `:cq`) and an emptied buffer both KEEP the draft rather than destroying it. Every
 * keep path is genuinely lossless — nothing is set and the composer never remounts.
 */

import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetInputFilter } from "./input-filter.ts";

const ESC = String.fromCharCode(27);
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;
const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CURSOR_HIDE = `${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;

/** Below this, an "editor" that changed nothing almost certainly forked and returned. */
export const GUI_EDITOR_MS = 300;

export const NOTICE = {
  notTty: "editor: no terminal attached — nothing opened.",
  noEditor: "editor: set $EDITOR (or $VISUAL) — no editor found on PATH.",
  noChanges: "editor: no changes.",
  guiHint: 'editor: no changes — a GUI editor needs a wait flag, try EDITOR="code --wait".',
  emptied: "editor: buffer was emptied — draft kept.",
  cancelled: "editor: exited non-zero — draft kept.",
  unreadable: "editor: could not read the edited file — draft kept.",
  applied: "editor: draft updated.",
} as const;

// -- pure core ---------------------------------------------------------------------------

/**
 * Split an $EDITOR value into argv, POSIX-style: double quotes, single quotes, backslash
 * escapes, whitespace collapse. So `code --wait` and `vim -u NONE` both work.
 *
 * An unquoted path containing spaces splits into several arguments — that is the shell's
 * behavior and therefore the right one; a user with such a path must quote it, exactly as
 * they would anywhere else. The temp path is APPENDED as its own argv element and never
 * string-concatenated, so a temp path with spaces is safe regardless.
 */
export function splitEditorArgv(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && i + 1 < s.length) {
        cur += s[i + 1]!;
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1]!;
      started = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started) out.push(cur);
  return out;
}

/** PATH probe order for a user with no $EDITOR — see resolveEditor. */
export const EDITOR_FALLBACKS = ["nano", "vi", "vim"] as const;

export interface ResolvedEditor {
  argv: string[];
  source: "VISUAL" | "EDITOR" | "fallback";
}

/**
 * $VISUAL -> $EDITOR -> probe nano, vi, vim. VISUAL-first is the POSIX/git convention.
 * Empty or whitespace-only is treated as absent, so `EDITOR=` behaves like unset.
 *
 * nano leads the fallback deliberately: a user with no $EDITOR is by definition not a vi
 * user, and dropping them into modal vim with no way out is worse than the problem solved.
 */
export function resolveEditor(
  env: Record<string, string | undefined>,
  which: (bin: string) => string | null,
): ResolvedEditor | null {
  for (const key of ["VISUAL", "EDITOR"] as const) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const argv = splitEditorArgv(raw);
    if (argv.length > 0) return { argv, source: key };
  }
  for (const bin of EDITOR_FALLBACKS) {
    if (which(bin)) return { argv: [bin], source: "fallback" };
  }
  return null;
}

/** Strip a BOM, normalize CRLF (and lone CR) to LF, drop trailing newlines only. */
export function normalizeEditedText(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return noBom.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

export interface EditorDecisionInput {
  seed: string;
  /** File contents after the edit, or null when it could not be read. */
  raw: string | null;
  /** Child exit code, or null when it never ran. */
  exitCode: number | null;
  spawnError: string | null;
  elapsedMs: number;
}

export interface EditorOutcome {
  /** True only when `text` should replace the composer draft. */
  apply: boolean;
  text: string | null;
  notice: string;
  isError: boolean;
}

/**
 * The whole outcome table, pure so every row is a unit test. `elapsedMs` is an input rather
 * than a clock read for exactly that reason.
 */
export function decideEditorOutcome(input: EditorDecisionInput): EditorOutcome {
  const { seed, raw, exitCode, spawnError, elapsedMs } = input;
  if (spawnError !== null) {
    return { apply: false, text: null, notice: `editor: ${spawnError}`, isError: true };
  }
  if (exitCode !== 0) {
    return { apply: false, text: null, notice: NOTICE.cancelled, isError: false };
  }
  if (raw === null) {
    return { apply: false, text: null, notice: NOTICE.unreadable, isError: true };
  }
  const text = normalizeEditedText(raw);
  if (text === seed) {
    const notice = elapsedMs < GUI_EDITOR_MS ? NOTICE.guiHint : NOTICE.noChanges;
    return { apply: false, text: null, notice, isError: false };
  }
  if (text === "" && seed !== "") {
    return { apply: false, text: null, notice: NOTICE.emptied, isError: false };
  }
  return { apply: true, text, notice: NOTICE.applied, isError: false };
}

/** Where the draft is parked while the editor holds it — never cwd (see runEditorSession). */
export function composeTempPath(runId: string | null | undefined, dir = tmpdir()): string {
  const who = runId?.trim() ? runId.trim() : String(process.pid);
  const nonce = Math.random().toString(36).slice(2, 10);
  return join(dir, `minima-compose-${who}-${nonce}.md`);
}

// -- the impure seam ---------------------------------------------------------------------

export interface EditorIo {
  stdoutWrite(s: string): void;
  /** Remove Ink's stdin listeners; the returned closure re-adds them in original order. */
  detachStdin(): () => void;
  pauseStdin(): void;
  resumeStdin(): void;
  setRawMode(on: boolean): void;
  resetFilter(): void;
  /** Install the no-op SIGINT guard; the returned closure removes it. */
  guardSignals(): () => void;
  spawn(argv: string[]): { exitCode: number | null };
  writeFile(path: string, content: string): void;
  chmod600(path: string): void;
  readFile(path: string): string;
  removeFile(path: string): void;
  now(): number;
  isTty(): boolean;
}

export function defaultEditorIo(): EditorIo {
  return {
    stdoutWrite: (s) => {
      process.stdout.write(s);
    },
    detachStdin: () => {
      const stdin = process.stdin;
      const readable = stdin.listeners("readable").slice();
      const data = stdin.listeners("data").slice();
      stdin.removeAllListeners("readable");
      stdin.removeAllListeners("data");
      return () => {
        for (const fn of readable) stdin.on("readable", fn as (...a: unknown[]) => void);
        for (const fn of data) stdin.on("data", fn as (...a: unknown[]) => void);
      };
    },
    pauseStdin: () => {
      process.stdin.pause();
    },
    resumeStdin: () => {
      process.stdin.resume();
    },
    setRawMode: (on) => {
      process.stdin.setRawMode?.(on);
    },
    resetFilter: () => resetInputFilter(),
    guardSignals: () => {
      const noop = (): void => {};
      process.on("SIGINT", noop);
      return () => {
        process.removeListener("SIGINT", noop);
      };
    },
    spawn: (argv) => {
      const [bin, ...rest] = argv;
      // ENOENT THROWS out of spawnSync rather than returning a code — the caller catches it.
      const res = Bun.spawnSync([bin!, ...rest], { stdio: ["inherit", "inherit", "inherit"] });
      return { exitCode: res.exitCode };
    },
    writeFile: (path, content) => {
      writeFileSync(path, content, { mode: 0o600 });
    },
    chmod600: (path) => {
      chmodSync(path, 0o600);
    },
    readFile: (path) => readFileSync(path, "utf8"),
    removeFile: (path) => {
      unlinkSync(path);
    },
    now: () => Date.now(),
    isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

export interface EditorSessionOpts {
  seed: string;
  /** The editor argv WITHOUT the file path — the path is appended, never concatenated. */
  argv: string[];
  path: string;
}

/**
 * The handover. Pre-flight mutates no terminal state, so bailing costs nothing and an
 * interactive TUI with non-TTY stdio returns one notice without ever reaching spawnSync —
 * it cannot hang.
 *
 * The temp file lives in tmpdir(), not cwd: a stray file in the repo would show up in
 * `git status` AND be swept into a git-shadow checkpoint. Mode 0600, contents byte-exact
 * with no banner (the whole body becomes the prompt), unlinked on every path. A SIGKILL
 * mid-edit leaks one small file — accepted, matching checkpoint.ts; a sweeper would be a
 * second failure surface for a file measured in kilobytes.
 */
export function runEditorSession(
  opts: EditorSessionOpts,
  io: EditorIo = defaultEditorIo(),
): EditorOutcome {
  const { seed, argv, path } = opts;
  if (!io.isTty()) {
    return { apply: false, text: null, notice: NOTICE.notTty, isError: false };
  }
  try {
    io.writeFile(path, seed);
    io.chmod600(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { apply: false, text: null, notice: `editor: ${msg}`, isError: true };
  }
  const t0 = io.now();

  let reattach: (() => void) | null = null;
  let releaseSignals: (() => void) | null = null;
  let exitCode: number | null = null;
  let spawnError: string | null = null;

  try {
    io.stdoutWrite(BRACKETED_PASTE_OFF);
    io.stdoutWrite(CURSOR_SHOW);
    reattach = io.detachStdin();
    io.pauseStdin();
    try {
      io.setRawMode(false);
    } catch {
      // not a tty by the time we got here — the child still runs, the tty state isn't ours
    }
    io.resetFilter();
    releaseSignals = io.guardSignals();
    try {
      exitCode = io.spawn([...argv, path]).exitCode;
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    try {
      io.setRawMode(true);
    } catch {
      // see above
    }
    io.resetFilter();
    io.resumeStdin();
    reattach?.();
    releaseSignals?.();
    io.stdoutWrite(ALT_SCREEN_OFF);
    io.stdoutWrite(CURSOR_HIDE);
    io.stdoutWrite(BRACKETED_PASTE_ON);
  }

  let raw: string | null = null;
  try {
    // By PATH, not by handle: vim's default backupcopy REPLACES the inode, so a descriptor
    // opened before the edit would read the old file.
    raw = io.readFile(path);
  } catch {
    raw = null;
  } finally {
    try {
      io.removeFile(path);
    } catch {
      // already gone, or a tmpdir we cannot write — nothing actionable
    }
  }

  return decideEditorOutcome({ seed, raw, exitCode, spawnError, elapsedMs: io.now() - t0 });
}

export interface OpenEditorOpts {
  runId?: string | null;
  env?: Record<string, string | undefined>;
  which?: (bin: string) => string | null;
  tmpDir?: string;
}

/** Resolve an editor, park the draft, run the session. The one call site app.tsx needs. */
export function openEditorForDraft(
  seed: string,
  opts: OpenEditorOpts = {},
  io: EditorIo = defaultEditorIo(),
): EditorOutcome {
  const env = opts.env ?? process.env;
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const resolved = resolveEditor(env, which);
  if (!resolved) {
    return { apply: false, text: null, notice: NOTICE.noEditor, isError: true };
  }
  return runEditorSession(
    { seed, argv: resolved.argv, path: composeTempPath(opts.runId, opts.tmpDir) },
    io,
  );
}
