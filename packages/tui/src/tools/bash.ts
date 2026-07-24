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
import type { BgJobRegistry } from "./_bgjobs.ts";
import { BoundedBuffer, boundDetails } from "./_bounds.ts";
import { resolveWithin } from "./_io.ts";
import { objectSchema } from "./schema.ts";
import type { ArtifactStream, FsToolOptions, ToolArtifacts } from "./types.ts";

const BASE_PROPS = {
  command: { type: "string" as const, description: "The shell command to run." },
  timeout: {
    type: "integer" as const,
    description: "Max runtime in milliseconds.",
    default: 120_000,
  },
  workdir: { type: "string" as const, description: "Working directory." },
};

// Registry-less (feature off): today's exact schema, byte-identical.
const parameters = objectSchema(BASE_PROPS, ["command"]);

// Registry-wired (W4.1): the same schema plus an additive `background` flag.
const bgParameters = objectSchema(
  {
    ...BASE_PROPS,
    background: {
      type: "boolean" as const,
      description:
        "Run detached and return a job handle immediately instead of waiting for exit; " +
        "manage it with the bgjob tool (status/wait/output/kill). timeout is ignored when true.",
      default: false,
    },
  },
  ["command"],
);

const BASH_DESCRIPTION =
  "Run a shell command and return combined stdout/stderr and exit code. " +
  "Prefer read/grep/glob over cat/sed/find. Use for running tests, builds, and git. " +
  "Avoid destructive commands (rm -rf, etc.) without explicit user intent.";

const BASH_BG_DESCRIPTION = `${BASH_DESCRIPTION} Set background:true to start a long-running command detached and get a job handle back immediately (poll/kill it with the bgjob tool).`;

const UPDATE_THROTTLE_MS = 250;

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  buffer: BoundedBuffer,
  emit: () => void,
  tee?: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buffer.push(chunk);
    tee?.(chunk);
    emit();
  }
  const rest = decoder.decode();
  if (rest) {
    buffer.push(rest);
    tee?.(rest);
  }
}

async function commitStream(s: ArtifactStream): Promise<{ ref: string } | null> {
  try {
    return await s.commit();
  } catch {
    return null; // spill is best-effort; the command result never depends on it
  }
}

async function discardStream(s: ArtifactStream): Promise<void> {
  try {
    await s.discard();
  } catch {
    // spill is best-effort; the command result never depends on it
  }
}

async function execute(
  base: string | undefined,
  artifacts: ToolArtifacts | undefined,
  bgJobs: BgJobRegistry | undefined,
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

  // W4.1: hand a backgrounded command to the registry, which spawns it detached and
  // returns a job handle in <1s. The composed per-call signal already reaches here, so
  // the registry's abort listener kills the job's group on Esc during this run.
  if (bgJobs && params.background === true) {
    return bgJobs.launch({ command, cwd: wd, signal, artifacts });
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
  // Tee for the artifact spill (P1): the buffer discards the middle while streaming, so
  // the full output only exists as the teed file. A tee failure disables the spill for
  // this call; the command result never depends on it.
  let artifactStream = artifacts?.beginStream("bash") ?? null;
  const tee = artifactStream
    ? (chunk: string) => {
        if (!artifactStream) return;
        try {
          artifactStream.write(chunk);
        } catch {
          const dead = artifactStream;
          artifactStream = null;
          void discardStream(dead);
        }
      }
    : undefined;
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
      pumpStream(proc.stdout ?? null, buffer, emit, tee),
      pumpStream(proc.stderr ?? null, buffer, emit, tee),
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
    const b = buffer.finish();
    let ref: string | null = null;
    const stream = artifactStream;
    artifactStream = null;
    if (stream) {
      if (b.truncated) ref = (await commitStream(stream))?.ref ?? null;
      else await discardStream(stream);
    }
    const partial = `${prefix}\n--- partial output ---\n${b.body}`;
    const res = errorResult(ref ? `${partial}\n[full output saved: ${ref}]` : partial);
    if (ref) res.details = { ...res.details, spill_ref: ref };
    return res;
  }

  const code = await proc.exited;
  // Trailing flush: the throttle above is leading-edge only, so output arriving in the
  // last window would otherwise never reach a live view before the result lands.
  if (onUpdate) {
    try {
      onUpdate(buffer.snapshot());
    } catch {
      // progress must never break the run
    }
  }
  const b = buffer.finish();
  let body = b.body ? `${b.body}\n[exit ${code}]` : `[exit ${code}]`;
  const details: Record<string, unknown> = { exit_code: code, ...boundDetails(b) };
  const stream = artifactStream;
  artifactStream = null;
  if (stream) {
    if (b.truncated) {
      const committed = await commitStream(stream);
      if (committed) {
        body += `\n[full output saved: ${committed.ref}]`;
        details.spill_ref = committed.ref;
      }
    } else {
      await discardStream(stream);
    }
  }
  return { content: [text(body)], details };
}

export function bashTool(opts: FsToolOptions = {}): AgentTool {
  return {
    name: "bash",
    description: opts.bgJobs ? BASH_BG_DESCRIPTION : BASH_DESCRIPTION,
    parameters: opts.bgJobs ? bgParameters : parameters,
    execute: (id, params, signal, onUpdate) =>
      execute(opts.workdir, opts.artifacts, opts.bgJobs, id, params, signal, onUpdate),
  };
}
