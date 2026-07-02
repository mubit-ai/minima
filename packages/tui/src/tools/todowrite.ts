import type { AgentTool, ToolResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { objectSchema } from "./schema.ts";

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

const parameters = objectSchema(
  {
    tasks: {
      type: "string",
      description:
        "JSON array of tasks. Each task: {content, status, priority}. Replaces the entire list.",
    },
  },
  ["tasks"],
);

/**
 * Per-INSTANCE todo state: each todowriteTool() owns its own list (closure), so parallel
 * agents in one process never trample each other's todos. (This was a module-level
 * singleton — an isolation hazard for sub-agents.) Pass `state` to observe the list from
 * outside (e.g. a TUI panel).
 */
export function todowriteTool(state: TodoTask[] = []): AgentTool {
  return {
    name: "todowrite",
    description:
      "Track a task list for multi-step coding work. Pass a JSON array: " +
      '[{"content":"add tests","status":"pending","priority":"high"}]. ' +
      "status: pending|in_progress|completed. priority: high|medium|low. Replaces entire list.",
    parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const parsed = JSON.parse(String(params.tasks));
        if (!Array.isArray(parsed)) return { content: [text("tasks must be a JSON array")] };

        state.length = 0;
        for (const t of parsed) {
          state.push({
            content: String(t.content ?? ""),
            status: t.status ?? "pending",
            priority: t.priority ?? "medium",
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
