/**
 * task tool — the single orchestration primitive: delegate subtasks to child agents.
 *
 * The model calls `task` with a JSON array of Delegations (the hard subtask contract:
 * objective/output_format/boundaries REQUIRED — Anthropic's delegation-prompt discipline
 * as a schema, not a convention). The tool validates the graph (missing fields, duplicate
 * step_ids, dangling depends_on, cycles), then executes nodes SEQUENTIALLY in dependency
 * order via the injected SpawnFn — each child is its own agent with its own routed model,
 * tool scope, workdir, and budget slice. Parallel frontiers land later (M-G); the
 * loop/agent are untouched — this is just a tool.
 *
 * Registered conditionally: only when spawnDepth < maxDepth, so a child at the depth
 * limit sees an explicit "depth exhausted" rather than a silently missing tool.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { objectSchema } from "./schema.ts";

export interface Delegation {
  step_id: string;
  /** REQUIRED: what the child must accomplish. */
  objective: string;
  /** REQUIRED: what the child returns (shape/format of its final answer). */
  output_format: string;
  /** REQUIRED: what the child must NOT touch (another worker's territory). */
  boundaries: string;
  tool_guidance?: string;
  depends_on?: string[];
  effort?: "light" | "standard" | "deep";
  difficulty?: "trivial" | "easy" | "medium" | "hard" | "expert";
  tool_allowlist?: string[];
  budget_usd?: number;
  isolation?: "workdir" | "inherit";
}

export interface ChildResult {
  step_id: string;
  childId: string;
  text: string;
  costUsd: number;
  quality: number | null;
  outcome: "success" | "partial" | "failure" | "aborted";
  workdir: string | null;
}

export interface SpawnContext {
  depth: number;
  /** Parent abort propagates: spawn implementations MUST wire this to child.abort(). */
  parentSignal: AbortSignal | null;
  /** Results of already-completed dependency nodes (context for dependents). */
  priorResults: ChildResult[];
}

export type SpawnFn = (d: Delegation, ctx: SpawnContext) => Promise<ChildResult>;

/** Validate a parsed delegation array: required fields, unique ids, resolvable DAG. */
export function validateDelegations(
  parsed: unknown,
): { ok: true; value: Delegation[] } | { ok: false; error: string } {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "delegations must be a non-empty JSON array" };
  }
  const ds = parsed as Delegation[];
  const ids = new Set<string>();
  for (const [i, d] of ds.entries()) {
    for (const field of ["step_id", "objective", "output_format", "boundaries"] as const) {
      if (!d?.[field] || typeof d[field] !== "string" || !d[field].trim()) {
        return {
          ok: false,
          error: `delegation[${i}] missing required "${field}" — every subtask needs step_id, objective, output_format (what to return), and boundaries (what NOT to touch)`,
        };
      }
    }
    if (ids.has(d.step_id)) return { ok: false, error: `duplicate step_id "${d.step_id}"` };
    ids.add(d.step_id);
  }
  for (const d of ds) {
    for (const dep of d.depends_on ?? []) {
      if (!ids.has(dep)) {
        return { ok: false, error: `step "${d.step_id}" depends_on unknown step "${dep}"` };
      }
    }
  }
  // Cycle check via Kahn's algorithm — anything not orderable is cyclic.
  if (topoOrder(ds) === null) {
    return { ok: false, error: "delegation graph has a cycle — depends_on must be a DAG" };
  }
  return { ok: true, value: ds };
}

