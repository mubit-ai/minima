/**
 * Dashboard lifecycle over REAL sockets. The rest of the dashboard suite is hermetic; this file is
 * not, deliberately.
 *
 * The bug that justifies it: an attach stream that says nothing is closed by Bun at `idleTimeout`
 * (60s), which would have dropped every attached TUI a minute after boot and taken the server down
 * with three sessions still open. No state-transition test catches that — every one of them
 * finishes in milliseconds. So the timings are injected (grace and keepalive in the tens of ms)
 * and the assertions are about DURATION: a stream that is still open after the timeout it should
 * have survived, and a server that exits only when its clients are really gone.
 *
 * Binds an ephemeral port (port 0) so it cannot collide with a real dashboard or with CI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DashboardHandle, startDashboard } from "../src/dashboard/server.ts";
import { MinimaDb } from "../src/db/minima_db.ts";

let dir: string;
let dbPath: string;
const live: DashboardHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minima-life-"));
  dbPath = join(dir, "minima.db");
  const db = new MinimaDb(dbPath);
  db.ensureProject(dir);
  db.startRun({ projectKey: dir });
  db.close();
});

afterEach(() => {
  for (const h of live.splice(0)) {
    try {
      h.stop();
    } catch {
      // already stopped by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function serve(opts: Parameters<typeof startDashboard>[0] = {}): DashboardHandle {
  const handle = startDashboard({
    dbPath,
    port: 0,
    graceMs: 60,
    pollMs: 10,
    keepaliveMs: 20,
    ...opts,
  });
  live.push(handle);
  return handle;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stand-in client pids for tests about counting. Never borrow a real pid we do not control —
 * `process.ppid` becomes 1 in an orphaned runner, and pid 1 is refused by design. */
const PID_A = 900_001;
const PID_B = 900_002;
const PID_C = 900_003;

/** Attach as a TUI would and return a reader over the held stream. */
async function attach(
  h: DashboardHandle,
  pid: number,
): Promise<{ res: Response; reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${h.port}/attach?pid=${pid}`, {
    headers: { "x-minima-token": h.token },
    signal: ctrl.signal,
  });
  return { res, reader: res.body!.getReader(), abort: () => ctrl.abort() };
}

describe("attach: the refcount", () => {
  test("an attached client is counted, and /healthz reports it", async () => {
    const h = serve();
    const c = await attach(h, process.pid);
    expect(h.clients()).toBe(1);
    const health = (await (await fetch(`http://127.0.0.1:${h.port}/healthz`)).json()) as {
      clients: number;
      ledger: string;
    };
    expect(health.clients).toBe(1);
    expect(health.ledger).toBe(dbPath);
    c.abort();
  });

  test("requires the token — an unauthenticated attach cannot pin the server open", async () => {
    const h = serve();
    const res = await fetch(`http://127.0.0.1:${h.port}/attach?pid=${process.pid}`);
    expect(res.status).toBe(401);
    expect(h.clients()).toBe(0);
  });

  test("a bogus pid is refused: pid 1 is always alive and would never be reaped", async () => {
    const h = serve();
    for (const pid of ["1", "0", "-2", "abc", ""]) {
      const res = await fetch(`http://127.0.0.1:${h.port}/attach?pid=${pid}`, {
        headers: { "x-minima-token": h.token },
      });
      expect(res.status).toBe(400);
    }
    expect(h.clients()).toBe(0);
  });

  test("a client that goes away drops the count", async () => {
    const h = serve();
    const c = await attach(h, process.pid);
    expect(h.clients()).toBe(1);
    c.abort();
    for (let i = 0; i < 50 && h.clients() > 0; i += 1) await sleep(10);
    expect(h.clients()).toBe(0);
  });

  test("re-attaching from the same pid stays ONE client, not two", async () => {
    const h = serve();
    const first = await attach(h, process.pid);
    const second = await attach(h, process.pid);
    await sleep(30);
    expect(h.clients()).toBe(1);
    // The replaced stream is closed by the server, and its late close must not evict the live one.
    await first.reader.read().catch(() => undefined);
    await sleep(30);
    expect(h.clients()).toBe(1);
    second.abort();
  });

  test("the client cap is enforced and is NOT the browser-stream cap", async () => {
    // `alive` is injected because this test is about COUNTING, not liveness: a second real pid is
    // not ours to borrow. (`process.ppid` was, and it is 1 when the runner is orphaned — which the
    // bad_pid guard correctly rejects, so the test silently attached one client instead of two.)
    const h = serve({ maxClients: 2, alive: () => true });
    const a = await attach(h, PID_A);
    const b = await attach(h, PID_B);
    expect(h.clients()).toBe(2);
    const third = await fetch(`http://127.0.0.1:${h.port}/attach?pid=${PID_C}`, {
      headers: { "x-minima-token": h.token },
    });
    expect(await third.text()).toContain("too_many_clients");
    expect(h.clients()).toBe(2);
    a.abort();
    b.abort();
  });
});

