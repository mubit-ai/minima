/**
 * Alternate-screen lifecycle for the opt-in fullscreen renderer (ADR
 * decision-inline-renderer.md, 2026-07-31 amendment). The ONLY writers of the alt-screen
 * escapes — main.ts stays free of the literal (tests/render-buffer.test.ts pins that), and
 * the tracked state makes enter/exit idempotent so suspend/shutdown can call them blind.
 */

let active = false;

export function enterAltScreen(): void {
  if (active) return;
  active = true;
  process.stdout.write("\u001b[?1049h");
}

export function exitAltScreen(): void {
  if (!active) return;
  active = false;
  process.stdout.write("\u001b[?1049l");
}

export function altScreenActive(): boolean {
  return active;
}
