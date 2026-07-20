/**
 * Repo-gate mining (E3, TestPrune-shaped) — a repository's own manifests already name
 * its real checks, and those commands are trusted BY CONSTRUCTION: they existed before
 * the agent did, so they can never be agent-graded homework (Agentless: agent-authored
 * oracles run ~50% wrong). Mining is pure file reads — no execution, no LLM.
 *
 * Attachment happens at /plan finalize, which keeps MP18 intact: mined commands land on
 * the plan BEFORE the user approves it, so plan approval is their consent event exactly
 * like authored verifies. Tiering (Anthropic C-compiler pattern): verify-less steps get
 * the FAST command (typecheck/lint — quick feedback in-loop); the final step gets the
 * full test suite, so the done-gate ends the plan on the complete check.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RepoGate {
  command: string;
  kind: "test" | "typecheck" | "lint";
  /** Which manifest named it (diagnostics/audit only). */
  source: string;
}

function packageJsonGates(dir: string): RepoGate[] {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts =
      (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ??
      {};
  } catch {
    return [];
  }
  const runner =
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")) ? "bun run" : "npm run";
  const out: RepoGate[] = [];
  const map: [string, RepoGate["kind"]][] = [
    ["test", "test"],
    ["check", "typecheck"],
    ["typecheck", "typecheck"],
    ["lint", "lint"],
  ];
  for (const [script, kind] of map) {
    if (typeof scripts[script] === "string") {
      // `bun test` is the native runner, not a script alias.
      const cmd = script === "test" && runner === "bun run" ? "bun test" : `${runner} ${script}`;
      out.push({ command: cmd, kind, source: "package.json" });
    }
  }
  return out;
}

function makefileGates(dir: string): RepoGate[] {
  const path = join(dir, "Makefile");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const targets = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m) targets.add(m[1]!);
  }
  const out: RepoGate[] = [];
  if (targets.has("test")) out.push({ command: "make test", kind: "test", source: "Makefile" });
  if (targets.has("lint")) out.push({ command: "make lint", kind: "lint", source: "Makefile" });
  if (targets.has("check"))
    out.push({ command: "make check", kind: "typecheck", source: "Makefile" });
  return out;
}

function pythonGates(dir: string): RepoGate[] {
  if (!existsSync(join(dir, "pyproject.toml"))) return [];
  const runner = existsSync(join(dir, "uv.lock")) ? "uv run pytest" : "pytest";
  const hasTests = existsSync(join(dir, "tests")) || existsSync(join(dir, "test"));
  return hasTests ? [{ command: runner, kind: "test", source: "pyproject.toml" }] : [];
}

/**
 * Mine a repo's own check commands, first manifest wins per kind (Makefile targets are
 * usually the curated entry points, so they outrank raw package scripts).
 */
export function mineRepoGates(dir: string): RepoGate[] {
  const all = [...makefileGates(dir), ...packageJsonGates(dir), ...pythonGates(dir)];
  const byKind = new Map<RepoGate["kind"], RepoGate>();
  for (const gate of all) if (!byKind.has(gate.kind)) byKind.set(gate.kind, gate);
  return [...byKind.values()];
}

/** The in-loop (fast) command: typecheck > lint — quick feedback while working. */
export function fastGate(gates: RepoGate[]): RepoGate | null {
  return gates.find((g) => g.kind === "typecheck") ?? gates.find((g) => g.kind === "lint") ?? null;
}

/** The done-gate (full) command: the real test suite. */
export function fullGate(gates: RepoGate[]): RepoGate | null {
  return gates.find((g) => g.kind === "test") ?? null;
}

export interface AutoGateResult {
  steps: { content: string; verify?: string | null; tools?: string[] | null }[];
  /** 1-based step numbers that received a mined command (for the finalize note). */
  attached: number[];
  fast: RepoGate | null;
  full: RepoGate | null;
}

/**
 * Attach mined commands to a finalized plan's steps: verify-less steps get the fast
 * command; the LAST step additionally gets the full suite (its own verify wins if
 * authored). Steps with authored checks are never overwritten — mining fills gaps only.
 */
export function attachAutoGates(
  steps: { content: string; verify?: string | null; tools?: string[] | null }[],
  gates: RepoGate[],
): AutoGateResult {
  const fast = fastGate(gates);
  const full = fullGate(gates);
  const attached: number[] = [];
  const out = steps.map((step, i) => {
    if (step.verify?.trim()) return step;
    const isLast = i === steps.length - 1;
    const pick = isLast ? (full ?? fast) : (fast ?? null);
    if (!pick) return step;
    attached.push(i + 1);
    return { ...step, verify: pick.command };
  });
  return { steps: out, attached, fast, full };
}

/** Finalize-note line for what mining attached ("" when nothing changed). */
export function formatAutoGateNote(result: AutoGateResult): string {
  if (result.attached.length === 0) return "";
  const src = [result.fast?.source, result.full?.source].filter(Boolean).join(", ");
  return `\n\n🔩 Auto-gates: attached repo checks to step(s) ${result.attached.join(", ")} (mined from ${src || "repo manifests"} — trusted by construction). Approving the plan approves these commands.`;
}
