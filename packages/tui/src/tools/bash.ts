/**
 * bash tool — port of the Python harness's tools/bash.py.
 *
 * Runs a shell command via Bun.spawn. stdout and stderr are pushed into one shared
 * BoundedBuffer as chunks arrive (head+tail capped at 50k chars), so the two streams
 * interleave close to real time. Progress is reported live via on_update (throttled to
 * one call per >=250ms). Honours a millisecond timeout and an abort signal (both kill
 * the process group); timeout/abort results carry the partial output captured so far.
 */

import { stat } from "node:fs/promises";
import { type AgentTool, type ToolResult, type ToolUpdate, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { killProcessGroup } from "../minima/check.ts";
import { BoundedBuffer, boundDetails } from "./_bounds.ts";
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

const UPDATE_THROTTLE_MS = 250;

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  buffer: BoundedBuffer,
  emit: () => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.push(decoder.decode(value, { stream: true }));
    emit();
  }
  const rest = decoder.decode();
  if (rest) buffer.push(rest);
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
  if (wd) {
    try {
      const st = await stat(wd);
      if (!st.isDirectory()) return errorResult(`bash: workdir is not a directory: ${wd}`);
    } catch {
      return errorResult(`bash: workdir does not exist: ${wd}`);
    }
  }

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

  const buffer = new BoundedBuffer({ maxChars: 50_000, headChars: 10_000 });
  let lastUpdate = 0;
  const emit = () => {
    if (!onUpdate) return;
    const now = Date.now();
    if (now - lastUpdate < UPDATE_THROTTLE_MS) return;
    lastUpdate = now;
    try {
      onUpdate(buffer.snapshot());
    } catch {
      // progress must never break the run
    }
  };

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
      pumpStream(proc.stdout ?? null, buffer, emit),
      pumpStream(proc.stderr ?? null, buffer, emit),
      proc.exited,
    ]).then(() => ({ kind: "done" as const })),
    timer.then((kind) => ({ kind })),
    aborted.then((kind) => ({ kind })),
  ]);

  if (winner.kind === "timeout" || winner.kind === "aborted") {
    // Kill the WHOLE process group: proc.kill() only signals the bash leader, so the
    // grandchildren of a timed-out command survived and ran unbounded (same bug the plan
    // check runner had). Clean exits are untouched — deliberately started daemons live.
    killProcessGroup(proc);
    const prefix =
      winner.kind === "timeout" ? `bash: timed out after ${timeoutMs} ms` : "bash: aborted";
    return errorResult(`${prefix}\n--- partial output ---\n${buffer.snapshot()}`);
  }

  const code = await proc.exited;
  const b = buffer.finish();
  const body = b.body ? `${b.body}\n[exit ${code}]` : `[exit ${code}]`;
  return { content: [text(body)], details: { exit_code: code, ...boundDetails(b) } };
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
