/**
 * Keeps source-text assertions going through tests/_source.ts.
 *
 * Reading a src file raw and asserting on its exact text makes the test break on any
 * reindent or line wrap — `bun run format` alone can turn the suite red with a failure that
 * says nothing about behavior. readSource() normalizes whitespace on both sides so that
 * cannot happen. This stops the raw pattern coming back by habit.
 *
 * It is a style guard, not a correctness one: the assertions themselves are legitimate
 * wiring pins over app.tsx, which is 5177 lines of React that cannot be exercised directly.
 * The real fix for any given pin is to extract the logic and test its behavior — see
 * behavior.ts, panel_state.ts and confidence.ts, which exist for exactly that reason.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = import.meta.dir;

/** Reads a src/ path directly instead of via readSource(). */
const RAW_SOURCE_READ = /readFileSync\s*\([^)]*\.\.\/src\/|Bun\.file\s*\([^)]*\.\.\/src\//;

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"));
}

describe("source-text assertions go through _source.ts", () => {
  test("no test file reads a src/ file raw", () => {
    const offenders = testFiles().filter((f) =>
      RAW_SOURCE_READ.test(readFileSync(join(TESTS_DIR, f), "utf8")),
    );
    expect(
      offenders,
      `These read a src/ file directly:\n${offenders.map((f) => `  - ${f}`).join("\n")}\n\n` +
        "Use readSource(\"tui/app.tsx\") from ./_source.ts instead — it normalizes whitespace " +
        "so a reindent or line wrap cannot break the assertion. If the pin genuinely needs " +
        "raw layout, readSourceRaw() is there; prefer extracting the logic and testing its " +
        "behavior over pinning source text at all.",
    ).toEqual([]);
  });

  test("the helper is actually used — this guard is not vacuous", () => {
    const users = testFiles().filter((f) =>
      readFileSync(join(TESTS_DIR, f), "utf8").includes('from "./_source.ts"'),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
