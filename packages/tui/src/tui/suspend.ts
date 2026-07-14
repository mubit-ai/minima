/**
 * Ctrl+Z job control for the TUI. Raw mode disables ISIG, so the terminal never delivers
 * SIGTSTP itself — the app's Ctrl+Z binding calls suspendToShell(), which restores the
 * terminal to a shell-usable state (the mirror of main.ts's shutdown writes), cooks the
 * tty, and stops the process with a self-SIGTSTP. `fg` (SIGCONT) reverses everything and
 * invokes the registered resume callback so the app repaints — in fullscreen any commit
 * repaints the whole frame, so a state bump is a full redraw.
 */

let resumeCallback: (() => void) | null = null;

/** The app registers a repaint trigger here (a state-bump); cleared on unmount. */
export function setResumeCallback(fn: (() => void) | null): void {
  resumeCallback = fn;
}

export interface SuspendOptions {
  fullscreen: boolean;
  /** Re-arm SGR mouse capture on resume (the /mouse state at suspend time). */
  mouse: boolean;
}

export function suspendToShell(opts: SuspendOptions): void {
  const out = process.stdout;
  if (opts.mouse) {
    out.write("\u001b[?1006l");
    out.write("\u001b[?1000l");
  }
  out.write("\u001b[?2004l");
  if (opts.fullscreen) out.write("\u001b[?1049l");
  out.write("\u001b[?25h");
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    // not a tty (tests) — job control still works, the tty state just isn't ours
  }
  process.once("SIGCONT", () => resume(opts));
  process.kill(process.pid, "SIGTSTP");
}

function resume(opts: SuspendOptions): void {
  try {
    process.stdin.setRawMode?.(true);
  } catch {
    // see above
  }
  const out = process.stdout;
  if (opts.fullscreen) out.write("\u001b[?1049h");
  out.write("\u001b[?25l");
  out.write("\u001b[?2004h");
  if (opts.mouse) {
    out.write("\u001b[?1000h");
    out.write("\u001b[?1006h");
  }
  resumeCallback?.();
}
