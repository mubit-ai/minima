import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedTheme, persistTheme } from "../src/tui/mode_prefs.ts";
import { THEMES, THEME_NAMES, currentTheme, setTheme, t } from "../src/tui/theme.ts";

afterEach(() => {
  setTheme("minima");
});

describe("theme palettes", () => {
  test("ships 10 themes with minima first (the default)", () => {
    expect(THEME_NAMES.length).toBe(10);
    expect(THEME_NAMES[0]).toBe("minima");
  });

  test("minima keeps the historical ANSI names", () => {
    expect(THEMES.minima).toEqual({
      accent: "cyan",
      plan: "magenta",
      dim: "gray",
      warn: "yellow",
      success: "green",
      error: "red",
      text: "white",
    });
  });

  test("every non-default theme uses hex roles and terminal-default text", () => {
    for (const name of THEME_NAMES.slice(1)) {
      const p = THEMES[name]!;
      for (const role of ["accent", "plan", "dim", "warn", "success", "error"] as const) {
        expect(p[role]).toMatch(/^#[0-9A-F]{6}$/i);
      }
      expect(p.text).toBeUndefined();
    }
  });

  test("setTheme mutates the singleton in place (identity-stable)", () => {
    const ref = t;
    expect(setTheme("claude")).toBe(true);
    expect(currentTheme()).toBe("claude");
    expect(ref.accent).toBe("#D97757");
    expect(ref).toBe(t);
    expect(ref.text).toBeUndefined();
  });

  test("unknown theme is rejected and leaves the palette untouched", () => {
    expect(setTheme("neon-vomit")).toBe(false);
    expect(currentTheme()).toBe("minima");
    expect(t.accent).toBe("cyan");
  });
});

describe("theme persistence", () => {
  test("persistTheme/loadPersistedTheme roundtrip via ui-modes.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-theme-"));
    const prev = process.env.MINIMA_HARNESS_DIR;
    process.env.MINIMA_HARNESS_DIR = dir;
    try {
      expect(loadPersistedTheme()).toBeNull();
      persistTheme("fjord");
      expect(loadPersistedTheme()).toBe("fjord");
      persistTheme("minima");
      expect(loadPersistedTheme()).toBe("minima");
    } finally {
      if (prev === undefined) delete process.env.MINIMA_HARNESS_DIR;
      else process.env.MINIMA_HARNESS_DIR = prev;
    }
  });
});
