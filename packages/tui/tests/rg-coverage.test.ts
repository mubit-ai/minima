/**
 * Makes the ripgrep-gated coverage gap VISIBLE locally.
 *
 * grep/glob have two engines: the ripgrep fast path (the default in production, see
 * _rg.ts) and a pure-Bun fallback. Nine tests across grep.test.ts and glob.test.ts are
 * gated on `test.if(RG !== null)`, so on a machine without ripgrep they vanish and the
 * suite reports a clean green while the DEFAULT engine went completely unexercised.
 *
 * CI already installs ripgrep and verifies it (.github/workflows/ci.yml), so the shipping
 * path is covered there. This only closes the local blind spot: a dev editing _rg.ts on a
 * box without ripgrep would otherwise see all-green having tested nothing they changed.
 * Deliberately a warning rather than a failure — ripgrep is not required to develop here,
 * and breaking the suite over an optional binary would be worse than the gap it closes.
 */

import { describe, expect, test } from "bun:test";

const RG = Bun.which("rg");

/** Keep in step with the `test.if(RG !== null)` gates in grep/glob. */
const RG_GATED_TESTS = 9;

describe("ripgrep coverage", () => {
  test(`the rg fast path is exercised (${RG_GATED_TESTS} gated tests)`, () => {
    if (!RG) {
      console.warn(
        `\n⚠ ripgrep not found — ${RG_GATED_TESTS} tests covering the grep/glob rg fast path ` +
          "were SKIPPED, not passed.\n" +
          "  That is the DEFAULT engine in production; only the Bun fallback ran here.\n" +
          "  Install it (brew install ripgrep) before trusting a green run that touches " +
          "src/tools/_rg.ts, grep.ts or glob.ts.\n" +
          "  CI installs and verifies ripgrep, so the shipping path stays covered there.\n",
      );
    }
    // Never fails: ripgrep is optional for local development. The warning above is the
    // whole point — an unannounced skip is what made this worth writing.
    expect(RG === null || typeof RG === "string").toBe(true);
  });

  test("CI must have ripgrep — a silent skip there would ship the path untested", () => {
    const inCi = process.env.CI === "true" || process.env.CI === "1";
    if (!inCi) return;
    expect(
      RG,
      "ripgrep is missing in CI. .github/workflows/ci.yml installs and verifies it, so " +
        "this means that step was removed or failed — the rg fast path is the production " +
        "default and would ship with zero coverage.",
    ).not.toBeNull();
  });
});
