import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the two-renderer wiring in main.ts:
//  - FULLSCREEN (default): alternate screen buffer + glued prompt + in-app scroll (like Claude Code).
//  - INLINE (--no-fullscreen / MINIMA_TUI_INLINE=1): main buffer + <Static> native scrollback, with a
//    one-time newline reserve so the prompt still starts at the bottom.
// The alt-screen writes MUST stay guarded by the fullscreen flag — an unconditional [?1049h would
// give inline mode a buffer with no scrollback and re-break "can't scroll the session".
describe("cli/main.ts wires both TUI renderers", () => {
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8");

  test("mode is chosen from args.fullscreen (default on; --no-fullscreen / MINIMA_TUI_INLINE off)", () => {
    expect(src).toContain("if (args.fullscreen)");
    expect(src).toContain("MINIMA_TUI_INLINE");
    expect(src).toContain("--no-fullscreen");
  });

  test("fullscreen enters and leaves the alternate screen buffer", () => {
    expect(src).toContain("?1049h");
    expect(src).toContain("?1049l");
  });

  test("inline fallback seats the prompt via a startup newline reserve (no alt-screen)", () => {
    expect(src).toContain("process.stdout.rows");
    expect(src).toContain(".repeat(");
  });
});
