/**
 * bgjob — the single action-enum control tool for background bash jobs (W4.1).
 *
 * One tool, `action` ∈ status | wait | output | kill | list, keeps the additive surface
 * minimal (Owner decision: one tool, not separate bash_output/kill_shell tools). `id` is
 * required for every action except `list` (a custom validate wrapper, the rewind precedent);
 * `wait`'s `timeout` is clamped to [50, 300000] ms. All work delegates to the registry.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import type { ParseResult, ToolSchema } from "../ai/types.ts";
import type { BgJobRegistry } from "./_bgjobs.ts";
import { objectSchema } from "./schema.ts";

const ACTIONS = ["status", "wait", "output", "kill", "list"] as const;

const WAIT_DEFAULT_MS = 30_000;
const WAIT_MIN_MS = 50;
const WAIT_MAX_MS = 300_000;

const bgJobParameters: ToolSchema = (() => {
  const base = objectSchema(
    {
      action: {
        type: "string",
        description:
          "status: current state/exit. wait: block up to timeout ms for exit. output: current bounded stdout/stderr snapshot. kill: signal the job's process group. list: all jobs this session.",
        enum: [...ACTIONS],
      },
      id: {
        type: "string",
        description: "Job id (bg_…). Required for status/wait/output/kill; omit for list.",
      },
      timeout: {
        type: "integer",
        description: "wait only: max ms to block (default 30000, clamped 50–300000).",
        default: WAIT_DEFAULT_MS,
      },
    },
    ["action"],
  );
  return {
    jsonSchema: base.jsonSchema,
    validate(value): ParseResult<Record<string, unknown>> {
      const parsed = base.validate(value);
      if (!parsed.ok) return parsed;
      if (parsed.value.action !== "list" && !String(parsed.value.id ?? "").trim()) {
        return { ok: false, errors: ["id: required for this action (omit only for list)"] };
      }
      return parsed;
    },
  };
})();

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return WAIT_DEFAULT_MS;
  return Math.min(hi, Math.max(lo, v));
}

export function bgJobTool(registry: BgJobRegistry): AgentTool {
  return {
    name: "bgjob",
    description:
      "Manage background bash jobs (started with bash background:true). Actions: status, " +
      "wait (block for exit), output (current bounded output), kill, list. Pass the job id " +
      "returned by the bash launch for every action except list.",
    parameters: bgJobParameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = String(params.action);
      const jobId = params.id != null ? String(params.id) : "";
      switch (action) {
        case "list":
          return registry.listResult();
        case "status":
          return registry.statusResult(jobId);
        case "output":
          return registry.outputResult(jobId);
        case "kill":
          return registry.killResult(jobId);
        case "wait":
          return registry.waitResult(
            jobId,
            clamp(Number(params.timeout ?? WAIT_DEFAULT_MS), WAIT_MIN_MS, WAIT_MAX_MS),
          );
        default:
          return errorResult(`bgjob: unknown action ${action}`);
      }
    },
  };
}
