import type { AgentTool, ToolResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { objectSchema } from "./schema.ts";

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

const todoState: TodoTask[] = [];

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

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const parsed = JSON.parse(String(params.tasks));
    if (!Array.isArray(parsed)) return { content: [text("tasks must be a JSON array")] };

    todoState.length = 0;
    for (const t of parsed) {
      todoState.push({
        content: String(t.content ?? ""),
        status: t.status ?? "pending",
        priority: t.priority ?? "medium",
      });
    }

    const lines = todoState.map((t, i) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
      const pri = t.priority === "high" ? "!" : t.priority === "low" ? "-" : " ";
      return `${i + 1}. [${mark}] ${pri} ${t.content}`;
    });
    const summary = `${todoState.filter((t) => t.status === "completed").length}/${todoState.length} done`;
    return {
      content: [text(`Todo list updated (${summary}):\n${lines.join("\n")}`)],
      details: { count: todoState.length },
    };
  } catch (exc) {
    return { content: [text(`Invalid JSON: ${String(exc)}`)] };
  }
}

export function todowriteTool(): AgentTool {
  return {
    name: "todowrite",
    description:
      "Create or update a task list for multi-step work. Pass a JSON array of {content, status, priority}. The list helps track progress on complex tasks.",
    parameters,
    execute,
  };
}

export function getTodoState(): TodoTask[] {
  return [...todoState];
}
