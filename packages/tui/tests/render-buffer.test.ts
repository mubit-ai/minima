import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the inline renderer wiring in main.ts (the only renderer since MP3, MUB-146):
// main buffer + <Static> native scrollback. Native scroll + select + copy — the alternate
// screen buffer must never come back (it has no scrollback: "can't scroll the session").
describe("cli/main.ts wires the inline renderer", () => {
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");

  test("no renderer selection and no alt-screen writes remain", () => {
    expect(src).not.toContain("fullscreen");
    expect(src).not.toContain("MINIMA_TUI_FULLSCREEN");
    expect(src).not.toContain("?1049");
  });

  test("inline starts with a full clear (screen + scrollback) — clean-slate CC-style start", () => {
    // [2J erases the visible screen, [3J drops prior scrollback (no leftover shell/prev session
    // above), [H homes the cursor. Within-session scroll-up works on fresh scrollback thereafter.
    expect(src).toContain("[2J\\u001b[3J\\u001b[H");
  });

  test("inline renders from the top (no bottom-glued newline reserve — CC-style)", () => {
    // The prompt must NOT be force-pushed to the bottom row; content grows downward from the top.
    expect(src).not.toContain('"\\n".repeat('); // the removed rows-1 reserve
    expect(src).not.toContain("stdout.rows ?? 24"); // its only consumer in main.ts
  });
});
