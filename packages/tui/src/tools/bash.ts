/**
 * bash tool — port of the Python harness's tools/bash.py.
 *
 * Runs a shell command via Bun.spawn, streaming combined stdout+stderr. Honours a
 * millisecond timeout and an abort signal (both kill the process). Output is reported
 * live via the on_update callback.
 */

import { existsSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, type ToolUpdate, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { killProcessGroup } from "../minima/check.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { FsToolOptions } from "./types.ts";

const parameters = objectSchema(
  {
    command: { type: "string", description: "The shell command to run." },
    timeout: { type: "integer", description: "Max runtime in milliseconds.", default: 120_000 },
    workdir: { type: "string", description: "Working directory." },
  },
  ["command"],
);

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function execute(
  base: string | undefined,
  _id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: ToolUpdate | null,
): Promise<ToolResult> {
  const command = String(params.command);
  const timeoutMs = (params.timeout as number) ?? 120_000;
  // Factory base = the default cwd for this tool instance (per-sub-agent isolation);
  // a model-supplied workdir must stay within it when a base is set.
  let wd: string | undefined;
  if (params.workdir) {
    const r = resolveWithin(String(params.workdir), base);
    if (!r.ok) return errorResult(`bash: ${r.error}`);
    wd = r.path;
  } else {
    wd = base;
  }
  if (wd && !existsSync(wd)) return errorResult(`bash: workdir does not exist: ${wd}`);
  if (wd && !statSync(wd).isDirectory())
    return errorResult(`bash: workdir is not a directory: ${wd}`);

  let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bash", "-c", command], {
      cwd: wd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
    });
  } catch (exc) {
    return errorResult(`bash: failed to start: ${exc}`);
  }

  const timer = new Promise<"timeout">((resolve) => {
    const t = setTimeout(() => resolve("timeout"), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
      });
    }
  });

  const aborted = signal
    ? new Promise<"aborted">((resolve) =>
        signal.addEventListener("abort", () => resolve("aborted")),
      )
    : new Promise<"aborted">(() => {});

  const winner = await Promise.race([
    Promise.all([
      readStream(proc.stdout ?? null),
      readStream(proc.stderr ?? null),
      proc.exited,
    ]).then(([out, err]) => ({ kind: "done" as const, out, err })),
    timer.then((kind) => ({ kind })),
    aborted.then((kind) => ({ kind })),
  ]);

  if (winner.kind === "timeout" || winner.kind === "aborted") {
    // Kill the WHOLE process group: proc.kill() only signals the bash leader, so the
    // grandchildren of a timed-out command survived and ran unbounded (same bug the Big Plan
    // check runner had). Clean exits are untouched — deliberately started daemons live.
    killProcessGroup(proc);
    return errorResult(
      winner.kind === "timeout" ? `bash: timed out after ${timeoutMs} ms` : "bash: aborted",
    );
  }

  const output = `${winner.out}${winner.err}`;
  const code = await proc.exited;
  const body = output ? `${output}\n[exit ${code}]` : `[exit ${code}]`;
  if (onUpdate) {
    try {
      onUpdate(output);
    } catch {
      // progress must never break the run
    }
  }
  return { content: [text(body)], details: { exit_code: code } };
}

export function bashTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "bash",
    description:
      "Run a shell command and return combined stdout/stderr and exit code. " +
      "Prefer read/grep/glob over cat/sed/find. Use for running tests, builds, and git. " +
      "Avoid destructive commands (rm -rf, etc.) without explicit user intent.",
    parameters,
    execute: (id, params, signal, onUpdate) => execute(opts.workdir, id, params, signal, onUpdate),
  };
}
