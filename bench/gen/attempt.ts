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
  model: string; // pinned model, or "routed" for router-chosen
  attempt: number;
  solved: boolean;
  cheated: boolean;
  agent_exit: number | null;
  cost_usd: number | null;
  /** Router telemetry from the attempt DB (lead row): what actually ran. */
  chosen_model?: string | null;
  routed_kind?: string | null; // server | pinned | offline
  decision_basis?: string | null; // memory | prior | llm | offline
  est_cost_usd?: number | null;
  est_premium_usd?: number | null; // server's all-premium counterfactual estimate
  /** Rows whose feedback response carried reinforced_entry_ids (memory write landed). */
  reinforced_n?: number;
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

function attemptTelemetry(dbPath: string): {
  cost: number | null;
  chosen: string | null;
  routedKind: string | null;
  basis: string | null;
  estCost: number | null;
  estPremium: number | null;
  reinforcedN: number;
} {
  try {
    const db = new Database(dbPath, { readonly: true });
    const sums = db
      .query(
        "SELECT SUM(actual_cost_usd) AS c, SUM(est_cost_usd) AS e, SUM(all_premium_cost_usd) AS p FROM routing_decisions",
      )
      .get() as { c: number | null; e: number | null; p: number | null };
    const lead = db
      .query(
        "SELECT chosen_model, routed, decision_basis FROM routing_decisions WHERE agent_id = '' OR agent_id IS NULL ORDER BY ts DESC LIMIT 1",
      )
      .get() as { chosen_model: string; routed: string; decision_basis: string } | null;
    const reinforced = db
      .query(
        "SELECT COUNT(*) AS n FROM routing_decisions WHERE reinforced_entry_ids IS NOT NULL AND reinforced_entry_ids != '' AND reinforced_entry_ids != '[]'",
      )
      .get() as { n: number };
    db.close();
    return {
      cost: sums.c,
      chosen: lead?.chosen_model ?? null,
      routedKind: lead?.routed ?? null,
      basis: lead?.decision_basis ?? null,
      estCost: sums.e,
      estPremium: sums.p,
      reinforcedN: reinforced.n,
    };
  } catch {
    return {
      cost: null,
      chosen: null,
      routedKind: null,
      basis: null,
      estCost: null,
      estPremium: null,
      reinforcedN: 0,
    };
  }
}

export async function runAttempt(
  taskDir: string,
  arm: string,
  model: string,
  attempt: number,
  opts: {
    budgetUsd?: string;
    timeoutMs?: number;
    routed?: boolean;
    namespace?: string;
    extraEnv?: Record<string, string>;
  } = {},
): Promise<AttemptResult> {
  const meta = loadTask(taskDir);
  const scratch = mkdtempSync(join(tmpdir(), `bench-cal-${meta.id}-`));
  const work = join(scratch, "repo");
  const dbPath = join(scratch, "attempt.db");
  const started = Date.now();
  let solved = false;
  let cheated = false;
  let agentExit: number | null = null;
  let telem: ReturnType<typeof attemptTelemetry> = {
    cost: null,
    chosen: null,
    routedKind: null,
    basis: null,
    estCost: null,
    estPremium: null,
    reinforcedN: 0,
  };
  try {
    await materialize(taskDir, work, { applyBug: true });
    const action =
      meta.category === "bugfix"
        ? "Find and fix the defect in the source code of this repository (current directory)."
        : "Implement the described behavior in this repository (current directory).";
    const prompt =
      `${meta.problem_statement}\n\n${action} Make the smallest correct change. ` +
      `Do NOT create, modify, or delete any test files. When done, state briefly what you changed.`;
    // routed = the actual product (server picks the model); otherwise pin `model`.
    const modelArgs = opts.routed ? [] : ["--model", model];
    const r = await sh(
      work,
      ["minima", ...modelArgs, "-xt", "web_fetch", "-b", opts.budgetUsd ?? "0.25", "--budget-enforce", "-p", prompt],
      {
        MINIMA_DB_PATH: dbPath,
        MINIMA_NAMESPACE: opts.namespace ?? "bench-calibration",
        ...opts.extraEnv,
      },
      opts.timeoutMs ?? 300_000,
    );
    agentExit = r.code;
    telem = attemptTelemetry(dbPath);
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
    cost_usd: telem.cost,
    chosen_model: telem.chosen,
    routed_kind: telem.routedKind,
    decision_basis: telem.basis,
    est_cost_usd: telem.estCost,
    est_premium_usd: telem.estPremium,
    reinforced_n: telem.reinforcedN,
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
