/**
 * Ctrl+Z job control for the TUI. Raw mode disables ISIG, so the terminal never delivers
 * SIGTSTP itself — the app's Ctrl+Z binding calls suspendToShell(), which restores the
 * terminal to a shell-usable state (the mirror of main.ts's shutdown writes), cooks the
 * tty, and stops the process with a self-SIGTSTP. `fg` (SIGCONT) reverses everything and
 * invokes the registered resume callback so the app repaints the live region.
 */

let resumeCallback: (() => void) | null = null;

/** The app registers a repaint trigger here (a state-bump); cleared on unmount. */
export function setResumeCallback(fn: (() => void) | null): void {
  resumeCallback = fn;
}

export function suspendToShell(): void {
  const out = process.stdout;
  out.write("\u001b[?2004l");
  out.write("\u001b[?25h");
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    // not a tty (tests) — job control still works, the tty state just isn't ours
  }
  process.once("SIGCONT", resume);
  process.kill(process.pid, "SIGTSTP");
}

function resume(): void {
  try {
    process.stdin.setRawMode?.(true);
  } catch {
    // see above
  }
  const out = process.stdout;
  out.write("\u001b[?25l");
  out.write("\u001b[?2004h");
  resumeCallback?.();
}
