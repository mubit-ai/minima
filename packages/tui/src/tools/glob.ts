import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { boundDetails, boundText } from "./_bounds.ts";
import { resolveWithin } from "./_io.ts";
import { resolveRg } from "./_rg.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/*.py)." },
    path: { type: "string", description: "Base directory to search from.", default: "." },
    include_ignored: {
      type: "boolean",
      description: "Include files ignored by .gitignore (and node_modules).",
      default: false,
    },
  },
  ["pattern"],
);

const MAX_SHOWN = 200;
const SCAN_CEILING = 10_000;
const EXCLUDED_SEGMENT = /(^|\/)(node_modules|\.git)\//;

// null = rg failed (exit code other than 0/1) — the caller falls back to the scan engine
// instead of presenting an IO error as "(no matches)".
async function listWithRg(rg: string, cwd: string, pattern: string): Promise<string[] | null> {
  const glob = new Bun.Glob(pattern);
  // --no-config: same RIPGREP_CONFIG_PATH --pre hardening as grep's buildRgArgs.
  const proc = Bun.spawn([rg, "--no-config", "--files"], { cwd, stdout: "pipe", stderr: "ignore" });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0 && exitCode !== 1) return null;
  const matches: string[] = [];
  for (const line of output.split("\n")) {
    if (!line || !glob.match(line) || EXCLUDED_SEGMENT.test(line)) continue;
    matches.push(line);
    if (matches.length >= SCAN_CEILING) break;
  }
  return matches;
}

async function listWithScan(
  cwd: string,
  pattern: string,
  includeIgnored: boolean,
): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const p of glob.scan({
    cwd,
    dot: includeIgnored,
    followSymlinks: false,
    throwErrorOnBrokenSymlink: false,
    onlyFiles: true,
  })) {
    if (!includeIgnored && EXCLUDED_SEGMENT.test(p)) continue;
    matches.push(p);
    if (matches.length >= SCAN_CEILING) break;
  }
  return matches;
}

async function executeWithin(
  workdir: string | undefined,
  rgCmd: string | null | undefined,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  // Both engines get the same normalized pattern — rg emits bare relative paths, and the
  // engines must not diverge on "./"-prefixed input depending on whether rg is installed.
  const pattern = String(params.pattern ?? "").replace(/^(\.\/)+/, "");
  const includeIgnored = Boolean(params.include_ignored);
  const r = resolveWithin(String(params.path ?? "."), workdir);
  if (!r.ok) return errorResult(`glob: ${r.error}`);
  const rg = includeIgnored ? null : resolveRg(rgCmd);
  let matches: string[];
  let filtered = false;
  try {
    const viaRg = rg ? await listWithRg(rg, r.path, pattern) : null;
    if (viaRg !== null) {
      matches = viaRg;
      filtered = true;
    } else {
      matches = await listWithScan(r.path, pattern, includeIgnored);
    }
  } catch (exc) {
    return errorResult(`glob error: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  if (!matches.length) {
    return {
      content: [
        text(
          filtered
            ? "(no matches — note: .gitignore'd files are excluded; set include_ignored=true to search them)"
            : "(no matches)",
        ),
      ],
    };
  }
  const totalIsLowerBound = matches.length >= SCAN_CEILING;
  matches.sort();
  const b = boundText(matches.join("\n"), {
    maxLines: MAX_SHOWN,
    unit: "matches",
    totalIsLowerBound,
  });
  let body = b.body;
  if (b.notice) body += `\n${b.notice}`;
  // The exclusion must be visible on the partial-match path too — a non-empty result
  // missing a gitignored file otherwise reads as "that file does not exist".
  if (filtered) {
    body +=
      "\n[note: .gitignore'd files and node_modules/ excluded; include_ignored=true includes them]";
  }
  return { content: [text(body)], details: { count: b.totalLines, ...boundDetails(b) } };
}

export function globTool(opts: FsToolOptions & { rgCmd?: string | null } = {}): AgentTool {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern (e.g. **/*.ts, src/**/test_*.py). " +
      "Hidden files excluded; .gitignore'd files (plus node_modules/ and .git/) are " +
      "excluded when ripgrep is available, unless include_ignored=true. " +
      "Max 200 results shown. Use grep for content search.",
    parameters,
    execute: (_id, params) => executeWithin(opts.workdir, opts.rgCmd, params),
  };
}
