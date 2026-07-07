import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    pattern: { type: "string", description: "Regular expression to search for." },
    path: { type: "string", description: "File or directory to search in.", default: "." },
    glob: {
      type: "string",
      description: "File pattern to include (e.g. *.ts). Omit to search all files.",
    },
    case_insensitive: {
      type: "boolean",
      description: "Case-insensitive match.",
      default: false,
    },
  },
  ["pattern"],
);

async function executeWithin(
  workdir: string | undefined,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const pattern = String(params.pattern ?? "");
  const r = resolveWithin(String(params.path ?? "."), workdir);
  if (!r.ok) return errorResult(`grep: ${r.error}`);
  const path = r.path;
  const fileGlob = params.glob ? String(params.glob) : undefined;
  const ci = Boolean(params.case_insensitive);

  const args = ["-n", "--no-heading", "--color=never", "-N"];
  if (ci) args.push("-i");
  if (fileGlob) args.push("-g", fileGlob);
  args.push("--", pattern, path);

  // Try ripgrep first; fall back to grep -rn if rg isn't installed
  let output = "";
  let exitCode = 0;
  let stderr = "";
  try {
    const proc = Bun.spawn(["rg", ...args], { stdout: "pipe", stderr: "pipe" });
    output = await new Response(proc.stdout).text();
    exitCode = await proc.exited;
    if (exitCode === 2) stderr = await new Response(proc.stderr).text();
  } catch {
    // rg not found — fall back to grep
    const gArgs = ["-rn"];
    if (ci) gArgs.push("-i");
    if (fileGlob) gArgs.push("--include", fileGlob);
    gArgs.push("--", pattern, path);
    const proc = Bun.spawn(["grep", ...gArgs], { stdout: "pipe", stderr: "pipe" });
    output = await new Response(proc.stdout).text();
    exitCode = await proc.exited;
  }

  // exit 1 = no matches (not an error); exit 2 = real error
  if (exitCode === 2) {
    return errorResult(`grep error: ${stderr.trim() || "unknown"}`);
  }
  if (!output.trim()) return { content: [text("(no matches)")] };

  const lines = output.trim().split("\n");
  if (lines.length > 200) {
    return {
      content: [text(`${lines.slice(0, 200).join("\n")}\n…(${lines.length - 200} more matches)`)],
      details: { count: lines.length },
    };
  }
  return { content: [text(lines.join("\n"))], details: { count: lines.length } };
}

export function grepTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents (uses ripgrep if available, falls back to grep). " +
      "Returns file:line:content matches. Respects .gitignore. Use 'glob' to filter file types. Max 200 results.",
    parameters,
    execute: (_id, params) => executeWithin(opts.workdir, params),
  };
}