describe("attach: the keepalive, which is the whole point", () => {
  test("a held stream receives keepalive frames instead of sitting idle", async () => {
    // This is the assertion whose absence hid the t=61s bug: without a frame on this socket, Bun's
    // idleTimeout closes it and the server loses every client while the TUIs are still running.
    const h = serve({ keepaliveMs: 20, pollMs: 10 });
    const c = await attach(h, process.pid);
    const first = await c.reader.read();
    expect(new TextDecoder().decode(first.value!)).toContain("attached");
    const second = await Promise.race([
      c.reader.read().then(() => "frame"),
      sleep(1_500).then(() => "silent"),
    ]);
    expect(second).toBe("frame");
    c.abort();
  });

  test("the attach subscriber does not consume the browser stream budget", async () => {
    const h = serve({ alive: () => true });
    const clients = await Promise.all([attach(h, PID_A), attach(h, PID_B)]);
    const streams: Response[] = [];
    for (let i = 0; i < 8; i += 1) {
      streams.push(
        await fetch(`http://127.0.0.1:${h.port}/api/v1/stream`, {
          headers: { "x-minima-token": h.token },
        }),
      );
    }
    // All 8 browser streams got a real subscription even with 2 TUIs attached.
    for (const s of streams) {
      const text = new TextDecoder().decode((await s.body!.getReader().read()).value!);
      expect(text).not.toContain("too_many_streams");
    }
    expect(h.clients()).toBe(2);
    for (const c of clients) c.abort();
  });
});

describe("idle shutdown", () => {
  test("fires once after the grace when the last client leaves, not before", async () => {
    let idle = 0;
    const h = serve({ graceMs: 80, onIdle: () => (idle += 1) });
    const c = await attach(h, process.pid);
    await sleep(150);
    expect(idle).toBe(0); // an attached client holds it open indefinitely
    c.abort();
    for (let i = 0; i < 60 && idle === 0; i += 1) await sleep(10);
    expect(idle).toBe(1);
    await sleep(150);
    expect(idle).toBe(1); // exactly once
  });

  test("a client arriving inside the grace window cancels the exit", async () => {
    let idle = 0;
    const h = serve({ graceMs: 200, onIdle: () => (idle += 1) });
    const first = await attach(h, process.pid);
    first.abort();
    await sleep(60);
    const second = await attach(h, process.pid);
    await sleep(300);
    expect(idle).toBe(0);
    second.abort();
  });

  test("a server nobody ever attaches to still goes away", async () => {
    let idle = 0;
    serve({ graceMs: 40, onIdle: () => (idle += 1) });
    for (let i = 0; i < 60 && idle === 0; i += 1) await sleep(10);
    expect(idle).toBe(1);
  });
});

