/**
 * Bench env bootstrap: make the harness talk to prod Minima with a key that can
 * actually persist memory.
 *
 * Minima runs PASS-THROUGH auth (src/minima/api/auth.py): the MUBIT_API_KEY the client
 * — and the spawned binary — present as `Authorization: Bearer <key>` IS the key Minima
 * uses against Mubit. The repo `.env` ships the LOCAL dev key `mbt_local_admin` whose
 * Mubit instance prod cannot reach, so every memory write comes back HTTP 200 +
 * accepted=false / warnings=["memory_write_failed"] and the learning loop can never go
 * green (verified live 2026-07-07 by an A/B of the two keys against api.minima.sh).
 * `.env.harness` carries the DEPLOYED key that writes successfully.
 *
 * Bun auto-loads `.env` (not `.env.harness`) into process.env before any of our code
 * runs, so without this the local key wins by default. loadBenchEnv() layers
 * `.env.harness` over process.env — FORCE keys (the pass-through routing trio) always win
 * so the deployed key beats the Bun-loaded local one; FILL keys (provider creds) only
 * backfill when absent so a working ambient key is never swapped out.
 *
 * Escape hatches:
 *   BENCH_NO_HARNESS_ENV=1  — skip the file entirely (e.g. to exercise the local key
 *                             against a locally-run server + ricedb where it is valid).
 *   BENCH_MUBIT_API_KEY=... — highest-priority explicit override (CI, no file needed).
 *
 * Values are never logged — only the NAMES of the keys that changed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pass-through routing keys: `.env.harness` must win over the Bun-loaded `.env`.
const FORCE = new Set(["MINIMA_URL", "MINIMA_API_KEY", "MUBIT_API_KEY"]);
// Provider creds: only backfill if the ambient env doesn't already have a working one.
const FILL = new Set(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);

const HARNESS_PATH = join(import.meta.dir, "..", "..", ".env.harness");

export interface BenchEnvResult {
  /** Which file supplied overrides, or null if none was applied. */
  source: string | null;
  /** Names (never values) of the keys whose process.env value this changed. */
  overrode: string[];
}

let cached: BenchEnvResult | null = null;

/**
 * Idempotent: safe to call from every entrypoint (run.ts, savings_ab.ts, f12). The first
 * call mutates process.env; later calls return the cached result without re-reading.
 */
export function loadBenchEnv(): BenchEnvResult {
  if (cached) return cached;

  const overrode: string[] = [];
  let source: string | null = null;

  if (!process.env.BENCH_NO_HARNESS_ENV) {
    try {
      const text = readFileSync(HARNESS_PATH, "utf8");
      source = ".env.harness";
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const k = m[1]!;
        const v = m[2]!.trim().replace(/^["']|["']$/g, "");
        if (!v) continue;
        if (FORCE.has(k)) {
          if (process.env[k] !== v) overrode.push(k);
          process.env[k] = v;
        } else if (FILL.has(k) && !process.env[k]) {
          process.env[k] = v;
          overrode.push(`${k}(filled)`);
        }
      }
    } catch {
      // No `.env.harness` — fall through to ambient/.env (may be the local key: the
      // f12 write-health probe will then fail fast at the true cause).
    }
  }

  // Explicit CI override always wins over the file.
  const ci = process.env.BENCH_MUBIT_API_KEY;
  if (ci && process.env.MUBIT_API_KEY !== ci) {
    process.env.MUBIT_API_KEY = ci;
    if (!overrode.includes("MUBIT_API_KEY")) overrode.push("MUBIT_API_KEY");
  }

  cached = { source: overrode.length ? (source ?? "BENCH_MUBIT_API_KEY") : null, overrode };
  if (overrode.length) {
    console.log(`[bench] env: forced ${cached.source} over ambient for ${overrode.join(", ")}`);
  }
  return cached;
}
