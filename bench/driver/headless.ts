/** One-shot runner for headless minima invocations (--print / --mode json / usage errors). */

export interface HeadlessResult {
  exitCode: number | null; // null = wall-clock SIGKILL (ABORT)
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runHeadless(opts: {
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  bin?: string;
}): Promise<HeadlessResult> {
  const started = Date.now();
  const proc = Bun.spawn([opts.bin ?? "minima", ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill(9);
    } catch {}
  }, opts.timeoutMs ?? 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    exitCode: killed ? null : exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
  };
}

/** Parse a --mode json stdout stream into event dicts (throws on non-JSON lines). */
export function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
