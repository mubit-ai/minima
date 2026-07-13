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
  test("defaults to build; cycleMode round-trips", () => {
    expect(getMode()).toBe("build");
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
