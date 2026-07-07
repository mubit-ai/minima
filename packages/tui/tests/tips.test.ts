import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TIPS,
  advance,
  formatTip,
  isTipsEnabled,
  nextIndex,
  pick,
  setTipsEnabled,
  setTipsStateDir,
} from "../src/tui/tips.ts";

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
  setTipsStateDir(join(tmpdir(), "minima-tips-noop")); // detach from the real HOME after each test
});

describe("tips", () => {
  test("TIPS is non-empty and every tip leads with a /command or tool name", () => {
    expect(TIPS.length).toBeGreaterThan(0);
    for (const t of TIPS) {
      expect(t.length).toBeGreaterThan(0);
      expect(/^(\/|web_search|web_fetch|apply_patch)/.test(t)).toBe(true);
    }
  });

  test("formatTip prefixes the lightbulb glyph", () => {
    expect(formatTip("hello")).toBe("💡 hello");
  });

  test("pick wraps around the list", () => {
    expect(pick(0)).toBe(TIPS[0]!);
    expect(pick(TIPS.length)).toBe(TIPS[0]!);
    expect(pick(TIPS.length + 1)).toBe(TIPS[1]!);
    expect(pick(-1)).toBe(TIPS[TIPS.length - 1]!);
  });

  test("nextIndex rotates and wraps", () => {
    expect(nextIndex(0)).toBe(1);
    expect(nextIndex(TIPS.length - 1)).toBe(0);
  });

  test("advance persists the rotation cursor and returns the next tip", () => {
    dir = mkdtempSync(join(tmpdir(), "minima-tips-"));
    setTipsStateDir(dir);
    // From a fresh (index 0) state, advance moves to index 1.
    expect(advance()).toBe(pick(1));
    const stored = JSON.parse(readFileSync(join(dir, "tips_state.json"), "utf8"));
    expect(stored.index).toBe(1);
    // A second call rotates again.
    expect(advance()).toBe(pick(2));
    expect(JSON.parse(readFileSync(join(dir, "tips_state.json"), "utf8")).index).toBe(2);
  });

  test("advance falls back to index 0 when state is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "minima-tips-"));
    setTipsStateDir(dir);
    // No state file yet → readIndex() = 0 → advance() = 1.
    expect(advance()).toBe(pick(1));
  });

  test("tips are ON by default (no state file)", () => {
    dir = mkdtempSync(join(tmpdir(), "minima-tips-"));
    setTipsStateDir(dir);
    expect(isTipsEnabled()).toBe(true);
  });

  test("setTipsEnabled persists the preference and round-trips", () => {
    dir = mkdtempSync(join(tmpdir(), "minima-tips-"));
    setTipsStateDir(dir);
    setTipsEnabled(false);
    expect(isTipsEnabled()).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "tips_state.json"), "utf8")).enabled).toBe(false);
    setTipsEnabled(true);
    expect(isTipsEnabled()).toBe(true);
  });

  test("toggling enabled preserves the rotation cursor", () => {
    dir = mkdtempSync(join(tmpdir(), "minima-tips-"));
    setTipsStateDir(dir);
    advance(); // index → 1
    setTipsEnabled(false); // must not reset index
    expect(JSON.parse(readFileSync(join(dir, "tips_state.json"), "utf8")).index).toBe(1);
    expect(advance()).toBe(pick(2));
  });
});
