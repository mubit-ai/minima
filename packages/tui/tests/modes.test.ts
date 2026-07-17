import { beforeEach, describe, expect, test } from "bun:test";
import {
  BUILD_BUNDLE,
  PLAN_BUNDLE,
  PLAN_ESCAPE_HATCH,
  bundleForMode,
  cycleMode,
  getMode,
  modeSystemAppend,
  setMode,
  subscribeMode,
} from "../src/agent/modes.ts";
import { resolvePolicy } from "../src/agent/policy.ts";

beforeEach(() => setMode("build")); // module singleton — reset between tests

describe("mode bundles (B2)", () => {
  test("plan: every mutating tool resolves to ask, for any subject", () => {
    for (const tool of ["write", "edit", "apply_patch", "bash"]) {
      expect(resolvePolicy(PLAN_BUNDLE, { tool, subject: "anything at all" })).toBe("ask");
      expect(resolvePolicy(PLAN_BUNDLE, { tool, subject: "" })).toBe("ask");
    }
  });

  test("plan: read-side tools fall through to the catch-all allow", () => {
    for (const tool of ["read", "ls", "glob", "grep", "question", "task", "todowrite"]) {
      expect(resolvePolicy(PLAN_BUNDLE, { tool, subject: "src/index.ts" })).toBe("allow");
    }
  });

  test("build: everything allows (defers to the normal permission flow)", () => {
    for (const tool of ["write", "edit", "bash", "read"]) {
      expect(resolvePolicy(BUILD_BUNDLE, { tool, subject: "rm -rf /" })).toBe("allow");
    }
  });

  test("bundleForMode maps mode → bundle", () => {
    expect(bundleForMode("plan")).toBe(PLAN_BUNDLE);
    expect(bundleForMode("build")).toBe(BUILD_BUNDLE);
  });
});

describe("mode store (B2)", () => {
  test("defaults to build; cycleMode walks build → acceptEdits → plan → build", () => {
    expect(getMode()).toBe("build");
    expect(cycleMode()).toBe("acceptEdits");
    expect(cycleMode()).toBe("plan");
    expect(cycleMode()).toBe("build");
  });

  test("setMode notifies subscribers; same-value set is a no-op; unsubscribe stops delivery", () => {
    let fires = 0;
    const off = subscribeMode(() => {
      fires += 1;
    });
    setMode("plan");
    setMode("plan"); // no-op — useSyncExternalStore-friendly
    expect(fires).toBe(1);
    off();
    setMode("build");
    expect(fires).toBe(1);
    expect(getMode()).toBe("build");
  });
});

describe("plan-mode prompt hint (B2.3)", () => {
  test('build appends nothing — headless/-p runs stay unchanged"', () => {
    expect(modeSystemAppend("build")).toBe("");
  });

  test("plan appends the advisory block with the escape hatch verbatim", () => {
    const block = modeSystemAppend("plan");
    expect(block).toStartWith("\n\n# Plan mode");
    expect(block).toContain(PLAN_ESCAPE_HATCH);
    expect(block).toContain("advisory, not a hard rule");
  });
});

