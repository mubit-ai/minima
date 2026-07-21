import { describe, expect, test } from "bun:test";
import cliTruncate from "cli-truncate";
import stringWidth from "string-width";

// Ink's wrap="truncate" (build/wrap-text.js) cuts lines with cli-truncate, while its
// layout budgets them with string-width. If the two disagree on ANY glyph's width, a
// truncated row can come out physically wider than the budget, the terminal autowraps
// it, and every repaint scrolls the frame one row — the runaway blank-line loop seen
// live when `/budget mode enforce` put ⛔ into the (truncating) footer row. This pins
// the contract for every emoji the TUI actually renders into truncating rows.

const GLYPHS = ["⛔", "💰", "🛑", "🟢", "🟡", "🔴", "⚠", "ℹ"];

describe("cli-truncate width contract (Ink truncate vs layout budget)", () => {
  test("a truncated line is never wider than the requested width", () => {
    for (const g of GLYPHS) {
      const line = `x`.repeat(38) + g + "abcdef";
      for (let w = 36; w <= stringWidth(line); w++) {
        const cut = cliTruncate(line, w);
        expect(stringWidth(cut)).toBeLessThanOrEqual(w);
      }
    }
  });

  test("the enforce-mode footer row truncates to its budget at every width", () => {
    const row =
      " model: gemini-2.5-pro ▸ prior · route: auto · reason: off │ ctx 0% · ↑4273 ↓3624 · $0.0493 / $0.02 (225%⛔) · sess ephemeral · ready";
    for (let w = 20; w <= stringWidth(row); w++) {
      const cut = cliTruncate(row, w);
      expect(stringWidth(cut)).toBeLessThanOrEqual(w);
    }
  });

  test("truncate and layout agree that ⛔ is two cells wide", () => {
    expect(stringWidth("⛔")).toBe(2);
    expect(stringWidth(cliTruncate("⛔⛔⛔", 4))).toBeLessThanOrEqual(4);
  });
});
