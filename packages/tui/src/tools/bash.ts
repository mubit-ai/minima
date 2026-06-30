/**
 * bash tool — port of minima_harness/tools/bash.py.
 *
 * Runs a shell command via Bun.spawn, streaming combined stdout+stderr. Honours a
 * millisecond timeout and an abort signal (both kill the process). Output is reported
 * live via the on_update callback.
 */

import { existsSync, statSync } from "node:fs";
import { type AgentTool, type ToolResult, type ToolUpdate, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { expand } from "./_io.ts";
import { objectSchema } from "./schema.ts";

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
  _id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: ToolUpdate | null,
): Promise<ToolResult> {
  const command = String(params.command);
  const timeoutMs = (params.timeout as number) ?? 120_000;
  const wd = params.workdir ? expand(String(params.workdir)) : undefined;
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
    try {
      proc.kill();
    } catch {
      // already dead
    }
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

export function bashTool(): AgentTool {
  return {
    name: "bash",
    description:
      "Run a shell command and return its combined stdout/stderr and exit code. Output streams live. Runs with the user's full permissions.",
    parameters,
    execute,
  };
}