describe("the pid outranks the socket", () => {
  test("a dead pid is dropped even while its socket is still held open", async () => {
    // The scenario the socket alone cannot cover: a background job inherited the fd and outlived
    // the TUI, so nothing closes the connection. `alive` reports the truth and the pid wins.
    let alive = true;
    let idle = 0;
    const h = serve({ graceMs: 40, pollMs: 10, alive: () => alive, onIdle: () => (idle += 1) });
    const c = await attach(h, process.pid);
    await sleep(50);
    expect(h.clients()).toBe(1);
    alive = false;
    for (let i = 0; i < 80 && h.clients() > 0; i += 1) await sleep(10);
    expect(h.clients()).toBe(0);
    for (let i = 0; i < 60 && idle === 0; i += 1) await sleep(10);
    expect(idle).toBe(1);
    // Our end of the orphaned stream was closed too, rather than left dangling.
    const done = await Promise.race([
      (async () => {
        for (;;) {
          const r = await c.reader.read();
          if (r.done) return "closed";
        }
      })(),
      sleep(500).then(() => "open"),
    ]);
    expect(done).toBe("closed");
  });

  test("a live pid keeps its client even when the poller runs repeatedly", async () => {
    const h = serve({ graceMs: 30, pollMs: 10, alive: () => true });
    const c = await attach(h, process.pid);
    await sleep(120);
    expect(h.clients()).toBe(1);
    c.abort();
  });
});

