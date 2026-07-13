/**
 * Full-matrix calibration orchestrator: every task × arm up to k attempts, with a
 * concurrency pool, RESUME (combos already recorded in calibration.jsonl are skipped),
 * a global spend cap, and a stop file for graceful abort.
 *
 * Designed to run detached for an hour+:
 *   nohup bun bench/gen/calibrate_all.ts --arms cheap,frontier --k 5 --concurrency 6 \
 *     >> bench/artifacts/calibration-run.log 2>&1 &
 *
 * Graceful stop:   touch bench/artifacts/CALIBRATION_STOP   (finishes in-flight attempts)
 * Progress:        tail bench/artifacts/calibration-run.log · wc -l bench/tasks/calibration.jsonl
 * Afterwards:      bun bench/gen/build_index.ts   (folds measured rates into tasks.jsonl)
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTaskDirs, runAttempt } from "./attempt.ts";
import { loadTask, TASKS_ROOT } from "./materialize.ts";

function flags(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i]!.replace(/^--/, "")] = a[i + 1] ?? "";
  return out;
}

const f = flags();
const k = Number(f.k ?? 5);
const arms = (f.arms ?? "cheap,frontier").split(",");
const models: Record<string, string> = {
  cheap: f["cheap-model"] ?? "claude-haiku-4-5",
  frontier: f["frontier-model"] ?? "claude-sonnet-4-6",
};
const concurrency = Number(f.concurrency ?? 6);
const maxUsd = Number(f["max-usd"] ?? 25);
const logPath = join(TASKS_ROOT, "calibration.jsonl");
const stopFile = join(TASKS_ROOT, "..", "artifacts", "CALIBRATION_STOP");

// Resume: count existing rows per task×arm.
const done = new Map<string, number>();
let spent = 0;
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { task: string; arm: string; cost_usd?: number | null };
      done.set(`${r.task}|${r.arm}`, (done.get(`${r.task}|${r.arm}`) ?? 0) + 1);
      spent += r.cost_usd ?? 0;
    } catch {}
  }
}

interface Job {
  taskDir: string;
  id: string;
  arm: string;
  attempt: number;
}
const jobs: Job[] = [];
for (const taskDir of discoverTaskDirs(TASKS_ROOT)) {
  const id = loadTask(taskDir).id;
  for (const arm of arms) {
    const have = done.get(`${id}|${arm}`) ?? 0;
    for (let a = have + 1; a <= k; a++) jobs.push({ taskDir, id, arm, attempt: a });
  }
}

console.log(
  `[${new Date().toISOString()}] calibrate_all: ${jobs.length} attempts to run ` +
    `(resume skipped ${[...done.values()].reduce((s, n) => s + n, 0)}), ` +
    `concurrency=${concurrency}, max-usd=$${maxUsd} (already spent ~$${spent.toFixed(2)})`,
);

let idx = 0;
let ran = 0;
let failures = 0;
let stopped: string | null = null;

async function worker(w: number): Promise<void> {
  while (true) {
    if (existsSync(stopFile)) {
      stopped = "stop file";
      return;
    }
    if (spent >= maxUsd) {
      stopped = `spend cap $${maxUsd}`;
      return;
    }
    const job = jobs[idx++];
    if (!job) return;
    try {
      const r = await runAttempt(job.taskDir, job.arm, models[job.arm]!, job.attempt);
      appendFileSync(logPath, `${JSON.stringify(r)}\n`);
      spent += r.cost_usd ?? 0;
      ran++;
      console.log(
        `[${new Date().toISOString()}] [w${w}] ${job.id} ${job.arm}#${job.attempt}: ` +
          `${r.solved ? "SOLVED" : r.cheated ? "CHEATED" : "failed"} ` +
          `(${Math.round(r.duration_ms / 1000)}s, $${(r.cost_usd ?? 0).toFixed(4)}) · ` +
          `${ran}/${jobs.length} done, ~$${spent.toFixed(2)} spent`,
      );
    } catch (e) {
      failures++;
      console.error(`[w${w}] ${job.id} ${job.arm}#${job.attempt} ERROR: ${String(e).slice(0, 300)}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w + 1)));
console.log(
  `[${new Date().toISOString()}] calibrate_all finished: ${ran}/${jobs.length} attempts, ` +
    `${failures} errors, ~$${spent.toFixed(2)} total${stopped ? ` — STOPPED EARLY (${stopped})` : ""}`,
);
console.log("next: bun bench/gen/build_index.ts");
