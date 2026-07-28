/**
 * Dashboard lifecycle — one server per ledger, owned by no TUI, refcounted by the kernel.
 *
 * The shape and why it is this shape:
 *
 *  - **The server belongs to nobody.** A TUI that finds no live server spawns a DETACHED child
 *    (`minima dashboard --managed`) and then holds a client connection to it. Closing the TUI that
 *    happened to start it therefore changes nothing — same port, same token, same open browser tab.
 *    It also keeps the read-only guarantee structural: the serving process still never imports
 *    MinimaDb, and `DashboardHandle.readOnly` is the literal type `true`, so a write-capable server
 *    is a type error rather than a policy.
 *
 *  - **The bind is the mutex.** Two TUIs starting in the same instant both spawn; `Bun.serve`
 *    throwing EADDRINUSE is the atomic race-winner, and the loser re-checks and exits 0. No lock
 *    file is involved in the common case, because the kernel already arbitrates ports.
 *
 *  - **The pid is the identity; the socket is a fast path.** A held HTTP request drops the instant
 *    the kernel reaps a TUI, which covers clean exit, `kill -9`, SIGHUP and an OOM kill. It does
 *    NOT cover a background job that inherited the fd and outlived its parent — there the socket
 *    stays open with nobody behind it, so the server also probes `kill(pid, 0)` on the poll tick it
 *    already runs and drops a dead pid even when its socket is alive. That pair reduces the odds of
 *    an immortal server; it does not eliminate them (a reused pid inside the grace window reads as
 *    alive), which is why the design biases toward exiting: a false reap costs one respawn, and a
 *    missed reap costs a server nobody can see.
 *
 *  - **Losing the server is cheap, so the client re-establishes.** An attach that ends for ANY
 *    reason re-runs discovery and spawns if needed. Event-driven: the stream ending is the trigger,
 *    so an idle TUI holds one socket and runs no timer. That is what makes the invariant "a server
 *    exists while a TUI exists" instead of "a server was started once".
 *
 * Keyed on the RESOLVED ledger path, not on the machine: a second harness pointed at its own DB
 * gets its own server rather than being handed the wrong data.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mintTicket } from "./auth.ts";

/** Ports tried in order. 4180 is the documented default; the rest exist because it is also
 * oauth2-proxy's default and a stale `minima dashboard` holds it just as effectively. */
export const PORT_RANGE: readonly number[] = [
  4180, 4181, 4182, 4183, 4184, 4185, 4186, 4187, 4188, 4189,
];
export const DEFAULT_HOST = "127.0.0.1";

export interface ResolvedLedger {
  path: string;
  via: "realpath" | "resolve";
}

/**
 * The rendezvous key, and the only definition of "same ledger" in the system.
 *
 * `defaultDbPath()` hands back `MINIMA_DB_PATH` verbatim — no resolve, no realpath — and
 * `DashboardStore.path` echoes whatever string it was given, which is what `/healthz` reports. So
 * without this, `MINIMA_DB_PATH=./x.db` from two different working directories hashes identically
 * AND reports an identical ledger, and the ledger-match check passes while the files differ. That
 * is the one failure mode here that is silent rather than merely wasteful; symlinks and macOS's
 * /tmp -> /private/tmp only cost a duplicate server.
 *
 * Falls back to the containing directory's realpath so a ledger that does not exist yet keys the
 * same way it will once created.
 */
export function resolveLedger(raw: string): ResolvedLedger {
  const abs = isAbsolute(raw) ? raw : resolve(raw);
  try {
    return { path: realpathSync(abs), via: "realpath" };
  } catch {
    // not created yet, or an unreadable parent
  }
  try {
    return { path: join(realpathSync(dirname(abs)), basename(abs)), via: "realpath" };
  } catch {
    return { path: abs, via: "resolve" };
  }
}

/**
 * One file per ledger, in a `dashboard/` directory BESIDE that ledger.
 *
 * Beside it rather than in a fixed home dir, because that makes "one server per ledger" structural:
 * the detached child re-derives the identical path from the `--db` it was handed, with nothing to
 * plumb through and no module-level default that a caller could disagree with. A harness pointed at
 * its own DB gets its own rendezvous for free. The hashed filename still earns its keep — two
 * ledgers can share a directory.
 */
export function rendezvousPath(resolvedLedger: string, dir?: string): string {
  const key = createHash("sha256").update(resolvedLedger).digest("hex").slice(0, 16);
  return join(dir ?? join(dirname(resolvedLedger), "dashboard"), `${key}.json`);
}

