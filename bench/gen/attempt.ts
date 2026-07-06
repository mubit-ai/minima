/**
 * One calibration attempt: materialize the task, let the installed minima binary
 * (pinned model, budget-capped) attempt it in a disposable checkout, guard against
 * test tampering, grade with the hidden fail-to-pass tests, and report cost.
 *
 * Pinned runs bypass the Minima server entirely — provider spend only, and the
 * routing namespace is never touched.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHiddenTests, loadTask, materialize, runSuite } from "./materialize.ts";

export interface AttemptResult {
  task: string;
  arm: string;
  model: string;
  attempt: number;
  solved: boolean;
  cheated: boolean;
  agent_exit: number | null;
  cost_usd: number | null;
  duration_ms: number;
  ts: string;
}

async function sh(cwd: string, cmd: string[], env: Record<string, string>, timeoutMs: number) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill(9);
    } catch {}
  }, timeoutMs);
  // Never block on the streams after exit: grandchildren spawned by the agent (pytest,
  // bun test, ...) inherit the pipe and can hold it open long after the parent dies.
  const outP = new Response(proc.stdout).text().catch(() => "");
  const errP = new Response(proc.stderr).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(timer);
  const grace = Bun.sleep(2_000).then(() => ["", ""] as [string, string]);
  const [out, err] = await Promise.race([Promise.all([outP, errP]), grace]);
  return { code: killed ? null : code, out, err };
}

function attemptCost(dbPath: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query("SELECT SUM(actual_cost_usd) AS c FROM routing_decisions")
      .get() as { c: number | null };
    db.close();
    return row.c;
  } catch {
    return null;
  }
}

export async function runAttempt(
  taskDir: string,
  arm: string,
  model: string,
  attempt: number,
  opts: { budgetUsd?: string; timeoutMs?: number } = {},
): Promise<AttemptResult> {
  const meta = loadTask(taskDir);
  const scratch = mkdtempSync(join(tmpdir(), `bench-cal-${meta.id}-`));
  const work = join(scratch, "repo");
  const dbPath = join(scratch, "attempt.db");
  const started = Date.now();
  let solved = false;
  let cheated = false;
  let agentExit: number | null = null;
  let cost: number | null = null;
  try {
    await materialize(taskDir, work, { applyBug: true });
    const action =
      meta.category === "bugfix"
        ? "Find and fix the defect in the source code of this repository (current directory)."
        : "Implement the described behavior in this repository (current directory).";
    const prompt =
      `${meta.problem_statement}\n\n${action} Make the smallest correct change. ` +
      `Do NOT create, modify, or delete any test files. When done, state briefly what you changed.`;
    const r = await sh(
      work,
      ["minima", "--model", model, "-xt", "web_fetch", "-b", opts.budgetUsd ?? "0.25", "--budget-enforce", "-p", prompt],
      { MINIMA_DB_PATH: dbPath, MINIMA_NAMESPACE: "bench-calibration" },
      opts.timeoutMs ?? 300_000,
    );
    agentExit = r.code;
    cost = attemptCost(dbPath);
    // Cheating guard: any touched path under tests/ fails the attempt (build artifacts excluded).
    const diff = await sh(work, ["git", "diff", "--name-only", "HEAD"], {}, 30_000);
    const untracked = await sh(work, ["git", "ls-files", "--others", "--exclude-standard"], {}, 30_000);
    cheated = (diff.out + untracked.out)
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !/__pycache__|\.pyc$|\.pytest_cache|node_modules/.test(f))
      .some((f) => /(^|\/)tests?\//.test(f));
    if (!cheated) {
      await applyHiddenTests(taskDir, work);
      solved = (await runSuite(taskDir, work)).pass;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    task: meta.id,
    arm,
    model,
    attempt,
    solved,
    cheated,
    agent_exit: agentExit,
    cost_usd: cost,
    duration_ms: Date.now() - started,
    ts: new Date().toISOString(),
  };
}

/** Discover real task dirs (skips _-prefixed example repos). */
export function discoverTaskDirs(tasksRoot: string): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const repo of readdirSync(tasksRoot).sort()) {
    if (repo.startsWith("_")) continue;
    const repoDir = join(tasksRoot, repo);
    if (!statSync(repoDir).isDirectory()) continue;
    for (const t of readdirSync(repoDir).sort()) {
      if (existsSync(join(repoDir, t, "task.json"))) out.push(join(repoDir, t));
    }
  }
  return out;
}
