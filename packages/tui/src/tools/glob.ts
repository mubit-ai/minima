import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand } from "./_io.ts";
import { objectSchema } from "./schema.ts";

const parameters = objectSchema(
  {
    pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/*.py)." },
    path: { type: "string", description: "Base directory to search from.", default: "." },
  },
  ["pattern"],
);

async function execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(params.pattern ?? "");
  const base = expand(String(params.path ?? "."));
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const p of glob.scan({ cwd: base, dot: false })) {
    matches.push(p);
    if (matches.length >= 200) break;
  }
  if (!matches.length) return { content: [text("(no matches)")] };
  matches.sort();
  return { content: [text(matches.join("\n"))], details: { count: matches.length } };
}

export function globTool(): AgentTool {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns paths relative to the base directory. Supports ** for recursive matching.",
    parameters,
    execute,
  };
}
