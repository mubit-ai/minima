/**
 * Build the single native binary. Uses Bun.build (JS API) so the devtools stub plugin
 * is reliably applied.
 *
 * Host build (default):   `bun run scripts/build.ts`      -> dist/minima
 * Cross-compile a target: `MINIMA_TARGET=bun-darwin-arm64 MINIMA_OUTFILE=dist/minima-darwin-arm64 \
 *                            bun run scripts/build.ts`
 *
 * Targets are Bun's compile triples: bun-darwin-arm64 | bun-darwin-x64 |
 * bun-linux-x64 | bun-linux-arm64. Cross-compilation works from any host (Bun
 * fetches the target runtime); `keytar` is optional and never bundles, so the
 * compiled binary always uses the 0600-file credential store — no native dep.
 */

import { rmSync } from "node:fs";
import stub from "./stub-devtools.ts";

export async function buildOne(opts: { target?: string; outfile: string }): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/cli/main.ts"],
    target: "bun",
    minify: true,
    plugins: [stub as unknown as import("bun").BunPlugin],
    compile: opts.target ? { target: opts.target, outfile: opts.outfile } : { outfile: opts.outfile },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const size = (Bun.file(opts.outfile).size / (1024 * 1024)).toFixed(1);
  console.log(`built ${opts.outfile}${opts.target ? ` (${opts.target})` : ""} (${size} MB)`);
}

if (import.meta.main) {
  const target = process.env.MINIMA_TARGET?.trim() || undefined;
  const outfile = process.env.MINIMA_OUTFILE?.trim() || "dist/minima";
  // Only wipe dist for the plain host build; cross-compile runs write distinct
  // outfiles and must not clobber siblings (build-all owns the dist reset).
  if (!target && !process.env.MINIMA_OUTFILE) {
    rmSync("dist", { recursive: true, force: true });
  }
  await buildOne({ target, outfile });
}
