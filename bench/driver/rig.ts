/**
 * PTY rig — drives the installed Minima TUI in a real pseudo-terminal.
 *
 * Uses Bun's native PTY spawn option (Bun >= 1.3.5): no node-pty. The data callback
 * signature is (Terminal, Buffer); input goes through proc.terminal.write().
 *
 * Semantics follow gemini-cli's TestRig: accumulate all output, strip ANSI, and poll
 * for regex appearance with hard timeouts — never bare sleeps against agent output.
 * The TUI renders on the alternate screen buffer with heavy repaints, so the stripped
 * accumulation contains duplicates; assertions are "did X appear (since mark)".
 */

export interface RigOptions {
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  /** Hard wall-clock cap; the run is SIGKILLed past this (abort keys are dead code in 0.7.1). */
  wallClockMs?: number;
}

export class AbortError extends Error {}

const ANSI_RE = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC (title set etc.)
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g, // CSI
  /\x1b[()][0-9A-Za-z]/g, // charset select
  /\x1b[=>]/g, // keypad modes
  /\x1b[78]/g, // save/restore cursor
];

export function stripAnsi(s: string): string {
  let out = s;
  for (const re of ANSI_RE) out = out.replace(re, "");
  return out.replace(/\r/g, "");
}

export class PtyRig {
  private proc: ReturnType<typeof Bun.spawn>;
  private raw = "";
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  aborted = false;

  private constructor(proc: ReturnType<typeof Bun.spawn>, wallClockMs: number) {
    this.proc = proc;
    this.killTimer = setTimeout(() => {
      this.aborted = true;
      try {
        proc.kill(9);
      } catch {}
    }, wallClockMs);
  }

  static spawn(opts: RigOptions): PtyRig {
    let rig: PtyRig;
    const proc = Bun.spawn(opts.cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
      terminal: {
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 32,
        data(_term: unknown, chunk: Uint8Array) {
          rig.raw += Buffer.from(chunk).toString("utf8");
        },
      },
    } as Parameters<typeof Bun.spawn>[1]);
    rig = new PtyRig(proc, opts.wallClockMs ?? 300_000);
    return rig;
  }

  /** Full ANSI-stripped output so far. */
  text(): string {
    return stripAnsi(this.raw);
  }

  get exitCode(): number | null {
    return this.proc.exitCode;
  }

  /** Raw output (with escape sequences) — for debugging and future screen emulation. */
  rawText(): string {
    return this.raw;
  }

  /** Position marker: expect*(…, {since}) searches only output after the marker. */
  mark(): number {
    return this.text().length;
  }

  /** Wait until `pattern` appears in the (stripped) output, polling every `pollMs`. */
  async expectText(
    pattern: RegExp | string,
    opts: { timeoutMs?: number; since?: number; pollMs?: number } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 150;
    const re =
      typeof pattern === "string"
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        : pattern;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const t = this.text().slice(opts.since ?? 0);
      const m = t.match(re);
      if (m) return m[0];
      if (this.proc.killed || this.proc.exitCode !== null) {
        // Give late PTY chunks a beat, then re-check once before declaring death.
        await Bun.sleep(200);
        const t2 = this.text().slice(opts.since ?? 0);
        const m2 = t2.match(re);
        if (m2) return m2[0];
        throw new AbortError(
          `process exited (code=${this.proc.exitCode}) before ${re} appeared; tail:\n${t2.slice(-2000)}`,
        );
      }
      await Bun.sleep(pollMs);
    }
    throw new AbortError(`timeout ${timeoutMs}ms waiting for ${re}; tail:\n${this.text().slice(-2000)}`);
  }

  /** Type text into the TUI without submitting (small per-chunk pacing, avoids paste heuristics). */
  async type(s: string): Promise<void> {
    for (const ch of s) {
      this.write(ch);
      await Bun.sleep(8);
    }
  }

  /**
   * Type a prompt or slash command and press Enter. Verifies the tail of the text was
   * echoed before submitting (protects against dropped keystrokes), and pauses >=60ms
   * pre-Enter (the ICRNL-fix guard window from commit cd17216).
   */
  async submit(s: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const since = this.mark();
    await this.type(s);
    const tail = s.slice(-Math.min(s.length, 24));
    await this.expectText(tail, { since, timeoutMs: opts.timeoutMs ?? 10_000 });
    await Bun.sleep(60);
    this.write("\r");
  }

  write(s: string): void {
    (this.proc as unknown as { terminal: { write(d: string): void } }).terminal.write(s);
  }

  /**
   * Type a command/prompt once, then press Enter — RETRYING Enter until the expected
   * effect is observed. The TUI silently drops Enter while busy (the post-turn
   * judge/feedback/memory tail keeps `busy` true past the visible turn end — same
   * guard as the known abort bug), while typed characters still echo; without this,
   * consecutive commands concatenate in the input box and never run.
   *
   * A retried Enter is harmless: if the previous one submitted, the input is empty.
   * `until` is either a fresh-output regex (searched since just before the first
   * Enter) or an async predicate (e.g. a DB row appearing).
   */
  async submitUntil(
    s: string,
    until: RegExp | (() => boolean | Promise<boolean>),
    opts: { timeoutMs?: number; retryMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const retryMs = opts.retryMs ?? 3_000;
    const m0 = this.mark();
    await this.type(s);
    const tail = s.slice(-Math.min(s.length, 24));
    await this.expectText(tail, { since: m0, timeoutMs: 10_000 });
    await Bun.sleep(60);
    const mResp = this.mark();
    const satisfied = async (): Promise<boolean> => {
      if (until instanceof RegExp) return until.test(this.text().slice(mResp));
      return !!(await until());
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.write("\r");
      const attemptDeadline = Math.min(Date.now() + retryMs, deadline);
      while (Date.now() < attemptDeadline) {
        if (await satisfied()) return;
        if (this.proc.exitCode !== null) {
          if (await satisfied()) return;
          throw new AbortError(`process exited waiting for effect of ${JSON.stringify(s)}`);
        }
        await Bun.sleep(150);
      }
    }
    throw new AbortError(
      `submitUntil timeout (${timeoutMs}ms) for ${JSON.stringify(s)}; tail:\n${this.text().slice(-1500)}`,
    );
  }

  sendKey(key: "enter" | "esc" | "ctrl-c" | "ctrl-l" | "tab" | "up" | "down"): void {
    const seq: Record<string, string> = {
      enter: "\r",
      esc: "\x1b",
      "ctrl-c": "\x03",
      "ctrl-l": "\x0c",
      tab: "\t",
      up: "\x1b[A",
      down: "\x1b[B",
    };
    this.write(seq[key]!);
  }

  /** Wait for clean exit; SIGKILL + AbortError past the timeout. */
  async expectExit(timeoutMs = 20_000): Promise<number> {
    const result = await Promise.race([
      this.proc.exited,
      Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (result === "timeout") {
      this.aborted = true;
      try {
        this.proc.kill(9);
      } catch {}
      await this.proc.exited;
      throw new AbortError(`process did not exit within ${timeoutMs}ms (SIGKILLed)`);
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    return result as number;
  }

  /** Force-kill (cleanup path). */
  kill(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    try {
      this.proc.kill(9);
    } catch {}
  }
}
