/**
 * M3.2: runCheck — the deterministic check-runner primitive everything in Stages 4–6 leans
 * on. Runs a shell command via Bun.spawn in its own process group with a minimal allowlisted
 * env (verify commands are LLM-authored — they never inherit harness secrets, and no check
 * may leave background processes behind, pass or fail). Captures combined stdout+stderr and
 * reports pass/fail plus how the run ended (clean exit, timeout, abort, or spawn failure).
 * Total: `runCheck` NEVER throws — every failure mode is a return value.
 *
 * Zero runtime dependencies by design (only type imports from ./gt_contract.ts), so the
 * check engine can be exercised in isolation from the rest of the harness.
 */
import type { Baseline, CheckResult } from "./gt_contract.ts";

export interface RunCheckOptions {
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
}

/** `runCheck()`'s full return shape — CheckResult plus how the process ended. */
export interface RunCheckResult extends CheckResult {
  /** null when the process never exited (timeout / spawn failure). */
  exitCode: number | null;
  timedOut: boolean;
  /** Bun.spawn threw before the process existed. */
  spawnError: string | null;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and the SIGKILL escalation for a timed-out/aborted check. */
export const KILL_GRACE_MS = 5_000;

/**
 * Per-stream retention cap. Every consumer of a check's output only ever needs pass/exit
 * plus a short trailing slice (the gate's 400-char tail, baselineFromResult none at all),
 * so a chatty or malicious check (`yes`) must not be able to balloon the harness to OOM by
 * writing gigabytes for up to the full timeout. The pipe is still drained to EOF (a blocked
 * pipe would wedge the child); only what is RETAINED is bounded — the newest bytes win.
 */
export const MAX_CHECK_OUTPUT_CHARS = 65_536;

/**
 * A stream drain that can be cancelled: on timeout/abort the pipe read must be released,
 * otherwise a lingering grandchild holding the pipe open pins the event loop indefinitely.
 * Retention is capped at MAX_CHECK_OUTPUT_CHARS (keeping the tail — that is the slice
 * callers report); reading always continues to EOF so the child never blocks on the pipe.
 */
function streamDrain(stream: ReadableStream<Uint8Array> | null): {
  promise: Promise<string>;
  cancel: () => void;
} {
  if (!stream) return { promise: Promise.resolve(""), cancel: () => {} };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const promise = (async () => {
    let out = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (out.length > MAX_CHECK_OUTPUT_CHARS) out = out.slice(-MAX_CHECK_OUTPUT_CHARS);
      }
    } catch {
      // cancelled mid-read — return what was captured so far
    }
    out += decoder.decode();
    return out;
  })();
  return {
    promise,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

/**
 * Timeout precedence: explicit option → MINIMA_TUI_CHECK_TIMEOUT env (SECONDS) →
 * DEFAULT_CHECK_TIMEOUT_MS. Read straight from process.env to keep this module dependency-free.
 * Deliberately independent of MINIMA_TIMEOUT — that is the HTTP routing timeout (config.ts),
 * and tuning routing latency must never rescale baseline/done-gate checks.
 * Exported so callers budgeting across several checks can cap each one at the same default.
 */
export function resolveCheckTimeoutMs(opts?: RunCheckOptions): number {
  if (opts?.timeoutMs !== undefined) return opts.timeoutMs;
  const env = process.env.MINIMA_TUI_CHECK_TIMEOUT;
  if (env) {
    const t = Number(env);
    if (Number.isFinite(t) && t > 0) return t * 1000;
  }
  return DEFAULT_CHECK_TIMEOUT_MS;
}

/**
 * Env names a check child may inherit (exact matches; the LC_ locale family passes by
 * prefix). Everything else — provider API keys, MUBIT_API_KEY, Bun-autoloaded .env
 * contents — is denied by default; MINIMA_TUI_CHECK_ENV is the per-project escape hatch.
 */
export const CHECK_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "TZ",
  "COLORTERM",
  "NODE_ENV",
  "VIRTUAL_ENV",
  "PYENV_ROOT",
  "NVM_DIR",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
] as const;

/**
 * Default-deny allowlisted env for check children: only CHECK_ENV_ALLOW names and LC_*
 * survive, plus any names listed in MINIMA_TUI_CHECK_ENV (comma-separated, whitespace
 * trimmed, empties ignored; values still sourced from `base`) for checks that legitimately
 * need more. A check broken by the narrower env fails visibly and fail-closed — never
 * silently through with a leaked secret.
 */
