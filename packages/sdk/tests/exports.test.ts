/**
 * The public barrel. `package.json` exports only `./src/index.ts`, so this file IS the
 * package as consumers see it — and tsc cannot see the one way it breaks: `export type *`
 * erases runtime values, so a `export const` in schemas.ts can be declared, type-check,
 * and still be undefined at the import site.
 */

import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import * as sdk from "../src/index.ts";
import { DECISION_BASES, DIFFICULTIES, OUTCOME_LABELS, TASK_TYPES } from "../src/schemas.ts";

describe("public barrel", () => {
  test("the runtime consts survive the barrel — not erased by `export type *`", () => {
    expect(sdk.TASK_TYPES).toEqual(TASK_TYPES);
    expect(sdk.DIFFICULTIES).toEqual(DIFFICULTIES);
    expect(sdk.OUTCOME_LABELS).toEqual(OUTCOME_LABELS);
    expect(sdk.DECISION_BASES).toEqual(DECISION_BASES);
  });

  test("the client and every error subtype are reachable", () => {
    expect(typeof sdk.MinimaClient).toBe("function");
    expect(typeof sdk.MinimaError).toBe("function");
    expect(typeof sdk.MinimaRateLimited).toBe("function");
    expect(typeof sdk.MinimaUnavailable).toBe("function");
  });
});

describe("VERSION", () => {
  test("resolves from package.json rather than falling through to the default", () => {
    expect(sdk.VERSION).toBe(pkg.version);
    expect(sdk.VERSION).not.toBe("0.0.0");
  });
});
