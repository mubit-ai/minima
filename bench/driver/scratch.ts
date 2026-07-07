/** Per-flow disposable workspace + env construction. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FlowScratch {
  root: string;
  repoDir: string; // cwd for the minima process — always disposable, never a real repo
  dbPath: string;
  namespace: string;
  env: Record<string, string>;
}

const ARTIFACTS = join(import.meta.dir, "..", "artifacts");

/** Binary under test — defaults to the installed Homebrew binary; override with
 * BENCH_MINIMA_BIN (e.g. a downloaded release asset) to test other versions. */
export const MINIMA_BIN = process.env.BENCH_MINIMA_BIN ?? "minima";

export function makeScratch(flowId: string, sub?: string): FlowScratch {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join(ARTIFACTS, "scratch", `${flowId}-${stamp}${sub ? `-${sub}` : ""}`);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const namespace = `bench-${flowId}-${crypto.randomUUID().slice(0, 8)}`;
  const dbPath = join(root, "flow.db");
  return {
    root,
    repoDir,
    dbPath,
    namespace,
    env: {
      MINIMA_DB_PATH: dbPath,
      MINIMA_NAMESPACE: namespace,
    },
  };
}

export function saveArtifact(scratch: FlowScratch, name: string, content: string): string {
  const p = join(scratch.root, name);
  writeFileSync(p, content, "utf8");
  return p;
}

/** Poll until fn() is truthy; returns its value or throws after timeoutMs. */
export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  opts: { timeoutMs?: number; pollMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(opts.pollMs ?? 250);
  }
  throw new Error(`waitFor timeout (${opts.timeoutMs ?? 60_000}ms)${opts.what ? `: ${opts.what}` : ""}`);
}
