/**
 * Build bench/tasks/tasks.jsonl — one line per task, joining task.json metadata with
 * structural facts derived from the patches (diff footprint) and, when present,
 * measured solve rates from bench/tasks/calibration.jsonl.
 *
 * Repos whose directory name starts with "_" are examples/scaffolding and are skipped.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasBug, hasOracle, loadTask, TASKS_ROOT } from "./materialize.ts";

function diffStats(patchPath: string): { files: number; addedOrRemoved: number } {
  if (!existsSync(patchPath)) return { files: 0, addedOrRemoved: 0 };
  const text = readFileSync(patchPath, "utf8");
  const files = (text.match(/^diff --git /gm) ?? []).length;
  const addedOrRemoved = (text.match(/^[+-](?![+-])/gm) ?? []).length;
  return { files, addedOrRemoved };
}

interface CalibrationRow {
  task: string;
  arm: string;
  solved: boolean;
  cheated?: boolean;
}

function solveRates(): Map<string, Record<string, { n: number; solved: number }>> {
  const out = new Map<string, Record<string, { n: number; solved: number }>>();
  const p = join(TASKS_ROOT, "calibration.jsonl");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as CalibrationRow;
    const rec = out.get(r.task) ?? {};
    const arm = (rec[r.arm] ??= { n: 0, solved: 0 });
    arm.n++;
    if (r.solved && !r.cheated) arm.solved++;
    out.set(r.task, rec);
  }
  return out;
}

const rates = solveRates();
const lines: string[] = [];
for (const repo of readdirSync(TASKS_ROOT).sort()) {
  if (repo.startsWith("_")) continue;
  const repoDir = join(TASKS_ROOT, repo);
  if (!statSync(repoDir).isDirectory()) continue;
  for (const t of readdirSync(repoDir).sort()) {
    const taskDir = join(repoDir, t);
    if (!existsSync(join(taskDir, "task.json"))) continue;
    const meta = loadTask(taskDir);
    const bug = diffStats(join(taskDir, "bug.patch"));
    const oracle = diffStats(join(taskDir, "oracle.patch"));
    const footprint = hasBug(taskDir) ? bug : oracle;
    const measured = rates.get(meta.id);
    lines.push(
      JSON.stringify({
        ...meta,
        has_bug_patch: hasBug(taskDir),
        has_oracle_patch: hasOracle(taskDir),
        diff_files: footprint.files,
        diff_lines: footprint.addedOrRemoved,
        measured_solve_rates: measured
          ? Object.fromEntries(
              Object.entries(measured).map(([arm, v]) => [arm, { n: v.n, rate: v.solved / v.n }]),
            )
          : undefined,
        task_dir: `bench/tasks/${repo}/${t}`,
      }),
    );
  }
}

const dest = join(TASKS_ROOT, "tasks.jsonl");
writeFileSync(dest, `${lines.join("\n")}\n`, "utf8");
console.log(`${lines.length} tasks -> ${dest}`);