describe("the managed child, as a real process", () => {
  /**
   * The bug this exists for: `realSleep` was `unref()`ed, so during discovery's inter-probe gap the
   * child's event loop looked empty and Bun exited it **0** mid-startup. It only reproduced when a
   * rendezvous file already existed, because that is the only path that sleeps — so the symptom was
   * "the dashboard silently never comes back after the server is killed", and every in-process test
   * passed, since a test runner's loop is never empty. Only a real child can catch this.
   */
  test("publishes a rendezvous even when a stale one is already there, and clears it on SIGTERM", async () => {
    const { readRendezvous, rendezvousPath, resolveLedger, writeRendezvous } = await import(
      "../src/dashboard/supervisor.ts"
    );
    const ledger = resolveLedger(dbPath).path;
    const rvPath = rendezvousPath(ledger);
    // A server that died hard: file intact, pid long gone, nothing listening on its port.
    await writeRendezvous(rvPath, {
      ledger,
      port: 4189,
      token: "stale",
      pid: 2_147_483_000,
      startedAt: 1,
    });

    const child = spawn(
      process.execPath,
      [
        join(import.meta.dir, "..", "src", "cli", "main.ts"),
        "dashboard",
        "--managed",
        "--db",
        dbPath,
      ],
      { stdio: "ignore", detached: false },
    );
    try {
      let published: Awaited<ReturnType<typeof readRendezvous>> = null;
      for (let i = 0; i < 120; i += 1) {
        await sleep(100);
        const rv = await readRendezvous(rvPath);
        if (rv && rv.pid !== 2_147_483_000) {
          published = rv;
          break;
        }
      }
      expect(published).not.toBeNull();
      expect(published!.pid).toBe(child.pid!);
      const health = (await (
        await fetch(`http://127.0.0.1:${published!.port}/healthz`)
      ).json()) as { ledger: string };
      expect(health.ledger).toBe(ledger);

      // Ordered shutdown across a process boundary: the file goes before the socket does.
      child.kill("SIGTERM");
      let cleared = false;
      for (let i = 0; i < 60; i += 1) {
        await sleep(100);
        if ((await readRendezvous(rvPath)) === null) {
          cleared = true;
          break;
        }
      }
      expect(cleared).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("a failed bind leaves nothing behind", () => {
  /**
   * The one that would have shipped. `createDashboard` opens a readonly ledger handle and arms the
   * client registry's idle fuse; `Bun.serve` throws AFTER both. So every port a caller skipped left
   * behind a live 10-second timer whose `onIdle` — with zero clients of its own — shut down the
   * process that had successfully bound a later port. On any machine where 4180 is taken (the common
   * case: it is also oauth2-proxy's default) the dashboard exited every ~10s forever, with TUIs
   * still attached, and respawned into the same loop.
   */
  test("a busy port does not leave an idle fuse that kills the real server", async () => {
    const first = serve({ graceMs: 50 });
    let firedFromFailedAttempt = 0;
    expect(() =>
      startDashboard({
        dbPath,
        port: first.port,
        graceMs: 50,
        onIdle: () => (firedFromFailedAttempt += 1),
      }),
    ).toThrow();
    // Well past the grace: the discarded attempt must be inert, not counting down.
    const held = await attach(first, process.pid);
    await sleep(400);
    expect(firedFromFailedAttempt).toBe(0);
    expect(first.clients()).toBe(1);
    held.abort();
  });

  test("and it does not leak a ledger handle per skipped port", async () => {
    const first = serve();
    for (let i = 0; i < 5; i += 1) {
      expect(() => startDashboard({ dbPath, port: first.port })).toThrow();
    }
    // The surviving server still answers; nothing was left half-open on the ledger.
    const res = await fetch(`http://127.0.0.1:${first.port}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe("two managed children in a dead heat", () => {
  /**
   * A ranged bind is a mutex per PORT, not per ledger: two children launched in the same instant
   * clear every pre-bind check and then take different ports. Observed as three live servers for one
   * ledger. The rendezvous file arbitrates afterwards — whoever it names survives — so the claim is
   * one server per ledger in steady state, converging in milliseconds.
   */
  test("converge to exactly ONE server for the ledger", async () => {
    const { readRendezvous, rendezvousPath, resolveLedger, PORT_RANGE, httpProbe } = await import(
      "../src/dashboard/supervisor.ts"
    );
    const ledger = resolveLedger(dbPath).path;
    const rvPath = rendezvousPath(ledger);
    const probe = httpProbe();
    const entry = join(import.meta.dir, "..", "src", "cli", "main.ts");
    const kids = [0, 1].map(() =>
      spawn(process.execPath, [entry, "dashboard", "--managed", "--db", dbPath], {
        stdio: "ignore",
      }),
    );
    const serving = async (): Promise<number[]> => {
      const hits: number[] = [];
      for (const p of PORT_RANGE) {
        const h = await probe(p);
        if (h?.ledger === ledger) hits.push(p);
      }
      return hits;
    };
    try {
      let hits: number[] = [];
      for (let i = 0; i < 150; i += 1) {
        await sleep(100);
        hits = await serving();
        const rv = await readRendezvous(rvPath);
        if (hits.length === 1 && rv && hits[0] === rv.port) break;
      }
      expect(hits.length).toBe(1);
      const rv = await readRendezvous(rvPath);
      expect(rv).not.toBeNull();
      // The survivor is the one the file names — not merely "some server is up".
      expect(rv!.port).toBe(hits[0]!);
      expect(kids.map((k) => k.pid)).toContain(rv!.pid);
    } finally {
      for (const k of kids) k.kill("SIGKILL");
    }
  }, 40_000);
});

describe("tickets over the wire", () => {
  test("a ticket opens the dashboard and is exchanged for the durable cookie", async () => {
    const { mintTicket } = await import("../src/dashboard/auth.ts");
    const h = serve();
    const res = await fetch(`http://127.0.0.1:${h.port}/?k=${mintTicket(h.token)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain(h.token);
    // and the credential is gone from the address bar
    expect(res.headers.get("location")).not.toContain("k=");
  });

  test("an expired ticket is refused", async () => {
    const { mintTicket } = await import("../src/dashboard/auth.ts");
    const h = serve();
    const stale = mintTicket(h.token, Date.now() - 120_000);
    const res = await fetch(`http://127.0.0.1:${h.port}/?k=${stale}`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});
