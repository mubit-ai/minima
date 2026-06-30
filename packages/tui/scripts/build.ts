/**
 * Build the single native binary. Uses Bun.build (JS API) so the devtools stub plugin
 * is reliably applied. Output: dist/minima (a self-contained executable).
 */

import stub from "./stub-devtools.ts";
import { renameSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  outdir: "dist",
  target: "bun",
  compile: true,
  minify: true,
  plugins: [stub as unknown as import("bun").BunPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The compiled binary is named after the entrypoint (main); rename to `minima`.
renameSync("dist/main", "dist/minima");
const size = (Bun.file("dist/minima").size / (1024 * 1024)).toFixed(1);
console.log(`built dist/minima (${size} MB)`);
