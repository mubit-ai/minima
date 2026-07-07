/**
 * bench entry point: `bun bench/run.ts [f1 f9 f4 ...]` (no args = all flows).
 *
 * Runs flows sequentially (they share provider keys and, in live lanes, real spend),
 * prints per-flow reports, exits non-zero if any hard check failed.
 */

import type { Checks } from "./assert/check.ts";
import { loadBenchEnv } from "./driver/env.ts";
import { f1 } from "./flows/f1_headless.ts";
import { f4 } from "./flows/f4_cost_budget.ts";
import { f5 } from "./flows/f5_task_dag_worktree.ts";
import { f6 } from "./flows/f6_resume_lineage.ts";
import { f7 } from "./flows/f7_permissions_plan.ts";
import { f9 } from "./flows/f9_offline_reconnect.ts";
import { f10 } from "./flows/f10_recovery_ladder.ts";
import { f12 } from "./flows/f12_learning_loop.ts";

// Force the deployed pass-through key (.env.harness) over Bun's auto-loaded .env before
// any flow spawns the binary — otherwise the local `mbt_local_admin` key wins and every
// memory write is rejected (see driver/env.ts).
loadBenchEnv();

// f12 is live-lane only (16 routed runs + judge): not part of the default sweep.
const REGISTRY: Record<string, () => Promise<Checks>> = { f1, f9, f4, f5, f6, f7, f10, f12 };
const DEFAULT_FLOWS = ["f1", "f9", "f4", "f5", "f6", "f7", "f10"];

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FLOWS;
const summaries: string[] = [];
let failed = false;

for (const name of wanted) {
  const flow = REGISTRY[name];
  if (!flow) {
    console.error(`unknown flow: ${name} (have: ${Object.keys(REGISTRY).join(", ")})`);
    process.exit(2);
  }
  console.log(`\n━━━ ${name} ━━━`);
  const started = Date.now();
  try {
    const checks = await flow();
    summaries.push(`${checks.summary()} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (!checks.passed) failed = true;
  } catch (e) {
    summaries.push(`${name}: ABORT — ${String(e).slice(0, 300)}`);
    failed = true;
  }
}

console.log(`\n━━━ summary ━━━`);
for (const s of summaries) console.log(s);
process.exit(failed ? 1 : 0);
