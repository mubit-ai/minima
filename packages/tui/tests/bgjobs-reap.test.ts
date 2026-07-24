import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";
import { BgJobRegistry, type BgJobProbes } from "../src/tools/_bgjobs.ts";

// Simulated restart: gen-1 launches a real `sleep 30` and records a `running` row, then
// "crashes" (dropped, never shut down). gen-2 attaches under a NEW run and reaps. The
// three guards are exercised with injected probes so the identity-match / pid-reuse /
// concurrent-session branches are all deterministic on darwin + Linux CI.

const dirs: string[] = [];
const groupsToKill: number[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bgjobs-reap-"));
  dirs.push(dir);
  return join(dir, "minima.db");
}
afterEach(() => {
  for (const pgid of groupsToKill.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

/** A pid that is definitely dead: spawn `true`, await its exit, reuse the reaped pid. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
}

function realProbes(overrides: Partial<BgJobProbes>): BgJobProbes {
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
      const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
      if (!r.success) return null;
      return new TextDecoder().decode(r.stdout).trim() || null;
    },
    harnessPid: process.pid,
    ...overrides,
  };
}

function launchSleep(reg: BgJobRegistry): { id: string; pid: number } {
  const res = reg.launch({ command: "sleep 30", cwd: undefined, signal: null });
  const id = String(res.details?.job_id);
  const pid = Number(res.details?.pid);
  groupsToKill.push(pid);
  return { id, pid };
}

function rowState(db: MinimaDb, id: string): string | null {
  const row = db.db.query("SELECT state FROM bg_jobs WHERE id = ?").get(id) as {
    state: string;
  } | null;
  return row?.state ?? null;
}

describe("bgjobs startup reaper (W4.1 · AC7)", () => {
  test("identity-matched orphan is killed and marked orphaned", async () => {
    const db = new MinimaDb(tempDbPath());
    const dead = await deadPid();
    const gen1 = new BgJobRegistry({ probes: realProbes({ harnessPid: dead }) });
    gen1.attach(db, "gen1-run");
    const { id, pid } = launchSleep(gen1);
    expect(alive(pid)).toBe(true);

    // gen-2: all real probes, live harness. The row's harness_pid (dead) fails guard 1,
    // the group is live (guard 2), real `ps` matches the command (guard 3) → true orphan.
    const gen2 = new BgJobRegistry({ probes: realProbes({}) });
    gen2.attach(db, "gen2-run");

    expect(rowState(db, id)).toBe("orphaned");
    expect(await waitFor(() => !alive(pid), 4000)).toBe(true);
    db.db.close();
  }, 15000);

  test("a reused PID is marked lost and NEVER signaled (zero kills)", async () => {
    const db = new MinimaDb(tempDbPath());
    const dead = await deadPid();
    const gen1 = new BgJobRegistry({ probes: realProbes({ harnessPid: dead }) });
    gen1.attach(db, "gen1-run");
    const { id, pid } = launchSleep(gen1);

    // gen-2's identity probe reports an unrelated command → PID reuse, must not signal.
    const gen2 = new BgJobRegistry({
      probes: realProbes({ commandOf: () => "some-unrelated-daemon --serve" }),
    });

    const realKill = process.kill.bind(process);
    let realSignals = 0;
    // Spy: count only real signals (liveness probes use signal 0).
    (process as unknown as { kill: typeof process.kill }).kill = ((
      p: number,
      sig?: string | number,
    ) => {
      if (sig !== 0 && sig !== undefined) realSignals += 1;
      return realKill(p, sig as never);
    }) as typeof process.kill;
    try {
      gen2.attach(db, "gen2-run");
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = realKill;
    }

    expect(rowState(db, id)).toBe("lost");
    expect(realSignals).toBe(0);
    expect(alive(pid)).toBe(true); // the (supposedly reused) process is untouched
    db.db.close();
  }, 15000);

  test("a live-harness row (concurrent session) is left untouched", async () => {
    const db = new MinimaDb(tempDbPath());
    // gen-1's harness pid is THIS process — still alive → concurrent-session guard skips it.
    const gen1 = new BgJobRegistry({ probes: realProbes({ harnessPid: process.pid }) });
    gen1.attach(db, "gen1-run");
    const { id, pid } = launchSleep(gen1);

    const gen2 = new BgJobRegistry({ probes: realProbes({}) });
    gen2.attach(db, "gen2-run");

    expect(rowState(db, id)).toBe("running");
    expect(alive(pid)).toBe(true);
    gen1.shutdown();
    db.db.close();
  }, 15000);
});
