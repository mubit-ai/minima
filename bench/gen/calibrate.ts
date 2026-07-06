/**
 * Targeted calibration CLI — run specific tasks × arms × k through the installed
 * minima binary and append to bench/tasks/calibration.jsonl. For the full matrix with
 * concurrency/resume/spend-cap, use calibrate_all.ts.
 *
 * Usage:
 *   bun bench/gen/calibrate.ts --tasks pc-001,ka-003 --arms cheap --k 2
 *   bun bench/gen/calibrate.ts --tasks bench/tasks/_example/ex-001 --arms cheap --k 1
 * Flags: --cheap-model (default claude-haiku-4-5), --frontier-model (default
 * claude-sonnet-4-6), --budget (per-attempt USD cap, default 0.25),
 * --attempt-timeout-s (default 300).
 *
 * Label thresholds (applied by the reporter, aider-polyglot style):
 *   easy: cheap >= 0.8 · medium: cheap in [0.2, 0.6] and frontier >= 0.8
 *   hard: cheap <= 0.2 and frontier >= 0.5 · no-signal: both ~0 or both ~1 → drop/rework
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { discoverTaskDirs, runAttempt } from "./attempt.ts";
import { loadTask, TASKS_ROOT } from "./materialize.ts";

function parseFlags(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i]!.startsWith("--") || a[i + 1] === undefined) {
      console.error(`bad flag pair at: ${a[i]}`);
      process.exit(2);
    }
    out[a[i]!.slice(2)] = a[i + 1]!;
  }
  return out;
}

function findTaskDirs(sel: string): string[] {
  const all = discoverTaskDirs(TASKS_ROOT);
  if (sel === "all") return all;
  const parts = sel.split(",").map((s) => s.trim());
  // Entries containing "/" are literal task dirs (lets smokes target _-prefixed examples).
  const literals = parts.filter((p) => p.includes("/"));
  const ids = new Set(parts.filter((p) => !p.includes("/")));
  return [...literals, ...all.filter((d) => ids.has(loadTask(d).id))];
}

const flags = parseFlags();
const k = Number(flags.k ?? 2);
const arms = (flags.arms ?? "cheap").split(",");
const models: Record<string, string> = {
  cheap: flags["cheap-model"] ?? "claude-haiku-4-5",
  frontier: flags["frontier-model"] ?? "claude-sonnet-4-6",
};
const budget = flags.budget ?? "0.25";
const attemptTimeoutMs = Number(flags["attempt-timeout-s"] ?? 300) * 1000;
const taskDirs = findTaskDirs(flags.tasks ?? "");
if (!taskDirs.length) {
  console.error("no tasks selected (--tasks all | id,id,... | literal/task/dir)");
  process.exit(2);
}
const logPath = join(TASKS_ROOT, "calibration.jsonl");
if (!existsSync(TASKS_ROOT)) {
  console.error(`missing tasks root: ${TASKS_ROOT}`);
  process.exit(2);
}
console.log(`calibrating ${taskDirs.length} task(s) × ${arms.join("+")} × k=${k} → ${logPath}`);

for (const taskDir of taskDirs) {
  const meta = loadTask(taskDir);
  for (const arm of arms) {
    const model = models[arm];
    if (!model) {
      console.error(`unknown arm: ${arm}`);
      process.exit(2);
    }
    for (let attempt = 1; attempt <= k; attempt++) {
      try {
        const r = await runAttempt(taskDir, arm, model, attempt, {
          budgetUsd: budget,
          timeoutMs: attemptTimeoutMs,
        });
        appendFileSync(logPath, `${JSON.stringify(r)}\n`);
        console.log(
          `${meta.id} ${arm}#${attempt}: ${r.solved ? "SOLVED" : r.cheated ? "CHEATED" : "failed"} ` +
            `(${Math.round(r.duration_ms / 1000)}s, $${(r.cost_usd ?? 0).toFixed(4)})`,
        );
      } catch (e) {
        console.error(`  attempt error: ${String(e).slice(0, 200)}`);
      }
    }
  }
}
console.log("done — rebuild the index to fold rates in: bun bench/gen/build_index.ts");