/** Dependency-respecting order (stable for independent nodes); null when cyclic. */
export function topoOrder(ds: Delegation[]): Delegation[] | null {
  const byId = new Map(ds.map((d) => [d.step_id, d]));
  const indeg = new Map(ds.map((d) => [d.step_id, (d.depends_on ?? []).length]));
  const out = new Map<string, string[]>();
  for (const d of ds) {
    for (const dep of d.depends_on ?? []) {
      out.set(dep, [...(out.get(dep) ?? []), d.step_id]);
    }
  }
  const queue = ds.filter((d) => (indeg.get(d.step_id) ?? 0) === 0).map((d) => d.step_id);
  const order: Delegation[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of out.get(id) ?? []) {
      const n = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  return order.length === ds.length ? order : null;
}

const parameters = objectSchema(
  {
    delegations: {
      type: "string",
      description:
        'JSON array of subtasks. Each: {"step_id": "unique-id", "objective": "what to do", ' +
        '"output_format": "what to return", "boundaries": "what NOT to touch", ' +
        '"depends_on": ["other-step-ids"], "effort": "light|standard|deep", ' +
        '"difficulty": "trivial|easy|medium|hard|expert", "budget_usd": 0.5}. ' +
        "objective/output_format/boundaries are REQUIRED per subtask.",
    },
  },
  ["delegations"],
);

export interface TaskToolOptions {
  spawn: SpawnFn;
  /** This agent's depth in the spawn tree (lead = 0). */
  spawnDepth?: number;
  /** Depth cap: a child at the cap gets an explicit refusal, not a missing tool. */
  maxDepth?: number;
}

export function taskTool(opts: TaskToolOptions): AgentTool {
  const depth = opts.spawnDepth ?? 0;
  const maxDepth = opts.maxDepth ?? 2;
  return {
    name: "task",
    description:
      "Delegate subtasks to child agents, each cost-routed to its own model and run in " +
      "sequence respecting depends_on. Use for decomposable work (research a module, make " +
      "an isolated change, verify a result). Each delegation MUST state objective, " +
      "output_format, and boundaries. Prefer 1 subtask for a focused question; more only " +
      "when genuinely independent.",
    parameters,
    // Children run one at a time (M-G adds parallel frontiers); keep the batch sequential
    // so two task calls in one assistant turn can't interleave children.
    executionMode: "sequential",
    async execute(_id, params, signal): Promise<ToolResult> {
      if (depth >= maxDepth) {
        return errorResult(
          `task: spawn depth ${depth} is at the limit (${maxDepth}) — do the work directly instead of delegating further`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(params.delegations));
      } catch (exc) {
        return errorResult(`task: delegations is not valid JSON: ${String(exc)}`);
      }
      const v = validateDelegations(parsed);
      if (!v.ok) return errorResult(`task: ${v.error}`);

      const order = topoOrder(v.value)!;
      const results: ChildResult[] = [];
      const failed = new Set<string>();
      for (const d of order) {
        if (signal?.aborted) break;
        // Partial-failure semantics: a failed dependency blocks its dependents.
        const blockedBy = (d.depends_on ?? []).filter((dep) => failed.has(dep));
        if (blockedBy.length) {
          failed.add(d.step_id);
          results.push({
            step_id: d.step_id,
            childId: "",
            text: `blocked: dependency ${blockedBy.join(", ")} failed`,
            costUsd: 0,
            quality: null,
            outcome: "failure",
            workdir: null,
          });
          continue;
        }
        try {
          const res = await opts.spawn(d, {
            depth: depth + 1,
            parentSignal: signal ?? null,
            priorResults: [...results],
          });
          results.push(res);
          if (res.outcome === "failure" || res.outcome === "aborted") failed.add(d.step_id);
        } catch (exc) {
          failed.add(d.step_id);
          results.push({
            step_id: d.step_id,
            childId: "",
            text: `spawn failed: ${String(exc)}`,
            costUsd: 0,
            quality: null,
            outcome: "failure",
            workdir: null,
          });
        }
      }

      const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
      const summary = results
        .map(
          (r) =>
            `## ${r.step_id} [${r.outcome}] ($${r.costUsd.toFixed(4)})\n${r.text || "(no output)"}`,
        )
        .join("\n\n");
      return {
        content: [
          text(
            `${summary}\n\n---\n${results.length} subtask(s), ${results.filter((r) => r.outcome === "success").length} succeeded, total $${totalCost.toFixed(4)}`,
          ),
        ],
        details: {
          n: results.length,
          succeeded: results.filter((r) => r.outcome === "success").length,
          total_cost_usd: totalCost,
        },
      };
    },
  };
}
