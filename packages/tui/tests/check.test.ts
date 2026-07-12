import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_OUTPUT_CHARS,
  type RunCheckResult,
  baselineFromResult,
  checkEnv,
  resolveCheckTimeoutMs,
  runCheck,
  wasAborted,
} from "../src/minima/check.ts";

async function expectDead(pid: number, deadlineMs = 8000): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (performance.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      throw new Error(`process ${pid} is still alive`);
    }
    await Bun.sleep(25);
  }
}

describe("runCheck", () => {
  test("passing command: pass true, exit 0, green baseline", async () => {
    const r = await runCheck("true");
    expect(r.pass).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(baselineFromResult(r)).toBe("green");
  });

  test("failing command: pass false, real exit code, red baseline", async () => {
    const r = await runCheck("exit 3");
    expect(r.pass).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
    expect(baselineFromResult(r)).toBe("red");
  });

  test("captures stdout and stderr combined", async () => {
    const r = await runCheck("echo out; echo err >&2");
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  test("times out: kills the process, unrunnable baseline, returns fast", async () => {
    const start = performance.now();
    const r = await runCheck("sleep 5", { timeoutMs: 100 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeNull();
    expect(r.output).toContain("[timed out after 100 ms]");
    expect(baselineFromResult(r)).toBe("unrunnable");
  });

  test("honours cwd", async () => {
    const r = await runCheck("pwd", { cwd: "/tmp" });
    expect(r.pass).toBe(true);
    expect(r.output).toContain("tmp");
  });

  test("MINIMA_TUI_CHECK_TIMEOUT env (seconds) is used when no timeoutMs is given", async () => {
    const prev = process.env.MINIMA_TUI_CHECK_TIMEOUT;
    process.env.MINIMA_TUI_CHECK_TIMEOUT = "0.1";
    try {
      const start = performance.now();
      const r = await runCheck("sleep 5");
      expect(performance.now() - start).toBeLessThan(2000);
      expect(r.timedOut).toBe(true);
      expect(r.output).toContain("[timed out after 100 ms]");
    } finally {
      if (prev === undefined) delete process.env.MINIMA_TUI_CHECK_TIMEOUT;
      else process.env.MINIMA_TUI_CHECK_TIMEOUT = prev;
    }
  });

  test("opts.timeoutMs overrides MINIMA_TUI_CHECK_TIMEOUT env", async () => {
    const prev = process.env.MINIMA_TUI_CHECK_TIMEOUT;
    process.env.MINIMA_TUI_CHECK_TIMEOUT = "600";
    try {
      const r = await runCheck("sleep 5", { timeoutMs: 100 });
      expect(r.timedOut).toBe(true);
      expect(r.output).toContain("[timed out after 100 ms]");
    } finally {
      if (prev === undefined) delete process.env.MINIMA_TUI_CHECK_TIMEOUT;
      else process.env.MINIMA_TUI_CHECK_TIMEOUT = prev;
    }
  });

  test("MINIMA_TIMEOUT (the routing timeout) no longer affects the check cap", async () => {
    const prevRouting = process.env.MINIMA_TIMEOUT;
    const prevCheck = process.env.MINIMA_TUI_CHECK_TIMEOUT;
    process.env.MINIMA_TIMEOUT = "0.05";
    delete process.env.MINIMA_TUI_CHECK_TIMEOUT;
    try {
      expect(resolveCheckTimeoutMs()).toBe(DEFAULT_CHECK_TIMEOUT_MS);
      const r = await runCheck("sleep 0.2");
      expect(r.pass).toBe(true);
      expect(r.timedOut).toBe(false);
    } finally {
      if (prevRouting === undefined) delete process.env.MINIMA_TIMEOUT;
      else process.env.MINIMA_TIMEOUT = prevRouting;
      if (prevCheck === undefined) delete process.env.MINIMA_TUI_CHECK_TIMEOUT;
      else process.env.MINIMA_TUI_CHECK_TIMEOUT = prevCheck;
    }
  });

  test("default timeout constant is 120s", () => {
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(120_000);
  });

  test("already-aborted signal short-circuits: command never runs, aborted result", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = performance.now();
    const r = await runCheck("sleep 2; echo ran-anyway", { signal: ac.signal });
    expect(performance.now() - start).toBeLessThan(500);
    expect(r.pass).toBe(false);
    expect(r.output).toBe("[aborted]");
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
  });

  test("abort mid-run kills the check and reports aborted, not timed out", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const start = performance.now();
    const r = await runCheck("sleep 5", { signal: ac.signal, timeoutMs: 10_000 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.pass).toBe(false);
    expect(r.output).toBe("[aborted]");
    expect(r.timedOut).toBe(false);
  });

  test("abort listeners are removed on completion (no accumulation on a shared signal)", async () => {
    const ac = new AbortController();
    for (let i = 0; i < 3; i++) await runCheck("true", { signal: ac.signal });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  test("retained output is capped at the tail: a chatty check cannot balloon memory", async () => {
    // ~300 KB of stdout, well past the per-stream cap; the pipe is drained to EOF (the
    // command still exits 0) but only the newest MAX_CHECK_OUTPUT_CHARS survive.
    const r = await runCheck("head -c 300000 /dev/zero | tr '\\0' x; echo; echo END-MARKER");
    expect(r.pass).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(2 * MAX_CHECK_OUTPUT_CHARS + 1024);
    expect(r.output).toContain("END-MARKER"); // the tail — what callers report — is kept
    expect(r.output).not.toContain("\0");
  });
});

describe("runCheck process-group containment", () => {
  test("timeout kills the whole process group, grandchildren included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-check-"));
    const pidFile = join(dir, "gc.pid");
    try {
      const r = await runCheck(`sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; sleep 30`, {
        timeoutMs: 500,
      });
      expect(r.timedOut).toBe(true);
      const gcPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(gcPid).toBeGreaterThan(0);
      await expectDead(gcPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abort kills the whole process group, grandchildren included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-check-"));
    const pidFile = join(dir, "gc.pid");
    try {
      const ac = new AbortController();
      const pending = runCheck(`sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; sleep 30`, {
        signal: ac.signal,
        timeoutMs: 10_000,
      });
      let gcPid = 0;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        try {
          const n = Number(readFileSync(pidFile, "utf8").trim());
          if (n > 0) {
            gcPid = n;
            break;
          }
        } catch {
          // pidfile not written yet
        }
        await Bun.sleep(10);
      }
      expect(gcPid).toBeGreaterThan(0);
      ac.abort();
      const r = await pending;
      expect(wasAborted(r)).toBe(true);
      expect(r.output).toBe("[aborted]");
      await expectDead(gcPid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clean exit sweeps the process group: a passing check leaves no background survivor", async () => {
    const r = await runCheck("sleep 30 >/dev/null 2>&1 & echo $!");
    expect(r.pass).toBe(true);
    expect(r.exitCode).toBe(0);
    const gcPid = Number(r.output.trim());
    expect(gcPid).toBeGreaterThan(0);
    await expectDead(gcPid);
  });
});

describe("runCheck env sandbox", () => {
  test("check child cannot see harness secrets", async () => {
    process.env.MINIMA_TEST_LEAK = "s3cret";
    try {
      const r = await runCheck('echo "leak:${MINIMA_TEST_LEAK:-none}"');
      expect(r.pass).toBe(true);
      expect(r.output).toContain("leak:none");
      expect(r.output).not.toContain("s3cret");
    } finally {
      delete process.env.MINIMA_TEST_LEAK;
    }
  });

  test("check child keeps a working PATH", async () => {
    const r = await runCheck('test -n "$PATH" && command -v bash >/dev/null');
    expect(r.pass).toBe(true);
  });

  test("MINIMA_TUI_CHECK_ENV re-admits a named var into the check child", async () => {
    const prev = process.env.MINIMA_TUI_CHECK_ENV;
    process.env.MINIMA_TUI_CHECK_ENV = "MINIMA_TEST_KEEP";
    process.env.MINIMA_TEST_KEEP = "kept";
    try {
      const r = await runCheck('echo "keep:${MINIMA_TEST_KEEP:-none}"');
      expect(r.pass).toBe(true);
      expect(r.output).toContain("keep:kept");
    } finally {
      if (prev === undefined) delete process.env.MINIMA_TUI_CHECK_ENV;
      else process.env.MINIMA_TUI_CHECK_ENV = prev;
      delete process.env.MINIMA_TEST_KEEP;
    }
  });
});

describe("checkEnv", () => {
  test("default-denies unlisted vars, keeps the core allowlist and the LC_ prefix", () => {
    const env = checkEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      FAKE_API_KEY: "k",
      MUBIT_API_KEY: "m",
      SOME_TOKEN: "t",
      DATABASE_URL: "postgres://x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LC_ALL: "C", LC_CTYPE: "UTF-8" });
  });

  test("drops undefined values", () => {
    expect(checkEnv({ PATH: undefined, HOME: "/h" })).toEqual({ HOME: "/h" });
  });

  test("MINIMA_TUI_CHECK_ENV adds names, trimming whitespace and ignoring empties", () => {
    const env = checkEnv({
      PATH: "/x",
      MINIMA_TUI_CHECK_ENV: " KEEP_ME , ,ALSO_KEEP,,",
      KEEP_ME: "1",
      ALSO_KEEP: "2",
      DROPPED: "3",
    });
    expect(env).toEqual({ PATH: "/x", KEEP_ME: "1", ALSO_KEEP: "2" });
  });

  test("defaults to process.env", () => {
    expect(checkEnv().PATH).toBe(process.env.PATH as string);
  });
});

describe("baselineFromResult", () => {
  const base: RunCheckResult = {
    pass: false,
    output: "",
    durationMs: 1,
    exitCode: 1,
    timedOut: false,
    spawnError: null,
  };

  test("mapping table", () => {
    expect(baselineFromResult({ ...base, pass: true, exitCode: 0 })).toBe("green");
    expect(baselineFromResult({ ...base, exitCode: 1 })).toBe("red");
    // documented simplification: exit 127 (command not found) is red, not unrunnable
    expect(baselineFromResult({ ...base, exitCode: 127 })).toBe("red");
    expect(baselineFromResult({ ...base, exitCode: null, timedOut: true })).toBe("unrunnable");
    expect(baselineFromResult({ ...base, exitCode: null, spawnError: "boom" })).toBe("unrunnable");
    // spawnError/timedOut win even over a nominal pass
    expect(baselineFromResult({ ...base, pass: true, exitCode: 0, timedOut: true })).toBe(
      "unrunnable",
    );
  });
});

describe("wasAborted", () => {
  const base: RunCheckResult = {
    pass: false,
    output: "",
    durationMs: 1,
    exitCode: 1,
    timedOut: false,
    spawnError: null,
  };

  test("only the abort shape qualifies — never timeout, spawn failure, or a real exit", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(wasAborted(await runCheck("true", { signal: ac.signal }))).toBe(true);
    expect(wasAborted({ ...base, exitCode: null })).toBe(true);
    expect(wasAborted({ ...base, exitCode: null, timedOut: true })).toBe(false);
    expect(wasAborted({ ...base, exitCode: null, spawnError: "boom" })).toBe(false);
    expect(wasAborted({ ...base, exitCode: 1 })).toBe(false);
    expect(wasAborted({ ...base, pass: true, exitCode: 0 })).toBe(false);
  });
});
