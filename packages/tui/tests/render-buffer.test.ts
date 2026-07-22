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

  test("boot leaves the cursor at HOME — no newline reserve (R1 top-anchor, reverses THE RULE's bottom seat)", () => {
    // The transcript prints from the TOP of the cleared screen (banner first, echo under it);
    // the composer seats at the bottom via the ledger's cap-seeded flex-end frame, not a
    // one-time newline reserve. tui-verify's first-prompt scenario asserts the rendered
    // result in a real PTY (banner top, echo under the header, composer bottom).
    expect(src).not.toContain('"\\n".repeat');
  });

  test("boot resets inherited scroll margins BEFORE the clear (the 2026-07-20 stale-DECSTBM fix)", () => {
    // A prior CLI that pinned its UI with CSI <t>;<b>r and died uncleanly leaves the
    // margins in the window FOREVER (they survive 2J/3J/H and resizes) — the reserve then
    // scrolls inside the stale region and the composer seats mid-screen. CSI r + CSI ?69l
    // must lead the clear write so the reserve always acts on a full-screen region.
    expect(src).toContain("[r\\u001b[?69l\\u001b[2J\\u001b[3J\\u001b[H");
  });
});

// MUB-169: /clear only bumped transcriptGen + emptied messages — the old transcript stayed
// in the terminal's scrollback and the banner repainted mid-screen over it. The handler must
// replay the boot physics: margin reset + full clear (screen AND scrollback) + home; the
// fresh generation then reprints from the TOP (R1 — no newline reserve anywhere) and the
// ledger's cap-seeded remount frame re-seats the composer at the bottom. /new shares the
// reseat (same gap).
describe("app.tsx /clear and /new reseat the terminal", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the reseat emits the boot sequence: margin reset + 2J/3J clear + home, and NO newline reserve", () => {
    expect(src).toContain("[r\\u001b[?69l\\u001b[2J\\u001b[3J\\u001b[H");
    expect(src).not.toContain('"\\n".repeat');
  });

  test("both /clear and /new go through the reseat (a gen bump alone leaves stale scrollback)", () => {
    const calls = src.match(/reseatFreshScreen\(\);/g) ?? [];
    expect(calls.length).toBe(2);
  });
});
