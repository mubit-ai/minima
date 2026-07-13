/**
 * System clipboard bridge for the TUI.
 *
 * Copy goes out on TWO channels at once: OSC 52 (the terminal writes its host clipboard —
 * works in iTerm2/kitty/Ghostty, over SSH, and through tmux when `set-clipboard on`; wrapped
 * in the tmux passthrough envelope when $TMUX is set) and a local CLI (`pbcopy` on macOS,
 * wl-copy/xclip on Linux) as the belt-and-suspenders path for emulators without OSC 52
 * (e.g. Terminal.app). Paste-read uses the CLI only — OSC 52 reads are a security prompt
 * or disabled in most terminals.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const COPY_CMDS: string[][] = [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]];
const PASTE_CMDS: string[][] = [
  ["pbpaste"],
  ["wl-paste", "--no-newline"],
  ["xclip", "-selection", "clipboard", "-o"],
];

/** OSC 52 copy sequence for `text`, tmux-passthrough-wrapped when inside tmux. */
export function osc52Sequence(text: string, tmux = Boolean(process.env.TMUX)): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const seq = `${ESC}]52;c;${b64}${BEL}`;
  // tmux forwards DCS-wrapped sequences to the outer terminal (ESC doubled inside).
  return tmux ? `${ESC}Ptmux;${seq.split(ESC).join(`${ESC}${ESC}`)}${ESC}\\` : seq;
}

/** Copy via OSC 52 + local CLI. Returns which channels were attempted/succeeded. */
export function copyToClipboard(text: string): { osc52: boolean; cli: boolean } {
  let osc52 = false;
  try {
    process.stdout.write(osc52Sequence(text));
    osc52 = true;
  } catch {
    // stdout gone — nothing to do
  }
  let cli = false;
  for (const cmd of COPY_CMDS) {
    try {
      const r = Bun.spawnSync(cmd, { stdin: Buffer.from(text, "utf8") });
      if (r.exitCode === 0) {
        cli = true;
        break;
      }
    } catch {
      // command not present — try the next one
    }
  }
  return { osc52, cli };
}

/** Read the system clipboard via the local CLI; null when unavailable. */
export function readClipboard(): string | null {
  for (const cmd of PASTE_CMDS) {
    try {
      const r = Bun.spawnSync(cmd);
      if (r.exitCode === 0) return r.stdout.toString();
    } catch {
      // command not present — try the next one
    }
  }
  return null;
}
