import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the two-renderer wiring in main.ts:
//  - INLINE (default, like Claude Code's REPL): main buffer + <Static> native scrollback, with a
//    one-time newline reserve so the prompt still starts at the bottom. Native scroll + select + copy.
//  - FULLSCREEN (--fullscreen / MINIMA_TUI_FULLSCREEN=1): alternate screen buffer + glued prompt +
//    in-app scroll + frame-anchored overlays.
// The alt-screen writes MUST stay guarded by the fullscreen flag — an unconditional [?1049h would
// give inline mode a buffer with no scrollback and re-break "can't scroll the session".
describe("cli/main.ts wires both TUI renderers", () => {
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");

  test("mode is chosen from args.fullscreen (inline default; --fullscreen / MINIMA_TUI_FULLSCREEN opts in)", () => {
    expect(src).toContain("if (args.fullscreen)");
    expect(src).toContain("MINIMA_TUI_FULLSCREEN");
    expect(src).toContain("--no-fullscreen");
  });

  test("fullscreen enters and leaves the alternate screen buffer", () => {
    expect(src).toContain("?1049h");
    expect(src).toContain("?1049l");
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
