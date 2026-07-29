/**
 * Keeps the hand-rolled service mocks honest about the wire enums.
 *
 * Thirty-seven test files build a /v1/recommend payload as a bare object literal, so
 * `json: async () => ({ ... })` type-checks against nothing: a mock can send a
 * classified_task_type the server could never produce and the suite stays green, with
 * every test on that path exercising the harness against fiction.
 *
 * This guard earned its place immediately by catching a bad bulk edit of mine — a mistaken
 * rewrite of all 32 `classified_task_type: "code"` literals to a value not in TASK_TYPES.
 * tsc could not see it (untyped literals) and no behavioral test noticed. This did.
 *
 * Migrating all thirty-seven onto the typed builders in _service.ts is the end state (see
 * feedback-verified.test.ts for the shape), which moves the check to the call site where
 * tsc can do it. Until then the drift is what bites, and a literal scan catches it across
 * the whole directory for a fraction of the churn.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIFFICULTIES, TASK_TYPES } from "../src/minima/schemas.ts";

const TESTS_DIR = import.meta.dir;
/** This file quotes bad values in its own prose; scanning itself would self-trip. */
const SELF = "mock-contract-guard.test.ts";

/**
 * Wire fields whose values are closed enums. Only DISTINCTIVE field names belong here —
 * `outcome` was tried and removed: the gate ledger uses the same key for a different enum
 * (verified/failed/unchecked/unrunnable), so a name-only scan cannot tell the two apart and
 * reports 94 false positives. A blunt guard is fine; an ambiguous one is not.
 */
const ENUM_FIELDS: { field: string; allowed: readonly string[] }[] = [
  { field: "classified_task_type", allowed: TASK_TYPES },
  { field: "heuristic_task_type", allowed: TASK_TYPES },
  { field: "classified_difficulty", allowed: DIFFICULTIES },
  { field: "heuristic_difficulty", allowed: DIFFICULTIES },
];

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter(
    (f) => (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) && f !== SELF,
  );
}

describe("service mocks match the wire enums", () => {
  for (const { field, allowed } of ENUM_FIELDS) {
    test(`every literal ${field} in the suite is a real enum member`, () => {
      const bad: string[] = [];
      for (const file of testFiles()) {
        const body = readFileSync(join(TESTS_DIR, file), "utf8");
        for (const m of body.matchAll(new RegExp(`${field}:\\s*"([^"]*)"`, "g"))) {
          const value = m[1]!;
          if (!allowed.includes(value)) bad.push(`${file}: ${field}: "${value}"`);
        }
      }
      expect(
        bad,
        `These mock a ${field} the server cannot send:\n${bad.map((b) => `  - ${b}`).join("\n")}\n\n` +
          `Allowed: ${allowed.join(", ")}.\n` +
          "Prefer the typed builders in ./_service.ts — they are typed as the real wire " +
          "interfaces, so tsc rejects a bad value at the call site instead of leaving it " +
          "for this scan to find.",
      ).toEqual([]);
    });
  }

  test("the enums are non-empty — a bad import would make this guard vacuous", () => {
    expect(TASK_TYPES.length).toBeGreaterThan(0);
    expect(DIFFICULTIES.length).toBeGreaterThan(0);
  });

  test("the scan actually finds the fields it claims to check", () => {
    const scanned = testFiles().filter((f) =>
      readFileSync(join(TESTS_DIR, f), "utf8").includes("classified_task_type:"),
    );
    // If the mocks stop spelling these fields, this guard is dead weight — say so loudly
    // rather than passing vacuously over an empty set.
    expect(scanned.length).toBeGreaterThan(0);
  });
});