export interface Rendezvous {
  /** The resolved ledger this server serves; checked against /healthz, never trusted alone. */
  ledger: string;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  /** Why the port is not the default one, when it isn't. Surfaced by `/dashboard`. */
  portNote?: string | null;
}

function validRendezvous(v: unknown): v is Rendezvous {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ledger === "string" &&
    typeof r.token === "string" &&
    Number.isInteger(r.port) &&
    Number.isInteger(r.pid) &&
    typeof r.startedAt === "number"
  );
}

export async function readRendezvous(path: string): Promise<Rendezvous | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return validRendezvous(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 0600 from the moment it exists — it carries a bearer token. Mirrors `tui/projects.ts`. */
export async function writeRendezvous(path: string, rv: Rendezvous): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(rv, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await chmod(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Delete the rendezvous ONLY when it still names us.
 *
 * A server that was displaced while wedged (port held, healthz silent) wakes up to find the file
 * naming its replacement. Without this guard its ordinary idle shutdown would delete the live
 * server's rendezvous on the way out.
 */
export async function clearRendezvous(path: string, pid: number): Promise<boolean> {
  const rv = await readRendezvous(path);
  if (!rv || rv.pid !== pid) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    // EPERM means it exists and is not ours, which is still alive.
    return (exc as { code?: string }).code === "EPERM";
  }
}

export interface Health {
  ok: boolean;
  ledger: string;
  clients?: number;
  pid?: number;
  startedAt?: number;
  portNote?: string | null;
}

export type ProbeFn = (port: number) => Promise<Health | null>;

export function httpProbe(
  host = DEFAULT_HOST,
  timeoutMs = 300,
  impl: typeof fetch = fetch,
): ProbeFn {
  return async (port: number): Promise<Health | null> => {
    try {
      const res = await impl(`http://${host}:${port}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<Health> | null;
      return body && typeof body.ledger === "string" && body.ok === true ? (body as Health) : null;
    } catch {
      return null;
    }
  };
}

/**
 * Deliberately NOT `unref()`ed, against this codebase's usual timer habit.
 *
 * `unref` is right for a poller that must never be the reason a process lives. It is catastrophic
 * for an awaited sleep, because an awaited sleep IS the work in flight: in the managed child, the
 * only thing pending during discovery's inter-probe gap is this timer, so an unref'd one let Bun
 * decide the event loop was empty and exit **0** in the middle of starting up. The failure looked
 * like "the server silently never comes up, but only when a rendezvous file already exists" — the
 * one path that sleeps.
 *
 * The supervisor's own long backoff is cancellable instead (`wait`), so a TUI still quits promptly.
 */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retried on purpose. A single sub-second probe cannot tell "gone" from "busy", and treating a
 * merely-slow server as dead means displacing it and leaking its port.
 */
export async function probeLive(
  port: number,
  probe: ProbeFn,
  opts: { tries?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Health | null> {
  const tries = opts.tries ?? 3;
  const gap = opts.gapMs ?? 300;
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < tries; i += 1) {
    const health = await probe(port);
    if (health) return health;
    if (i + 1 < tries) await sleep(gap);
  }
  return null;
}

export type Discovery =
  | { kind: "live"; rv: Rendezvous; health: Health }
  /** Nothing usable is recorded, or what is recorded is provably gone. Safe to take over. */
  | { kind: "stale"; rv: Rendezvous | null; reason: string }
  /** Recorded pid is ALIVE but not serving. Its port is not ours to reclaim. */
  | { kind: "wedged"; rv: Rendezvous; reason: string };

export type LiveDiscovery = Extract<Discovery, { kind: "live" }>;

export async function discover(d: {
  ledger: string;
  path: string;
  probe: ProbeFn;
  tries?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Discovery> {
  const rv = await readRendezvous(d.path);
  if (!rv) return { kind: "stale", rv: null, reason: "no dashboard recorded for this ledger" };
  if (rv.ledger !== d.ledger) {
    return { kind: "stale", rv, reason: "recorded dashboard serves a different ledger" };
  }
  const health = await probeLive(rv.port, d.probe, {
    tries: d.tries,
    gapMs: d.gapMs,
    sleep: d.sleep,
  });
  if (health && health.ledger === d.ledger) return { kind: "live", rv, health };
  if (health) {
    return { kind: "stale", rv, reason: `port ${rv.port} now serves a different ledger` };
  }
  if (pidAlive(rv.pid)) {
    return {
      kind: "wedged",
      rv,
      reason: `port ${rv.port} held by an unresponsive process (pid ${rv.pid})`,
    };
  }
  return { kind: "stale", rv, reason: `recorded dashboard (pid ${rv.pid}) is gone` };
}

/**
 * Is a server for THIS ledger already listening anywhere in the range?
 *
 * The rendezvous file cannot answer this on its own, and that gap is a real one: a child binds and
 * *then* publishes, so for a few milliseconds a live server exists that no file names. Two children
 * racing through the range both read "nothing recorded", both bind, and one ledger ends up with two
 * servers — observed as three at once under a simultaneous start. Ten loopback probes close the
 * window that a file-only check leaves open.
 */
export async function findServing(
  ports: readonly number[],
  ledger: string,
  probe: ProbeFn,
): Promise<{ port: number; health: Health } | null> {
  for (const port of ports) {
    const health = await probe(port);
    if (health?.ok && health.ledger === ledger) return { port, health };
  }
  return null;
}

export type BindResult<H> =
  | { kind: "bound"; handle: H; port: number; skipped: number[] }
  /** Another server won the range while we were probing it. */
  | { kind: "yielded"; skipped: number[] }
  | { kind: "exhausted"; skipped: number[] };

export function isAddrInUse(exc: unknown): boolean {
  const e = exc as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return /EADDRINUSE|address already in use/i.test(text);
}

/**
 * Walk the range and let the kernel pick the winner. `onFallback` runs before any non-first port
 * is taken: by then another TUI's child may have published a live server, and two dashboards on
 * one ledger is exactly what this whole module exists to prevent.
 */
export async function bindWithProbe<H>(d: {
  ports: readonly number[];
  /** `skipped` is handed over so the server can report WHY it is not on the default port. */
  start: (port: number, skipped: number[]) => H;
  onFallback?: () => Promise<boolean>;
}): Promise<BindResult<H>> {
  const skipped: number[] = [];
  for (const port of d.ports) {
    if (skipped.length > 0 && d.onFallback && (await d.onFallback())) {
      return { kind: "yielded", skipped };
    }
    try {
      return { kind: "bound", handle: d.start(port, [...skipped]), port, skipped };
    } catch (exc) {
      if (!isAddrInUse(exc)) throw exc;
      skipped.push(port);
    }
  }
  return { kind: "exhausted", skipped };
}

/**
 * The argv that re-enters this binary as a managed server.
 *
 * Two builds, two shapes: the Homebrew binary IS `process.execPath`, while `bun run src/cli/main.ts`
 * needs the entry path passed to bun. `Bun.main` is the discriminator — it is under `/$bunfs/` in a
 * compiled binary and a real source path otherwise.
 */
export function isCompiledBinary(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs/") || !/\.(ts|tsx|js|mjs|cjs)$/.test(main);
}

export function managedArgv(dbPath: string, main: string = Bun.main): string[] {
  const tail = ["dashboard", "--managed", "--db", dbPath];
  return isCompiledBinary(main) ? [process.execPath, ...tail] : [process.execPath, main, ...tail];
}

/**
 * Detached, so the terminal's process group signals never reach it: Ctrl+C in the shell that
 * launched the TUI must not take the dashboard down with it, and neither must closing the window.
 * `--db` is passed explicitly and the cwd is fixed, so nothing is re-derived relative to a working
 * directory the child does not share.
 */
export function spawnManaged(argv: string[], cwd: string = homedir()): void {
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: "ignore",
    cwd,
    env: { ...process.env, MINIMA_TUI_DASHBOARD: "0" },
  });
  child.unref();
}

export type SupervisorStatus = "off" | "starting" | "attached" | "reconnecting" | "failed";

export interface DashboardState {
  status: SupervisorStatus;
  /** Why there is no dashboard, or why the port is not the default. Always safe to print. */
  reason: string | null;
  url: string | null;
  port: number | null;
  ledger: string;
  serverPid: number | null;
  startedAt: number | null;
  portNote: string | null;
  clients: number | null;
}

/**
 * What `/dashboard` prints. Here rather than inline in the TUI so it can be asserted without a
 * terminal — the interesting cases are all about what to say when there is NO dashboard, and those
 * are exactly the ones a smoke test never reaches.
 */
export function dashboardReport(
  state: DashboardState | null,
  opts: { disabled?: boolean; age?: (startedAt: number) => string } = {},
): string[] {
  if (!state) {
    return [
      "Dashboard  not running",
      opts.disabled
        ? "  reason   disabled by MINIMA_TUI_DASHBOARD=0"
        : "  reason   no ledger for this session — nothing to serve",
      "  start it yourself with: minima dashboard --open",
    ];
  }
  const lines: string[] = [];
  if (state.url) {
    lines.push(`Dashboard  ${state.url}`);
    // A 60s ticket, not the durable token: this text lands in the transcript.
    lines.push("  link     valid 60s · /dashboard issues a fresh one");
  } else {
    lines.push("Dashboard  not reachable");
    if (state.reason) lines.push(`  reason   ${state.reason}`);
  }
  lines.push(`  ledger   ${state.ledger}`);
  if (state.port !== null) {
    lines.push(`  port     ${state.port}${state.portNote ? ` — ${state.portNote}` : ""}`);
  }
  const who = [
    state.status,
    state.clients === null ? null : `${state.clients} attached`,
    state.serverPid === null ? null : `server pid ${state.serverPid}`,
    state.startedAt === null || !opts.age ? null : `started ${opts.age(state.startedAt)}`,
  ].filter((p): p is string => p !== null);
  lines.push(`  state    ${who.join(" · ")}`);
  return lines;
}

export interface SupervisorOptions {
  /** RESOLVED ledger path — see `resolveLedger`. */
  ledger: string;
  pid?: number;
  host?: string;
  ports?: readonly number[];
  dir?: string;
  probe?: ProbeFn;
  spawnServer?: (dbPath: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  probeTries?: number;
  probeGapMs?: number;
  /** How long to wait for a spawned child to publish its rendezvous. */
  spawnWaitMs?: number;
  backoffMs?: readonly number[];
}

/**
 * The TUI's half: keep exactly one attach open for as long as this process lives, and treat losing
 * it as a reason to re-discover rather than a reason to give up.
 */
export class DashboardSupervisor {
  private readonly opts: Required<
    Omit<SupervisorOptions, "probe" | "spawnServer" | "fetchImpl" | "sleep" | "now" | "dir">
  > & {
    probe: ProbeFn;
    spawnServer: (dbPath: string) => void;
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  };
  private readonly rvPath: string;
  private state: DashboardState;
  private stopped = false;
  private abort: AbortController | null = null;
  private wakeup: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;

  constructor(options: SupervisorOptions) {
    this.opts = {
      ledger: options.ledger,
      pid: options.pid ?? process.pid,
      host: options.host ?? DEFAULT_HOST,
      ports: options.ports ?? PORT_RANGE,
      probeTries: options.probeTries ?? 3,
      probeGapMs: options.probeGapMs ?? 300,
      spawnWaitMs: options.spawnWaitMs ?? 2_000,
      backoffMs: options.backoffMs ?? [500, 1_000, 2_000, 4_000, 8_000],
      probe: options.probe ?? httpProbe(options.host ?? DEFAULT_HOST, 300, options.fetchImpl),
      spawnServer: options.spawnServer ?? ((dbPath: string) => spawnManaged(managedArgv(dbPath))),
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? realSleep,
      now: options.now ?? Date.now,
    };
    // The child re-derives this from `--db`, so an override here is for tests only — in a real run
    // both sides compute it from the ledger and cannot disagree.
    this.rvPath = rendezvousPath(options.ledger, options.dir);
    this.state = {
      status: "off",
      reason: null,
      url: null,
      port: null,
      ledger: options.ledger,
      serverPid: null,
      startedAt: null,
      portNote: null,
      clients: null,
    };
  }

  /** Fire-and-forget. Never awaited by the caller — a wedged probe must not delay the TUI. */
  start(): void {
    if (this.loopDone) return;
    this.state = { ...this.state, status: "starting" };
    this.loopDone = this.loop().catch(() => {
      // the loop swallows its own errors; this is the belt for an unexpected throw
    });
  }

  /**
   * What `/dashboard` prints. Re-reads the rendezvous and re-probes, so it stays correct when
   * another TUI started the server or the server moved ports — a cached URL would be a lie the
   * moment anything changed. The link is a short-lived ticket, not the durable token.
   */
  async snapshot(): Promise<DashboardState> {
    const rv = await readRendezvous(this.rvPath);
    if (!rv || rv.ledger !== this.opts.ledger) return this.state;
    const health = await this.opts.probe(rv.port);
    return {
      ...this.state,
      url: `http://${this.opts.host}:${rv.port}/?k=${mintTicket(rv.token, this.opts.now())}`,
      port: rv.port,
      serverPid: rv.pid,
      startedAt: rv.startedAt,
      portNote: rv.portNote ?? null,
      clients: health?.clients ?? null,
      status: health ? this.state.status : "reconnecting",
    };
  }

  detach(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    // Cancel a pending backoff rather than let it hold the TUI's event loop open on the way out.
    this.wakeup?.();
    this.state = { ...this.state, status: "off", url: null };
  }

  /**
   * A sleep that holds the loop while it is pending (see `realSleep`) but is cut short by `detach`,
   * so an 8s backoff can never become an 8s delay between Ink exiting and the process ending.
   */
  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeup = null;
        resolve();
      }, ms);
      this.wakeup = () => {
        clearTimeout(timer);
        this.wakeup = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const attachedAt = this.opts.now();
      const ok = await this.cycle();
      if (this.stopped) return;
      // A long-lived attach that ended is a fresh start, not an escalation.
      if (ok && this.opts.now() - attachedAt > 5_000) attempt = 0;
      const backoff = this.opts.backoffMs[Math.min(attempt, this.opts.backoffMs.length - 1)]!;
      attempt += 1;
      this.state = { ...this.state, status: ok ? "reconnecting" : this.state.status };
      await this.wait(backoff);
    }
  }

  /** One discovery→attach attempt. Resolves when the attach ends; true if it ever landed. */
  private async cycle(): Promise<boolean> {
    const found = await discover({
      ledger: this.opts.ledger,
      path: this.rvPath,
      probe: this.opts.probe,
      tries: this.opts.probeTries,
      gapMs: this.opts.probeGapMs,
      sleep: this.opts.sleep,
    });

    let live = found.kind === "live" ? found : null;
    if (!live) {
      try {
        this.opts.spawnServer(this.opts.ledger);
      } catch (exc) {
        this.fail(`could not start the dashboard: ${(exc as Error).message}`);
        return false;
      }
      live = await this.awaitRendezvous(found.rv?.pid ?? null);
      if (!live) {
        this.fail(found.kind === "wedged" ? found.reason : "the dashboard did not come up");
        return false;
      }
    }

    return await this.hold(live.rv);
  }

  /** Poll for a child's rendezvous — a freshly written file naming a live, answering server. */
  private async awaitRendezvous(priorPid: number | null): Promise<LiveDiscovery | null> {
    const deadline = this.opts.now() + this.opts.spawnWaitMs;
    while (!this.stopped && this.opts.now() < deadline) {
      await this.wait(100);
      const rv = await readRendezvous(this.rvPath);
      if (!rv || rv.ledger !== this.opts.ledger || rv.pid === priorPid) continue;
      const health = await this.opts.probe(rv.port);
      if (health && health.ledger === this.opts.ledger) return { kind: "live", rv, health };
    }
    return null;
  }

  private async hold(rv: Rendezvous): Promise<boolean> {
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const res = await this.opts.fetchImpl(
        `http://${this.opts.host}:${rv.port}/attach?pid=${this.opts.pid}`,
        { headers: { "x-minima-token": rv.token }, signal: ctrl.signal },
      );
      if (!res.ok || !res.body) {
        this.fail(`the dashboard refused the attach (${res.status})`);
        return false;
      }
      this.state = {
        status: "attached",
        reason: rv.portNote ?? null,
        url: null,
        port: rv.port,
        ledger: this.opts.ledger,
        serverPid: rv.pid,
        startedAt: rv.startedAt,
        portNote: rv.portNote ?? null,
        clients: null,
      };
      const reader = res.body.getReader();
      // Read and DISCARD. These are keepalive frames; retaining them is how a held socket turns
      // into a memory leak, and this process is the one that must never grow while idle.
      while (!this.stopped) {
        const { done } = await reader.read();
        if (done) break;
      }
      return true;
    } catch {
      if (!this.stopped) this.state = { ...this.state, status: "reconnecting" };
      return false;
    } finally {
      this.abort = null;
    }
  }

  private fail(reason: string): void {
    this.state = { ...this.state, status: "failed", reason, url: null };
  }
}
