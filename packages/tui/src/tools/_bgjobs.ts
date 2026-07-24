/**
 * Background bash jobs (W4.1) — the BgJobRegistry.
 *
 * A `bash background:true` call spawns the command detached (exactly like the foreground
 * path — Bun.spawn(["bash","-c",cmd], {detached:true})) but returns a job handle in <1s
 * instead of awaiting exit. Live Subprocess handles, a per-job BoundedBuffer (head+tail
 * capped, same as bash) and the P1 artifact tee live in-memory here; a durable bg_jobs
 * row (v22) is the record that survives restart. The `bgjob` tool (status/wait/output/
 * kill/list) drives the read/control surface.
 *
 * Every DB write is fail-open (the recordArtifact stance): bookkeeping trouble never
 * affects a job. The raw-SQL seam mirrors ArtifactSql so this module never imports
 * MinimaDb, and the process probes are injectable so the startup reaper is hermetically
 * testable.
 */

import { type ToolResult, errorResult } from "../agent/tools.ts";
import { text } from "../ai/types.ts";
import { killProcessGroup } from "../minima/check.ts";
import { BoundedBuffer } from "./_bounds.ts";
import type { ArtifactStream, ToolArtifacts } from "./types.ts";

/** Terminal states never regress to `running` (guarded UPDATE WHERE state='running'). */
export type BgJobState = "running" | "exited" | "killed" | "orphaned" | "lost";

/** The durable bg_jobs row (v22). Live output + handles are in-memory only. */
export interface BgJobRow {
  id: string;
  run_id: string;
  agent_id: string | null;
  pid: number | null;
  pgid: number | null;
  harness_pid: number | null;
  command: string;
  cwd: string | null;
  state: BgJobState;
  exit_code: number | null;
  output_chars: number | null;
  truncated: number | null;
  spill_ref: string | null;
  started: number;
  ended: number | null;
  updated: number;
}

/** Structural raw-SQL seam (mirrors ArtifactSql) — satisfied by MinimaDb's public `db`
 * handle without importing MinimaDb. Absent = fail-open: every DB path stays inert. */
