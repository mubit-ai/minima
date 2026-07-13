/**
 * Task materialization: turn a fixture template + task patches into the working copies
 * the agent sees and the grader uses.
 *
 * Task dir layout (bench/tasks/<repo>/<task_id>/):
 *   task.json            metadata (see TaskMeta)
 *   bug.patch            optional — seeds the defect into the clean template (bugfix tasks)
 *   hidden_tests.patch   REQUIRED — adds the fail-to-pass tests; applied only at grade time
 *   oracle.patch         optional — reference fix; when absent, oracle = `git apply -R bug.patch`
 *
 * Agent-visible tree = template (+ bug.patch), committed as HEAD → `git diff` shows
 * exactly the agent's changes. Hidden tests are NEVER in the agent-visible tree.
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface TaskMeta {
  id: string;
  repo: string; // template dir name under bench/fixtures/templates/
  category: "bugfix" | "feature" | "refactor" | "kata" | "chore";
  problem_statement: string;
  test_cmd: string; // runs the FULL suite (public + any applied hidden tests), cwd = repo root
  difficulty: "trivial" | "easy" | "medium" | "hard";
  expected_route: "cheap" | "mid" | "frontier";
  est_files: number;
  est_loc: number;
  timeout_sec: number;
  trap?: string; // set when the statement's verbosity deliberately contradicts difficulty
  notes?: string;
}

export const BENCH_ROOT = join(import.meta.dir, "..");
export const TEMPLATES = join(BENCH_ROOT, "fixtures", "templates");
export const TASKS_ROOT = join(BENCH_ROOT, "tasks");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@minima.local",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@minima.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function sh(cwd: string, cmd: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
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
  const [o, e, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: killed ? null : code, out: o + e };
}

export function loadTask(taskDir: string): TaskMeta {
  return JSON.parse(readFileSync(join(resolve(taskDir), "task.json"), "utf8")) as TaskMeta;
}

export function hasBug(taskDir: string): boolean {
  return existsSync(join(taskDir, "bug.patch"));
}
export function hasOracle(taskDir: string): boolean {
  return existsSync(join(taskDir, "oracle.patch"));
}

/** Copy template → dest, git-init a base commit; optionally seed the bug as HEAD. */
export async function materialize(taskDir: string, dest: string, opts: { applyBug: boolean }): Promise<void> {
  taskDir = resolve(taskDir);
  const meta = loadTask(taskDir);
  const template = join(TEMPLATES, meta.repo);
  if (!existsSync(template)) throw new Error(`no template: ${template}`);
  cpSync(template, dest, { recursive: true, filter: (src) => !src.includes("/.git/") });
  const git = async (...args: string[]) => {
    const r = await sh(dest, ["git", ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dest}:\n${r.out.slice(0, 1500)}`);
  };
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  if (opts.applyBug && hasBug(taskDir)) {
    await git("apply", join(taskDir, "bug.patch"));
    await git("add", "-A");
    await git("commit", "-qm", "seeded");
  }
}

/** Apply the hidden fail-to-pass tests (grade time only; left uncommitted). */
export async function applyHiddenTests(taskDir: string, dest: string): Promise<void> {
  taskDir = resolve(taskDir);
  const r = await sh(dest, ["git", "apply", join(taskDir, "hidden_tests.patch")]);
  if (r.code !== 0) throw new Error(`hidden_tests.patch failed to apply:\n${r.out.slice(0, 1500)}`);
}

/** Apply the reference fix: oracle.patch when present, else reverse the seeded bug. */
export async function applyOracle(taskDir: string, dest: string): Promise<void> {
  taskDir = resolve(taskDir);
  const r = hasOracle(taskDir)
    ? await sh(dest, ["git", "apply", join(taskDir, "oracle.patch")])
    : await sh(dest, ["git", "apply", "-R", join(taskDir, "bug.patch")]);
  if (r.code !== 0) throw new Error(`oracle apply failed:\n${r.out.slice(0, 1500)}`);
}

/** Run the task's test command; returns pass/fail + output. */
export async function runSuite(
  taskDir: string,
  dest: string,
): Promise<{ pass: boolean; code: number | null; out: string }> {
  const meta = loadTask(taskDir);
  const r = await sh(dest, ["sh", "-c", meta.test_cmd], meta.timeout_sec * 1000);
  return { pass: r.code === 0, code: r.code, out: r.out };
}
