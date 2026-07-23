import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { boundDetails, boundText } from "./_bounds.ts";
import { resolveWithin, truncateLine } from "./_io.ts";
import { resolveRg } from "./_rg.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions, ToolArtifacts } from "./types.ts";

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

const MAX_MATCHES = 200;
const MAX_CHARS = 50_000;

export interface GrepArgsInput {
  pattern: string;
  path: string;
  glob?: string;
  caseInsensitive: boolean;
}

export function buildRgArgs(p: GrepArgsInput): string[] {
  const args = ["-n", "--no-heading", "--color=never", "--sort", "path"];
  if (p.caseInsensitive) args.push("-i");
  if (p.glob) args.push("-g", p.glob);
  args.push("--", p.pattern, p.path);
  return args;
}

export function buildGrepArgs(p: GrepArgsInput): string[] {
  const args = ["-rnsI", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (p.caseInsensitive) args.push("-i");
  if (p.glob) args.push("--include", p.glob);
  args.push("--", p.pattern, p.path);
  return args;
}

async function executeWithin(
  workdir: string | undefined,
  rgCmd: string | null | undefined,
  artifacts: ToolArtifacts | undefined,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const r = resolveWithin(String(params.path ?? "."), workdir);
  if (!r.ok) return errorResult(`grep: ${r.error}`);
  const input: GrepArgsInput = {
    pattern: String(params.pattern ?? ""),
    path: r.path,
    glob: params.glob ? String(params.glob) : undefined,
    caseInsensitive: Boolean(params.case_insensitive),
  };
  const rg = resolveRg(rgCmd);
  const cmd = rg ? [rg, ...buildRgArgs(input)] : ["grep", ...buildGrepArgs(input)];

  let output = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } catch (exc) {
    return errorResult(`grep error: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  if (exitCode === 2 && !output.trim()) {
    return errorResult(`grep error: ${stderr.trim() || "unknown"}`);
  }
  if (!output.trim()) return { content: [text("(no matches)")] };

  const lines = output.trim().split("\n").map(truncateLine);
  const b = boundText(lines.join("\n"), {
    maxLines: MAX_MATCHES,
    maxChars: MAX_CHARS,
    unit: "matches",
    spill: artifacts?.sink("grep") ?? null,
  });
  let body = b.body;
  if (b.notice) body += `\n${b.notice}`;
  if (exitCode === 2) body += "\n[note: some paths could not be searched]";
  return {
    content: [text(body)],
    details: { count: b.totalLines, ...boundDetails(b) },
  };
}

export function grepTool(opts: FsToolOptions & { rgCmd?: string | null } = {}): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents (ripgrep if available, else grep). Returns file:line:content matches. " +
      ".gitignore respected when ripgrep is available. Use 'glob' to filter file types. " +
      "Max 200 matches shown.",
    parameters,
    execute: (_id, params) => executeWithin(opts.workdir, opts.rgCmd, opts.artifacts, params),
  };
}
