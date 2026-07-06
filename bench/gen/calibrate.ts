/**
 * Empirical difficulty calibration: run each task k times per arm with a PINNED model
 * through the installed minima binary (headless, disposable checkout), grade with the
 * hidden fail-to-pass tests, and append results to bench/tasks/calibration.jsonl.
 *
 * Pinned runs bypass the Minima server entirely — calibration spends provider money
 * only. Grading guards against test-tampering: any change under tests/ counts as
 * failed (cheated=true).
 *
 * Usage:
 *   bun bench/gen/calibrate.ts --tasks pc-001,ka-003 --arms cheap --k 2
 *   bun bench/gen/calibrate.ts --tasks all --arms cheap,frontier --k 5   # full run
 * Flags: --cheap-model (default claude-haiku-4-5), --frontier-model (default
 * claude-sonnet-4-6 — switch to claude-opus-4-8 for the real frontier arm),
 * --budget (per-attempt USD cap, default 0.25), --attempt-timeout-s (default 300).
 *
 * Label thresholds (applied by the reporter, aider-polyglot style):
 *   easy: cheap >= 0.8 · medium: cheap in [0.2, 0.6] and frontier >= 0.8
 *   hard: cheap <= 0.2 and frontier >= 0.5 · no-signal: both ~0 or both ~1 → drop/rework
 */

import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHiddenTests,
  loadTask,
  materialize,
  runSuite,
  TASKS_ROOT,
} from "./materialize.ts";

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
  const all: string[] = [];
  for (const repo of readdirSync(TASKS_ROOT).sort()) {
    if (repo.startsWith("_")) continue;
    const repoDir = join(TASKS_ROOT, repo);
    if (!statSync(repoDir).isDirectory()) continue;
    for (const t of readdirSync(repoDir).sort()) {
      if (existsSync(join(repoDir, t, "task.json"))) all.push(join(repoDir, t));
    }
  }
  if (sel === "all") return all;
  const parts = sel.split(",").map((s) => s.trim());
  // Entries containing "/" are literal task dirs (lets smokes target _-prefixed examples).
  const literals = parts.filter((p) => p.includes("/"));
  const ids = new Set(parts.filter((p) => !p.includes("/")));
  return [...literals, ...all.filter((d) => ids.has(loadTask(d).id))];
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
  console.error("no tasks selected (--tasks all | id,id,...)");
  process.exit(2);
}
const logPath = join(TASKS_ROOT, "calibration.jsonl");
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
      const scratch = mkdtempSync(join(tmpdir(), `bench-cal-${meta.id}-`));
      const work = join(scratch, "repo");
      const started = Date.now();
      let solved = false;
      let cheated = false;
      let agentExit: number | null = null;
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
          ["minima", "--model", model, "-xt", "web_fetch", "-b", budget, "--budget-enforce", "-p", prompt],
          { MINIMA_DB_PATH: join(scratch, "attempt.db"), MINIMA_NAMESPACE: "bench-calibration" },
          attemptTimeoutMs,
        );
        agentExit = r.code;
        // Cheating guard: any touched path under tests/ fails the attempt.
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
      } catch (e) {
        console.error(`  attempt error: ${String(e).slice(0, 200)}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const row = {
        task: meta.id,
        arm,
        model,
        attempt,
        solved,
        cheated,
        agent_exit: agentExit,
        duration_ms: Date.now() - started,
        ts: new Date().toISOString(),
      };
      appendFileSync(logPath, `${JSON.stringify(row)}\n`);
      console.log(
        `${meta.id} ${arm}#${attempt}: ${solved ? "SOLVED" : cheated ? "CHEATED" : "failed"} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    }
  }
}
console.log("done — rebuild the index to fold rates in: bun bench/gen/build_index.ts");
