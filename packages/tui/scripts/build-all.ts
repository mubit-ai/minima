/**
 * Cross-compile every release target -> dist/minima-<os>-<arch>.
 *
 * `bun run scripts/build-all.ts`                       all four targets
 * `bun run scripts/build-all.ts bun-darwin-arm64 …`    only the given target(s)
 *
 * Used by the release workflow: macOS runner builds the darwin arches (then
 * ad-hoc codesigns them), the ubuntu runner builds the linux arches.
 */

import { rmSync } from "node:fs";
import { buildOne } from "./build.ts";

const TARGETS: Record<string, string> = {
  "bun-darwin-arm64": "dist/minima-darwin-arm64",
  "bun-darwin-x64": "dist/minima-darwin-x64",
  "bun-linux-x64": "dist/minima-linux-x64",
  "bun-linux-arm64": "dist/minima-linux-arm64",
};

const only = process.argv.slice(2);
const selected = Object.entries(TARGETS).filter(([t]) => only.length === 0 || only.includes(t));
if (only.length && selected.length !== only.length) {
  console.error(`unknown target(s); valid: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

rmSync("dist", { recursive: true, force: true });
for (const [target, outfile] of selected) {
  await buildOne({ target, outfile });
}