describe("mode bundles + ring (Claude Code-style modes)", () => {
  test("acceptEdits: write/edit/apply_patch auto, bash falls through to allow", async () => {
    const { ACCEPT_EDITS_BUNDLE } = await import("../src/agent/modes.ts");
    for (const tool of ["write", "edit", "apply_patch"]) {
      expect(resolvePolicy(ACCEPT_EDITS_BUNDLE, { tool, subject: "src/x.ts" })).toBe("auto");
    }
    expect(resolvePolicy(ACCEPT_EDITS_BUNDLE, { tool: "bash", subject: "rm -rf /" })).toBe("allow");
    expect(resolvePolicy(ACCEPT_EDITS_BUNDLE, { tool: "read", subject: "x" })).toBe("allow");
  });

  test("bypass: everything auto", async () => {
    const { BYPASS_BUNDLE } = await import("../src/agent/modes.ts");
    for (const tool of ["write", "edit", "bash", "read", "task"]) {
      expect(resolvePolicy(BYPASS_BUNDLE, { tool, subject: "anything" })).toBe("auto");
    }
  });

  test("bundleForMode maps the new modes", async () => {
    const {
      ACCEPT_EDITS_BUNDLE,
      BYPASS_BUNDLE,
      bundleForMode: bfm,
    } = await import("../src/agent/modes.ts");
    expect(bfm("acceptEdits")).toBe(ACCEPT_EDITS_BUNDLE);
    expect(bfm("bypass")).toBe(BYPASS_BUNDLE);
  });

  test("bypass joins the Shift+Tab ring only after enableBypass()", async () => {
    const { enableBypass, isBypassEnabled } = await import("../src/agent/modes.ts");
    // NOTE: enableBypass is one-way and module-global; this test runs it last-ish by
    // asserting the pre-state first (beforeEach resets mode, not the bypass latch).
    if (!isBypassEnabled()) {
      setMode("plan");
      expect(cycleMode()).toBe("build"); // plan wraps to build while bypass is off
      enableBypass();
    }
    setMode("plan");
    expect(cycleMode()).toBe("bypass"); // plan → bypass once enabled
    expect(cycleMode()).toBe("build"); // bypass wraps to build
  });

  test("every mode has a badge slot entry (null allowed only for build)", async () => {
    const { MODE_BADGES } = await import("../src/agent/modes.ts");
    expect(MODE_BADGES.build).toBeNull();
    expect(MODE_BADGES.acceptEdits?.color).toBe("green");
    expect(MODE_BADGES.plan?.color).toBe("magenta");
    expect(MODE_BADGES.bypass?.color).toBe("red");
  });
});

describe("mode_prefs persistence", () => {
  test("round-trips per project; never persists bypass; survives a corrupt file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "minima-mode-prefs-"));
    const prevEnv = process.env.MINIMA_HARNESS_DIR;
    process.env.MINIMA_HARNESS_DIR = dir;
    try {
      const { loadPersistedMode, persistMode } = await import("../src/tui/mode_prefs.ts");
      expect(loadPersistedMode("github.com/x/y")).toBeNull();
      persistMode("github.com/x/y", "acceptEdits");
      persistMode("github.com/other/repo", "plan");
      expect(loadPersistedMode("github.com/x/y")).toBe("acceptEdits");
      expect(loadPersistedMode("github.com/other/repo")).toBe("plan");
      persistMode("github.com/x/y", "bypass"); // must be ignored
      expect(loadPersistedMode("github.com/x/y")).toBe("acceptEdits");
      writeFileSync(join(dir, "ui-modes.json"), "{corrupt", "utf8");
      expect(loadPersistedMode("github.com/x/y")).toBeNull(); // fresh start, no throw
    } finally {
      if (prevEnv === undefined) delete process.env.MINIMA_HARNESS_DIR;
      else process.env.MINIMA_HARNESS_DIR = prevEnv;
    }
  });

  test("task-panel hide uses a suffixed key: persists, clears, never touches the mode", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "minima-task-prefs-"));
    const prevEnv = process.env.MINIMA_HARNESS_DIR;
    process.env.MINIMA_HARNESS_DIR = dir;
    try {
      const { loadPersistedMode, loadTaskPanelHidden, persistMode, persistTaskPanelHidden } =
        await import("../src/tui/mode_prefs.ts");
      expect(loadTaskPanelHidden("github.com/x/y")).toBe(false);
      persistMode("github.com/x/y", "acceptEdits");
      persistTaskPanelHidden("github.com/x/y", true);
      expect(loadTaskPanelHidden("github.com/x/y")).toBe(true);
      // The suffixed key is invisible to the mode reader — and vice versa.
      expect(loadPersistedMode("github.com/x/y")).toBe("acceptEdits");
      expect(loadPersistedMode("github.com/x/y::task-panel" as string)).toBeNull();
      // Showing clears the override (auto-show default returns).
      persistTaskPanelHidden("github.com/x/y", false);
      expect(loadTaskPanelHidden("github.com/x/y")).toBe(false);
      const raw = await Bun.file(join(dir, "ui-modes.json")).text();
      expect(raw).not.toContain("task-panel");
    } finally {
      if (prevEnv === undefined) delete process.env.MINIMA_HARNESS_DIR;
      else process.env.MINIMA_HARNESS_DIR = prevEnv;
    }
  });
});
