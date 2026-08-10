/**
 * Desktop notifications for the TUI.
 *
 * Two channels, both pure terminal escapes and no subprocess: OSC 9 (`ESC ]9;<body>BEL` —
 * the emulator raises a real desktop banner; honoured by Ghostty, WezTerm, iTerm2, kitty,
 * and wrapped in the tmux passthrough envelope when $TMUX is set, exactly as OSC 52 is in
 * clipboard.ts) and a plain BEL, which every terminal turns into its own attention signal
 * (bounce/badge/audible bell) even when OSC 9 is unknown to it. There is deliberately no
 * native channel (terminal-notifier/osascript/notify-send): it would buy platform branches
 * and a spawned process for a banner the terminal already knows how to draw.
 *
 * Like OSC 52 these sequences print zero cells and move the cursor zero times, so writing
 * one mid-session cannot disturb Ink's frame diff.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Cap on the notification body — a banner is a glance, not a transcript. */
const MAX_BODY = 120;

/**
 * Strip every C0 control (plus DEL) and cap the length.
 *
 * This is a security boundary, not tidiness: the body carries model- and tool-derived text.
 * A raw BEL inside it terminates the OSC string early and the remainder lands on screen as
 * literal cells; a raw ESC injects arbitrary escape codes into the user's terminal.
 */
function sanitizeBody(body: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
  return body.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_BODY);
}

/** OSC 9 desktop-notification sequence, tmux-passthrough-wrapped when inside tmux. */
export function osc9Sequence(body: string, tmux = Boolean(process.env.TMUX)): string {
  // Sanitize BEFORE the wrap, so the envelope's own ESC/BEL survive.
  const seq = `${ESC}]9;${sanitizeBody(body)}${BEL}`;
  // tmux forwards DCS-wrapped sequences to the outer terminal (ESC doubled inside).
  return tmux ? `${ESC}Ptmux;${seq.split(ESC).join(`${ESC}${ESC}`)}${ESC}\\` : seq;
}

/** The bare bell — the fallback channel for emulators that ignore OSC 9. */
export function bellSequence(): string {
  return BEL;
}

/**
 * Should a finished turn notify? Pure so the anti-annoyance policy is testable without a
 * terminal. Short turns stay silent — the user is still watching; `minMs <= 0` always fires.
 */
export function shouldNotifyTurnEnd(elapsedMs: number, minMs: number): boolean {
  return elapsedMs >= minMs;
}

/**
 * Raise a notification on both channels. Returns which ones were written.
 *
 * No-ops entirely when stdout is not a TTY, so headless `--print` runs and piped stdin never
 * emit control bytes into captured output. The stream is injectable so the write is testable
 * without a real terminal.
 */
export function notify(
  body: string,
  out: NodeJS.WriteStream = process.stdout,
): { osc9: boolean; bell: boolean } {
  if (!out.isTTY) return { osc9: false, bell: false };
  let osc9 = false;
  try {
    out.write(osc9Sequence(body));
    osc9 = true;
  } catch {
    // stdout gone — nothing to do
  }
  let bell = false;
  try {
    out.write(bellSequence());
    bell = true;
  } catch {
    // stdout gone — nothing to do
  }
  return { osc9, bell };
}
