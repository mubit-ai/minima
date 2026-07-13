/**
 * Execution-validate task instances (the SWE-bench-Verified gates, adapted):
 *
 *   G1 clean template        → full public suite GREEN
 *   G2 bug seeded            → public suite STILL GREEN (defect invisible to public tests)
 *   G3 bug + hidden tests    → suite RED (>=1 fail-to-pass test exists)
 *   G4 oracle fix + hidden   → suite GREEN (reference fix restores everything)
 *   G5 problem_statement     → >=40 words
 *
 * Feature/kata tasks (no bug.patch): G2 is skipped; G3 runs hidden tests against the
 * clean template; G4 requires an explicit oracle.patch.
 *
 * Usage:
 *   bun bench/gen/validate_task.ts bench/tasks/py-cli/pc-001 [more task dirs...]
 *   bun bench/gen/validate_task.ts --all
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHiddenTests,
  applyOracle,
  hasBug,
  hasOracle,
  loadTask,
  materialize,
  runSuite,
  TASKS_ROOT,
} from "./materialize.ts";

function discoverAll(): string[] {
  const out: string[] = [];
  if (!existsSync(TASKS_ROOT)) return out;
  for (const repo of readdirSync(TASKS_ROOT)) {
    const repoDir = join(TASKS_ROOT, repo);
    if (!statSync(repoDir).isDirectory()) continue;
    for (const t of readdirSync(repoDir)) {
      const taskDir = join(repoDir, t);
      if (existsSync(join(taskDir, "task.json"))) out.push(taskDir);
    }
  }
  return out.sort();
}

export async function validateTask(taskDir: string): Promise<{ ok: boolean; gates: string[] }> {
  const gates: string[] = [];
  const meta = loadTask(taskDir);
  const fail = (g: string, detail: string) => {
    gates.push(`✗ ${g}: ${detail.slice(0, 400)}`);
    return { ok: false, gates };
  };
  const pass = (g: string) => gates.push(`✓ ${g}`);

  if (!existsSync(join(taskDir, "hidden_tests.patch"))) return fail("G0", "missing hidden_tests.patch");
  if (!hasBug(taskDir) && !hasOracle(taskDir)) return fail("G0", "feature task needs oracle.patch");

  // G5 first (free)
  const words = meta.problem_statement.trim().split(/\s+/).length;
  if (words < 40) return fail("G5 statement>=40w", `${words} words`);
  pass("G5 statement>=40w");

  const scratch = mkdtempSync(join(tmpdir(), `bench-val-${meta.id}-`));
  try {
    // G1 clean template green
    const clean = join(scratch, "clean");
    await materialize(taskDir, clean, { applyBug: false });
    const g1 = await runSuite(taskDir, clean);
    if (!g1.pass) return fail("G1 template green", `exit=${g1.code}\n${g1.out.slice(-800)}`);
    pass("G1 template green");

    // G2 bug invisible to public suite
    const buggy = join(scratch, "buggy");
    await materialize(taskDir, buggy, { applyBug: true });
    if (hasBug(taskDir)) {
      const g2 = await runSuite(taskDir, buggy);
      if (!g2.pass) return fail("G2 bug invisible to public suite", `exit=${g2.code}\n${g2.out.slice(-800)}`);
      pass("G2 bug invisible to public suite");
    } else {
      pass("G2 (skipped — feature task)");
    }

    // G3 hidden tests catch it
    await applyHiddenTests(taskDir, buggy);
    const g3 = await runSuite(taskDir, buggy);
    if (g3.pass) return fail("G3 hidden tests fail pre-fix", "suite green — no fail-to-pass signal");
    pass("G3 hidden tests fail pre-fix");

    // G4 oracle restores green (fresh copy: bug + oracle + hidden)
    const fixed = join(scratch, "fixed");
    await materialize(taskDir, fixed, { applyBug: true });
    await applyOracle(taskDir, fixed);
    await applyHiddenTests(taskDir, fixed);
    const g4 = await runSuite(taskDir, fixed);
    if (!g4.pass) return fail("G4 oracle restores green", `exit=${g4.code}\n${g4.out.slice(-800)}`);
    pass("G4 oracle restores green");

    return { ok: true, gates };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.includes("--all") ? discoverAll() : args;
  if (!dirs.length) {
    console.error("usage: bun bench/gen/validate_task.ts <task-dir>... | --all");
    process.exit(2);
  }
  let failed = 0;
  for (const d of dirs) {
    try {
      const r = await validateTask(d);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${d}`);
      for (const g of r.gates) console.log(`  ${g}`);
      if (!r.ok) failed++;
    } catch (e) {
      console.log(`ERROR ${d}: ${String(e).slice(0, 400)}`);
      failed++;
    }
  }
  console.log(`\n${dirs.length - failed}/${dirs.length} tasks valid`);
  process.exit(failed ? 1 : 0);
}
