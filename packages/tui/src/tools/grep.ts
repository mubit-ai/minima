import { resolve } from "node:path";
import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { boundDetails, boundText } from "./_bounds.ts";
import { resolveWithin, truncateLine } from "./_io.ts";
import { resolveRg } from "./_rg.ts";
import { type SeenLedger, type SeenRange, coalesce, hashFile, sha256Hex } from "./_seen.ts";
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
const SNAP_MAX_FILES = 50;

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

/** Hash + record every file behind the SHOWN matches; the aggregate snap tag is the only
 * projection (per-file hashes live in the ledger). Unparseable lines, over-cap or
 * unhashable files are silently skipped; any ledger error suppresses the tag entirely. */
async function snapShownMatches(seen: SeenLedger, shown: string): Promise<string | null> {
  const perFile = new Map<string, SeenRange[]>();
  for (const line of shown.split("\n")) {
    const m = /^(.+?):(\d+):/.exec(line);
    if (!m) continue;
    const file = resolve(m[1]!);
    const ln = Number(m[2]);
    if (!Number.isInteger(ln) || ln < 1) continue;
    let ranges = perFile.get(file);
    if (!ranges) {
      if (perFile.size >= SNAP_MAX_FILES) continue;
      ranges = [];
      perFile.set(file, ranges);
    }
    ranges.push({ start: ln, end: ln });
  }
  const hashed: string[] = [];
  for (const [file, ranges] of perFile) {
    const hash = await hashFile(file);
    if (!hash) continue;
    if (!seen.record(file, hash, coalesce(ranges), "grep")) return null;
    hashed.push(`${file}:${hash}\n`);
  }
  if (hashed.length === 0) return null;
  const agg = sha256Hex(hashed.sort().join(""));
  return `[snap:${agg.slice(0, 8)} ${hashed.length} files]`;
}

async function executeWithin(
  workdir: string | undefined,
  rgCmd: string | null | undefined,
  artifacts: ToolArtifacts | undefined,
  seen: SeenLedger | undefined,
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
  if (seen?.enabled) {
    const tag = await snapShownMatches(seen, b.body);
    if (tag) body += `\n${tag}`;
  }
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
    execute: (_id, params) =>
      executeWithin(opts.workdir, opts.rgCmd, opts.artifacts, opts.seen, params),
  };
}
