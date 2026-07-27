/**
 * Preflight: the dependency overrides this package pins are actually INSTALLED.
 *
 * `overrides` and `patchedDependencies` in package.json are not self-enforcing — a
 * node_modules populated before an override was added keeps the old copy, and `bun install`
 * will not necessarily correct it. When that happens the emoji-width contract breaks and
 * five tests in footer-width/truncate-width fail with messages about ⛔ being seven cells
 * wide, which points at rendering rather than at dependency resolution. That cost real
 * debugging time; this turns it into one line naming the fix.
 *
 * Deliberately checks the RESOLVED INSTALL rather than the rendering behavior — the
 * behavior is already covered by truncate-width.test.ts, and the point here is to name the
 * cause the moment it diverges.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIX = "run `bun install --force` in packages/tui";

interface Pkg {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
}

function pkgJson(dir: string): { version?: string } & Pkg {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** Leading major from a version or a range ("^5.1.0" → 5). NaN when unparseable. */
function major(spec: string): number {
  return Number.parseInt(spec.replace(/^[^0-9]*/, ""), 10);
}

const manifest = pkgJson(ROOT);

describe("dependency preflight", () => {
  const overrides = Object.entries(manifest.overrides ?? {});

  test("package.json still declares the overrides this suite depends on", () => {
    // If someone removes an override, this file should stop asserting it rather than
    // silently pass on an empty set.
    expect(overrides.length).toBeGreaterThan(0);
  });

  for (const [name, range] of overrides) {
    test(`${name} is installed at the overridden major (${range}) — else ${FIX}`, () => {
      let installed: string | undefined;
      try {
        installed = pkgJson(join(ROOT, "node_modules", name)).version;
      } catch {
        throw new Error(`${name} is not installed at the top level of node_modules — ${FIX}`);
      }
      expect(
        major(installed ?? ""),
        `${name} resolves to ${installed}, but package.json overrides it to ${range}. ` +
          `The override was not applied to this node_modules — ${FIX}. ` +
          "Leaving it stale breaks the emoji cell-width contract and fails " +
          "footer-width/truncate-width with misleading rendering errors.",
      ).toBeGreaterThanOrEqual(major(range));
    });
  }

  test("the cli-truncate patch is still declared and its patch file exists", () => {
    const patched = Object.entries(manifest.patchedDependencies ?? {});
    expect(patched.length).toBeGreaterThan(0);
    for (const [dep, patchPath] of patched) {
      expect(() => readFileSync(join(ROOT, patchPath), "utf8"), `${dep}: ${patchPath} missing`)
        .not.toThrow();
    }
  });
});
