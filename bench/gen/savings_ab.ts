/**
 * Paired savings A/B — the honest headline number.
 *
 * Every task runs once per arm with identical prompts and fresh checkouts:
 *   premium  — pinned claude-opus-4-8 (the all-premium baseline a non-router pays for)
 *   routed   — the actual product: server-routed via api.minima.sh in a dedicated
 *              namespace (bench-ab-v1), feedback flowing, learning live
 * Both graded by the hidden fail-to-pass tests. Report via savings_report.ts.
 *
 * Detached usage:
 *   nohup bun bench/gen/savings_ab.ts >> bench/artifacts/savings-ab-run.log 2>&1 &
 * Stop file: bench/artifacts/AB_STOP · resume: rerun (jsonl-counted per task×arm)
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBenchEnv } from "../driver/env.ts";
import { discoverTaskDirs, runAttempt } from "./attempt.ts";
import { loadTask, TASKS_ROOT } from "./materialize.ts";

// Routed arm learns live: force the deployed pass-through key so feedback actually
// persists (the local .env key's writes are rejected — see driver/env.ts).
loadBenchEnv();

function flags(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i]!.replace(/^--/, "")] = a[i + 1] ?? "";
  return out;
}
const f = flags();
const NAMESPACE = f.namespace ?? "bench-ab-v1";
const PREMIUM = f["premium-model"] ?? "claude-opus-4-8";
const concurrency = Number(f.concurrency ?? 4);
const maxUsd = Number(f["max-usd"] ?? 20);
const logPath = join(TASKS_ROOT, "savings_ab.jsonl");
const stopFile = join(TASKS_ROOT, "..", "artifacts", "AB_STOP");

interface Arm {
  name: string;
  routed: boolean;
  model: string;
  budget: string;
}
const ARMS: Arm[] = [
  { name: "premium", routed: false, model: PREMIUM, budget: "1.00" },
  { name: "routed", routed: true, model: "routed", budget: "0.50" },
];

// Resume: task×arm combos already logged are skipped (k=1 per arm).
const done = new Set<string>();
let spent = 0;
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { task: string; arm: string; cost_usd?: number | null };
      done.add(`${r.task}|${r.arm}`);
      spent += r.cost_usd ?? 0;
    } catch {}
  }
}

interface Job {
  taskDir: string;
  id: string;
  arm: Arm;
}
const jobs: Job[] = [];
for (const taskDir of discoverTaskDirs(TASKS_ROOT)) {
  const id = loadTask(taskDir).id;
  for (const arm of ARMS) if (!done.has(`${id}|${arm.name}`)) jobs.push({ taskDir, id, arm });
}
console.log(
  `[${new Date().toISOString()}] savings_ab: ${jobs.length} attempts (resume skipped ${done.size}), ` +
    `premium=${PREMIUM}, routed ns=${NAMESPACE}, concurrency=${concurrency}, max-usd=$${maxUsd}`,
);

let idx = 0;
let ran = 0;
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
      const r = await runAttempt(job.taskDir, job.arm.name, job.arm.model, 1, {
        budgetUsd: job.arm.budget,
        routed: job.arm.routed,
        namespace: NAMESPACE,
      });
      appendFileSync(logPath, `${JSON.stringify(r)}\n`);
      spent += r.cost_usd ?? 0;
      ran++;
      console.log(
        `[${new Date().toISOString()}] [w${w}] ${job.id} ${job.arm.name}: ` +
          `${r.solved ? "SOLVED" : r.cheated ? "CHEATED" : "failed"} ` +
          `(${r.chosen_model ?? job.arm.model}, ${Math.round(r.duration_ms / 1000)}s, ` +
          `$${(r.cost_usd ?? 0).toFixed(4)}) · ${ran}/${jobs.length}, ~$${spent.toFixed(2)}`,
      );
    } catch (e) {
      console.error(`[w${w}] ${job.id} ${job.arm.name} ERROR: ${String(e).slice(0, 300)}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w + 1)));
console.log(
  `[${new Date().toISOString()}] savings_ab finished: ${ran}/${jobs.length}, ~$${spent.toFixed(2)}` +
    `${stopped ? ` — STOPPED EARLY (${stopped})` : ""}`,
);
console.log("next: bun bench/gen/savings_report.ts");
