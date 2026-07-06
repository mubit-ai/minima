import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the "can't scroll the session" fix. The interactive TUI must render INLINE
// in the terminal's MAIN screen buffer so Ink's <Static> transcript lands in native scrollback
// (wheel/trackpad scroll + select/copy). Entering the alternate screen buffer ([?1049h) gives a
// buffer with NO scrollback and silently re-breaks scrolling — the exact bug this fix removed.
describe("cli/main.ts renders inline (no alternate screen buffer)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");

  test("does not enter or leave the alternate screen buffer (?1049h / ?1049l)", () => {
    expect(src).not.toContain("?1049h");
    expect(src).not.toContain("?1049l");
  });

  test("seats the first paint at the bottom via a one-time startup newline reserve", () => {
    // A screen-height block of newlines scrolls prior shell output into scrollback and puts the
    // live region (prompt + status) at the bottom of the viewport, like Codex's inline viewport.
    expect(src).toContain("process.stdout.rows");
    expect(src).toContain(".repeat(");
  });
});
