import type { AgentTool, ToolResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { objectSchema } from "./schema.ts";

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
  verify?: string;
}

const parameters = objectSchema(
  {
    tasks: {
      type: "string",
      description:
        "JSON array of tasks. Each task: {content, status, priority, verify?}. " +
        "verify = a shell command that proves the task is done " +
        "(e.g. `bun test tests/foo.test.ts`). Optional `tools` = a JSON array naming the tools " +
        'this task is allowed to use (e.g. ["read","edit","bash"]); while the task is in ' +
        "progress the harness blocks any other mutating tool. Both verify and tools are sticky: " +
        "omitting keeps the previous value, resending overwrites, neither can be cleared.",
    },
  },
  ["tasks"],
);

/**
 * Per-INSTANCE todo state: each todowriteTool() owns its own list (closure), so parallel
 * agents in one process never trample each other's todos. (This was a module-level
 * singleton — an isolation hazard for sub-agents.) Pass `state` to observe the list from
 * outside (e.g. a TUI panel).
 *
 * M3.3 (plan verification only): executionMode "sequential" — any batch containing todowrite runs
 * in emission order, so the plan sink's pre-work baseline check (afterToolCall)
 * observes the repo before sibling edit/write/bash calls mutate it, and two todowrites in one
 * batch cannot interleave. With plan verification OFF none of that machinery exists, so the tool
 * keeps its historical parallel-friendly description and mode — the model must not be told of
 * a verify gate that will never run.
 */
export function todowriteTool(state: TodoTask[] = [], opts: { bigPlan?: boolean } = {}): AgentTool {
  return {
    name: "todowrite",
    description: opts.bigPlan
      ? "Track a task list for multi-step coding work. Pass a JSON array: " +
        '[{"content":"add tests","status":"pending","priority":"high","verify":"bun test tests/foo.test.ts"}]. ' +
        "status: pending|in_progress|completed. priority: high|medium|low. Replaces entire list " +
        "(but a task's recorded verify and tools allowlist are sticky: omit to keep, resend to overwrite; neither can be cleared). " +
        'Optionally add `"tools":["read","edit","bash"]` to restrict a task to a minimal toolset — the harness blocks any other mutating tool while it is in progress. ' +
        "Attach a `verify` shell command WHEN YOU CREATE a task that produces something checkable (a " +
        "feature, a fix, a test) — a real test/build command that proves it. If you cannot name a " +
        "verify for a task, it is too vague — split it into tasks you can check. A pure-scaffolding " +
        "task with no runnable check may omit it. " +
        "Marking a task completed runs its verify first — the completion is refused unless the check passes."
      : "Track a task list for multi-step coding work. Pass a JSON array: " +
        '[{"content":"add tests","status":"pending","priority":"high"}]. ' +
        "status: pending|in_progress|completed. priority: high|medium|low. Replaces entire list.",
    parameters,
    ...(opts.bigPlan ? { executionMode: "sequential" as const } : {}),
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Tolerate a real array: the schema says string-of-JSON, but models sometimes emit the
        // array unencoded, and String([{…}]) would mangle it into "[object Object]".
        const raw = params.tasks;
        const parsed = Array.isArray(raw) ? raw : JSON.parse(String(raw));
        if (!Array.isArray(parsed)) return { content: [text("tasks must be a JSON array")] };

        state.length = 0;
        for (const t of parsed) {
          const verify =
            typeof t.verify === "string" && t.verify.trim() ? t.verify.trim() : undefined;
          state.push({
            content: String(t.content ?? ""),
            status: t.status ?? "pending",
            priority: t.priority ?? "medium",
            ...(verify ? { verify } : {}),
          });
        }

        const lines = state.map((t, i) => {
          const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
          const pri = t.priority === "high" ? "!" : t.priority === "low" ? "-" : " ";
          return `${i + 1}. [${mark}] ${pri} ${t.content}`;
        });
        const summary = `${state.filter((t) => t.status === "completed").length}/${state.length} done`;
        return {
          content: [text(`Todo list updated (${summary}):\n${lines.join("\n")}`)],
          details: { count: state.length },
        };
      } catch (exc) {
        return { content: [text(`Invalid JSON: ${String(exc)}`)] };
      }
    },
  };
}