export function checkEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allowed = new Set<string>(CHECK_ENV_ALLOW);
  for (const name of (base.MINIMA_TUI_CHECK_ENV ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed) allowed.add(trimmed);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (allowed.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return env;
}

/**
 * M3.2: run a check command (`bash -c cmd`) and report the outcome. Never throws — a spawn
 * failure, timeout, or abort all come back as a RunCheckResult with `pass: false`. An
 * already-aborted signal short-circuits before the process is even spawned, and every exit
 * path clears its timer and abort listener so runCheck leaves nothing live behind.
 */
export async function runCheck(cmd: string, opts?: RunCheckOptions): Promise<RunCheckResult> {
  const timeoutMs = resolveCheckTimeoutMs(opts);
  const cwd = opts?.cwd ?? process.cwd();
  const signal = opts?.signal ?? null;
  const start = performance.now();

  if (signal?.aborted) {
    return {
      pass: false,
      output: "[aborted]",
      durationMs: performance.now() - start,
      exitCode: null,
      timedOut: false,
      spawnError: null,
    };
  }

  let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bash", "-c", cmd], {
      cwd,
      env: checkEnv(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: true,
    });
  } catch (exc) {
    return {
      pass: false,
      output: String(exc),
      durationMs: performance.now() - start,
      exitCode: null,
      timedOut: false,
      spawnError: String(exc),
    };
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : new Promise<"aborted">(() => {});

  const stdout = streamDrain(proc.stdout ?? null);
  const stderr = streamDrain(proc.stderr ?? null);

  let winner:
    | { kind: "done"; out: string; err: string }
    | { kind: "timeout" }
    | { kind: "aborted" };
  try {
    winner = await Promise.race([
      Promise.all([stdout.promise, stderr.promise, proc.exited]).then(([out, err]) => ({
        kind: "done" as const,
        out,
        err,
      })),
      timer.then((kind) => ({ kind })),
      aborted.then((kind) => ({ kind })),
    ]);
  } finally {
    // Whichever arm wins, drop the timer and abort listener so a finished check
    // neither keeps the event loop alive nor accumulates listeners on a shared signal.
    clearTimeout(timeoutTimer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  if (winner.kind === "timeout" || winner.kind === "aborted") {
    killProcessGroup(proc);
    stdout.cancel();
    stderr.cancel();
    const suffix = winner.kind === "timeout" ? `[timed out after ${timeoutMs} ms]` : "[aborted]";
    return {
      pass: false,
      output: suffix,
      durationMs: performance.now() - start,
      exitCode: null,
      timedOut: winner.kind === "timeout",
      spawnError: null,
    };
  }

  const exitCode = await proc.exited;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // group already empty — the harmless post-exit sweep
  }
  return {
    pass: exitCode === 0,
    output: `${winner.out}${winner.err}`,
    durationMs: performance.now() - start,
    exitCode,
    timedOut: false,
    spawnError: null,
  };
}

/**
 * Put a check's WHOLE process group down without pinning the parent: SIGTERM the group now
 * (falling back to the direct child if the group signal throws), then an unref'd timer
 * SIGKILLs the group after graceMs. The escalation is deliberately NOT cleared when the
 * leader exits — grandchildren can outlive it, and once every member is dead the late kill
 * is a harmless ESRCH. Requires the child to have been spawned with `detached: true` so its
 * pid is the process-group id.
 */
export function killProcessGroup(
  proc: Pick<import("bun").Subprocess, "pid" | "kill" | "unref">,
  graceMs = KILL_GRACE_MS,
): void {
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill();
    } catch {
      // already dead
    }
  }
  const hardKill = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // group already empty
    }
  }, graceMs);
  hardKill.unref();
  proc.unref();
}

/**
 * M3.2: fold a check run into the pre-work Baseline enum (plan_steps.baseline, M3.3).
 * spawnError/timeout → "unrunnable"; a clean pass → "green"; any other exit → "red".
 * Documented simplification: exit 127 ("command not found") maps to red, not unrunnable.
 */
export function baselineFromResult(r: RunCheckResult): Baseline {
  if (r.spawnError !== null || r.timedOut) return "unrunnable";
  return r.pass ? "green" : "red";
}

/**
 * Did the check end because the caller's AbortSignal fired (user abort), as opposed to
 * running to completion, timing out, or failing to spawn? The abort arm is the only path
 * that yields this shape (exitCode stays null, and neither timedOut nor spawnError is set).
 * Callers must treat an aborted run as NO EVIDENCE — never a red baseline or a failed gate.
 */
export function wasAborted(r: RunCheckResult): boolean {
  return r.exitCode === null && !r.timedOut && r.spawnError === null;
}