export interface BgJobSql {
  run(sql: string, params: unknown[]): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Injectable process probes — real syscalls in prod, deterministic fakes in the reap
 * tests. `processAlive(pid)` also serves group liveness via a negative pid. */
export interface BgJobProbes {
  processAlive(pid: number): boolean;
  commandOf(pid: number): string | null;
  harnessPid: number;
}

export interface BgJobLaunchOptions {
  command: string;
  cwd: string | undefined;
  signal: AbortSignal | null;
  artifacts?: ToolArtifacts;
}

interface BgJobEntry {
  id: string;
  proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  buffer: BoundedBuffer;
  pgid: number;
  command: string;
  state: BgJobState;
  exitCode: number | null;
  spillRef: string | null;
  exited: Promise<void>;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
  finalized: boolean;
}

const MAX_RUNNING = 16;
const KILL_SETTLE_MS = 6_000;
const BOUND_OPTS = { maxChars: 50_000, headChars: 10_000 };

function nowSec(): number {
  return Date.now() / 1000;
}

function newJobId(): string {
  return `bg_${crypto.randomUUID().slice(0, 8)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  buffer: BoundedBuffer,
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
  }
  const rest = decoder.decode();
  if (rest) {
    buffer.push(rest);
    tee?.(rest);
  }
}

/** True orphan vs PID reuse: the live pid's command must still resemble what we recorded.
 * Containment either direction absorbs `ps` truncation and the `bash -c` argv wrapper; a
 * false negative only downgrades to `lost` (no signal), which is the safe direction. */
function commandMatches(live: string, recorded: string): boolean {
  const a = live.trim();
  const b = recorded.trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function defaultProbes(): BgJobProbes {
  return {
    processAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    commandOf(pid: number): string | null {
      try {
        const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
        if (!r.success) return null;
        const out = new TextDecoder().decode(r.stdout).trim();
        return out || null;
      } catch {
        return null;
      }
    },
    harnessPid: process.pid,
  };
}

export class BgJobRegistry {
  private readonly entries = new Map<string, BgJobEntry>();
  private readonly probes: BgJobProbes;
  private sql: BgJobSql | null = null;
  private runId: string | null = null;

  constructor(opts: { probes?: BgJobProbes } = {}) {
    this.probes = opts.probes ?? defaultProbes();
  }

  /** Late-bind the durable store (MinimaDb's public `db`) + the current run, then run the
   * startup reaper over crash leftovers. Mirrors ArtifactStore.attach. */
  attach(index: { db?: BgJobSql }, runId: string): void {
    this.sql = index.db ?? null;
    this.runId = runId;
    this.reapOrphans();
  }

  /** Launch a detached background job and return its handle (<1s). */
  launch(opts: BgJobLaunchOptions): ToolResult {
    const running = this.runningCount();
    if (running >= MAX_RUNNING) {
      return errorResult(
        `bash: too many background jobs (${running} running, cap ${MAX_RUNNING}) — wait or kill one with the bgjob tool before starting another`,
      );
    }
    let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["bash", "-c", opts.command], {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
      });
    } catch (exc) {
      return errorResult(`bash: failed to start background job: ${exc}`);
    }
    const id = newJobId();
    const buffer = new BoundedBuffer(BOUND_OPTS);
    const stream = opts.artifacts?.beginStream("bash") ?? null;
    const entry: BgJobEntry = {
      id,
      proc,
      buffer,
      pgid: proc.pid,
      command: opts.command,
      state: "running",
      exitCode: null,
      spillRef: null,
      exited: Promise.resolve(),
      signal: opts.signal,
      onAbort: null,
      finalized: false,
    };
    this.entries.set(id, entry);
    entry.exited = this.run(entry, stream);
    if (opts.signal) {
      const onAbort = () => {
        this.kill(id, "aborted");
      };
      entry.onAbort = onAbort;
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    this.recordLaunch(entry, opts.cwd);
    return {
      content: [text(`[background job ${id} started (pid ${proc.pid})] Poll with bgjob.`)],
      details: { job_id: id, pid: proc.pid, background: true },
    };
  }

  /** Signal a live job's whole process group. `aborted` records as `killed` (the state
   * machine has no aborted state); the durable row + output stats land in finalize when
   * the process actually exits. Returns false if the job is unknown or already settling. */
  kill(id: string, reason: "killed" | "aborted"): boolean {
    void reason;
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "running") return false;
    entry.state = "killed";
    killProcessGroup(entry.proc);
    return true;
  }

  /** Session-end orphan policy: kill every live job's group and durably mark it `killed`
   * NOW (synchronous, before the DB closes). The async finalize then no-ops the DB. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== "running") continue;
      entry.state = "killed";
      this.markTerminal(entry.id, "killed", null);
      killProcessGroup(entry.proc);
    }
  }

  // --------------------------------------------------------------- bgjob tool surface

  statusResult(id: string): ToolResult {
    const entry = this.entries.get(id);
    if (entry)
      return { content: [text(this.describeEntry(entry))], details: this.entryDetails(entry) };
    const row = this.rowById(id);
    if (row)
      return { content: [text(this.describeRow(row))], details: { job_id: id, state: row.state } };
    return errorResult(`bgjob: no such job ${id}`);
  }

  async waitResult(id: string, timeoutMs: number): Promise<ToolResult> {
    const entry = this.entries.get(id);
    if (!entry) {
      const row = this.rowById(id);
      if (row)
        return {
          content: [text(this.describeRow(row))],
          details: { job_id: id, state: row.state },
        };
      return errorResult(`bgjob: no such job ${id}`);
    }
    await Promise.race([entry.exited, delay(timeoutMs)]);
    return { content: [text(this.describeEntry(entry))], details: this.entryDetails(entry) };
  }

  outputResult(id: string): ToolResult {
    const entry = this.entries.get(id);
    if (entry) {
      const snap = entry.buffer.snapshot();
      const head = `[job ${id} · ${entry.state}${entry.exitCode !== null ? ` · exit ${entry.exitCode}` : ""}]`;
      const tail = entry.spillRef ? `\n[full output saved: ${entry.spillRef}]` : "";
      return {
        content: [text(snap ? `${head}\n${snap}${tail}` : `${head}\n(no output)${tail}`)],
        details: this.entryDetails(entry),
      };
    }
    const row = this.rowById(id);
    if (row) {
      const ptr = row.spill_ref
        ? `[job ${id} · ${row.state}] full output saved: ${row.spill_ref}`
        : `[job ${id} · ${row.state}] output not retained (live buffer gone; no spill)`;
      return {
        content: [text(ptr)],
        details: { job_id: id, state: row.state, spill_ref: row.spill_ref },
      };
    }
    return errorResult(`bgjob: no such job ${id}`);
  }

  async killResult(id: string): Promise<ToolResult> {
    const entry = this.entries.get(id);
    if (!entry) {
      const row = this.rowById(id);
      if (row && row.state !== "running") {
        return {
          content: [text(`[job ${id} already ${row.state}]`)],
          details: { job_id: id, state: row.state },
        };
      }
      return errorResult(`bgjob: no such job ${id}`);
    }
    if (entry.state !== "running" && entry.finalized) {
      return { content: [text(this.describeEntry(entry))], details: this.entryDetails(entry) };
    }
    this.kill(id, "killed");
    await Promise.race([entry.exited, delay(KILL_SETTLE_MS)]);
    return { content: [text(this.describeEntry(entry))], details: this.entryDetails(entry) };
  }

  listResult(): ToolResult {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries.values()) {
      seen.add(entry.id);
      lines.push(this.describeEntry(entry));
    }
    for (const row of this.rowsForRun()) {
      if (!seen.has(row.id)) lines.push(this.describeRow(row));
    }
    const bodyText = lines.length ? lines.join("\n") : "no background jobs";
    return { content: [text(bodyText)], details: { count: lines.length } };
  }

  // --------------------------------------------------------------------- reaper (v22)

  /** At attach: reconcile `running` rows left by a DIFFERENT run. Three guards before any
   * signal — concurrent-session, group-liveness, then identity — so a reused PID is never
   * killed and a job that died with its session is marked `lost`, not given a fake exit. */
  reapOrphans(): void {
    if (!this.sql || !this.runId) return;
    let rows: BgJobRow[];
    try {
      rows = this.sql
        .query("SELECT * FROM bg_jobs WHERE state = 'running' AND run_id != ?")
        .all(this.runId) as BgJobRow[];
    } catch {
      return;
    }
    for (const row of rows) {
      // (1) the launching harness is still alive → a concurrent session owns it, skip.
      if (row.harness_pid !== null && this.probes.processAlive(row.harness_pid)) continue;
      const pgid = row.pgid ?? row.pid;
      // (2) no group / the group is gone → it died with its session; never invent an exit.
      if (pgid === null || !this.probes.processAlive(-pgid)) {
        this.markTerminal(row.id, "lost", null);
        continue;
      }
      // (3) identity: the live pid's command must still match what we recorded.
      const live = row.pid !== null ? this.probes.commandOf(row.pid) : null;
      if (live !== null && commandMatches(live, row.command)) {
        killProcessGroup({ pid: pgid, kill: () => {}, unref: () => {} });
        this.markTerminal(row.id, "orphaned", null);
      } else {
        // PID reused (or unverifiable) → NEVER signal; the record is stale.
        this.markTerminal(row.id, "lost", null);
      }
    }
  }

  // ------------------------------------------------------------------------- internals

  private runningCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.state === "running") n += 1;
    return n;
  }

  private async run(entry: BgJobEntry, artifactStream: ArtifactStream | null): Promise<void> {
    let stream = artifactStream;
    const tee = stream
      ? (chunk: string) => {
          if (!stream) return;
          try {
            stream.write(chunk);
          } catch {
            const dead = stream;
            stream = null;
            void this.discardStream(dead);
          }
        }
      : undefined;
    try {
      await Promise.all([
        pumpStream(entry.proc.stdout ?? null, entry.buffer, tee),
        pumpStream(entry.proc.stderr ?? null, entry.buffer, tee),
        entry.proc.exited,
      ]);
    } catch {
      // a broken pipe never breaks bookkeeping — finalize still records the exit
    }
    const code = await entry.proc.exited.catch(() => -1);
    await this.finalize(entry, code, stream);
  }

  private async finalize(
    entry: BgJobEntry,
    code: number,
    stream: ArtifactStream | null,
  ): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    entry.exitCode = code;
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
    }
    const b = entry.buffer.finish();
    let ref: string | null = null;
    if (stream) {
      if (b.truncated) ref = (await this.commitStream(stream))?.ref ?? null;
      else await this.discardStream(stream);
    }
    entry.spillRef = ref;
    // A kill/abort/shutdown already set state to `killed`; a clean exit is `exited`.
    const next: BgJobState = entry.state === "running" ? "exited" : entry.state;
    entry.state = next;
    this.recordExit(entry.id, next, code, b.totalChars, b.truncated, ref);
  }

  private async commitStream(s: ArtifactStream): Promise<{ ref: string } | null> {
    try {
      return await s.commit();
    } catch {
      return null;
    }
  }

  private async discardStream(s: ArtifactStream): Promise<void> {
    try {
      await s.discard();
    } catch {
      // spill is best-effort; the job result never depends on it
    }
  }

  private describeEntry(entry: BgJobEntry): string {
    const parts = [`${entry.id}`, entry.state, `pid ${entry.proc.pid}`];
    if (entry.exitCode !== null) parts.push(`exit ${entry.exitCode}`);
    if (entry.spillRef) parts.push(`saved ${entry.spillRef}`);
    return parts.join("  ");
  }

  private describeRow(row: BgJobRow): string {
    const parts = [row.id, row.state];
    if (row.pid !== null) parts.push(`pid ${row.pid}`);
    if (row.exit_code !== null) parts.push(`exit ${row.exit_code}`);
    return parts.join("  ");
  }

  private entryDetails(entry: BgJobEntry): Record<string, unknown> {
    return {
      job_id: entry.id,
      pid: entry.proc.pid,
      state: entry.state,
      exit_code: entry.exitCode,
      spill_ref: entry.spillRef,
    };
  }

  // ------------------------------------------------------------- durable row (fail-open)

  private dbRun(sql: string, params: unknown[]): void {
    if (!this.sql) return;
    try {
      this.sql.run(sql, params);
    } catch {
      // fail-open: bookkeeping never breaks a job
    }
  }

  private rowById(id: string): BgJobRow | null {
    if (!this.sql) return null;
    try {
      const rows = this.sql.query("SELECT * FROM bg_jobs WHERE id = ?").all(id) as BgJobRow[];
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private rowsForRun(): BgJobRow[] {
    if (!this.sql || !this.runId) return [];
    try {
      return this.sql
        .query("SELECT * FROM bg_jobs WHERE run_id = ? ORDER BY started")
        .all(this.runId) as BgJobRow[];
    } catch {
      return [];
    }
  }

  private recordLaunch(entry: BgJobEntry, cwd: string | undefined): void {
    const now = nowSec();
    this.dbRun(
      `INSERT INTO bg_jobs (id, run_id, agent_id, pid, pgid, harness_pid, command, cwd, state, started, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      [
        entry.id,
        this.runId,
        null,
        entry.proc.pid,
        entry.pgid,
        this.probes.harnessPid,
        entry.command,
        cwd ?? null,
        now,
        now,
      ],
    );
  }

  private recordExit(
    id: string,
    state: BgJobState,
    code: number,
    outputChars: number,
    truncated: boolean,
    ref: string | null,
  ): void {
    const now = nowSec();
    this.dbRun(
      `UPDATE bg_jobs SET state = ?, exit_code = ?, output_chars = ?, truncated = ?, spill_ref = ?, ended = ?, updated = ?
       WHERE id = ? AND state = 'running'`,
      [state, code, outputChars, truncated ? 1 : 0, ref, now, now, id],
    );
  }

  /** Terminal write guarded so a terminal state never regresses (reaper + shutdown). */
  private markTerminal(id: string, state: BgJobState, code: number | null): void {
    const now = nowSec();
    this.dbRun(
      "UPDATE bg_jobs SET state = ?, exit_code = ?, ended = ?, updated = ? WHERE id = ? AND state = 'running'",
      [state, code, now, now, id],
    );
  }
}
