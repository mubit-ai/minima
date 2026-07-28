/**
 * Dashboard lifecycle, the parts provable without a socket: the rendezvous file, what counts as
 * "the same ledger", the pid-dead vs pid-alive-but-wedged split, and the bind-is-the-mutex race.
 *
 * Hermetic — a temp state dir, injected probe/spawn/clock, no listening socket and no child
 * processes. The claims that CANNOT be made honestly here (a keepalive actually arriving, a client
 * dying by kill -9, an idle server actually exiting) live in dashboard_lifecycle.test.ts, which
 * binds a real port on purpose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTicket, ticketValid } from "../src/dashboard/auth.ts";
import {
  type DashboardState,
  type Health,
  type Rendezvous,
  bindWithProbe,
  clearRendezvous,
  dashboardReport,
  discover,
  findServing,
  isAddrInUse,
  isCompiledBinary,
  managedArgv,
  pidAlive,
  readRendezvous,
  rendezvousPath,
  resolveLedger,
  writeRendezvous,
} from "../src/dashboard/supervisor.ts";

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minima-sup-"));
  ledger = join(dir, "minima.db");
  writeFileSync(ledger, "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rv = (over: Partial<Rendezvous> = {}): Rendezvous => ({
  ledger,
  port: 4180,
  token: "tok",
  pid: process.pid,
  startedAt: 1_700_000_000_000,
  ...over,
});

const healthy = (over: Partial<Health> = {}): Health => ({ ok: true, ledger, ...over });
const noSleep = async (): Promise<void> => {};

describe("ledger identity", () => {
  test("a symlinked ledger and its target key to ONE server", () => {
    const link = join(dir, "link.db");
    symlinkSync(ledger, link);
    expect(resolveLedger(link).path).toBe(resolveLedger(ledger).path);
    expect(rendezvousPath(resolveLedger(link).path, dir)).toBe(
      rendezvousPath(resolveLedger(ledger).path, dir),
    );
  });

  test("the same relative path in two cwds keys to TWO servers, not one", () => {
    // The bug this exists to prevent: MINIMA_DB_PATH=./x.db is used verbatim by defaultDbPath(),
    // so without resolution two TUIs in different directories hash identically AND report the same
    // string over /healthz — the ledger-match check passes while the files differ. Silent.
    const cwd = process.cwd();
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    try {
      process.chdir(dir);
      const a = resolveLedger("./x.db");
      process.chdir(sub);
      const b = resolveLedger("./x.db");
      expect(a.path.startsWith("/")).toBe(true);
      expect(a.path).not.toBe(b.path);
      expect(rendezvousPath(a.path, dir)).not.toBe(rendezvousPath(b.path, dir));
    } finally {
      process.chdir(cwd);
    }
  });

  test("/tmp and /private/tmp collapse (macOS), and a not-yet-created ledger keys stably", () => {
    const missing = join(dir, "later.db");
    const before = resolveLedger(missing).path;
    writeFileSync(missing, "");
    expect(resolveLedger(missing).path).toBe(before);
    // dir itself came from tmpdir(); on macOS that is under /var -> /private/var.
    expect(resolveLedger(dir).via).toBe("realpath");
  });

  test("distinct ledgers get distinct rendezvous files", () => {
    expect(rendezvousPath("/a/minima.db", dir)).not.toBe(rendezvousPath("/b/minima.db", dir));
  });
});

describe("rendezvous file", () => {
  test("round-trips and is 0600 from birth — it carries a bearer token", async () => {
    const path = rendezvousPath(ledger, dir);
    await writeRendezvous(path, rv());
    expect(await readRendezvous(path)).toEqual(rv());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("malformed or truncated content reads as absent, never as a half-server", async () => {
    const path = join(dir, "bad.json");
    await mkdir(dir, { recursive: true });
    writeFileSync(path, "{ not json");
    expect(await readRendezvous(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ ledger, port: 4180 }));
    expect(await readRendezvous(path)).toBeNull();
  });

  test("deleted only when it still names us — a displaced server must not evict the live one", async () => {
    const path = rendezvousPath(ledger, dir);
    await writeRendezvous(path, rv({ pid: 424_242 }));
    expect(await clearRendezvous(path, process.pid)).toBe(false);
    expect(await readRendezvous(path)).not.toBeNull();
    expect(await clearRendezvous(path, 424_242)).toBe(true);
    expect(await readRendezvous(path)).toBeNull();
  });
});

describe("pidAlive", () => {
  test("this process is alive; pid 1 and nonsense are never treated as a client", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(1)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-3)).toBe(false);
    expect(pidAlive(2_147_483_000)).toBe(false);
  });
});

describe("discover", () => {
  const path = () => rendezvousPath(ledger, dir);

  test("no file at all → stale, and nothing is guessed", async () => {
    const d = await discover({ ledger, path: path(), probe: async () => null, sleep: noSleep });
    expect(d.kind).toBe("stale");
    expect(d.rv).toBeNull();
  });

  test("live server on the recorded port → live, no spawn needed", async () => {
    await writeRendezvous(path(), rv());
    const d = await discover({
      ledger,
      path: path(),
      probe: async () => healthy(),
      sleep: noSleep,
    });
    expect(d.kind).toBe("live");
  });

  test("a server answering with a DIFFERENT ledger is stale, not live", async () => {
    await writeRendezvous(path(), rv());
    const d = await discover({
      ledger,
      path: path(),
      probe: async () => healthy({ ledger: "/somewhere/else.db" }),
      sleep: noSleep,
    });
    expect(d.kind).toBe("stale");
  });

  test("recorded pid GONE → stale (safe silent takeover)", async () => {
    await writeRendezvous(path(), rv({ pid: 2_147_483_000 }));
    const d = await discover({ ledger, path: path(), probe: async () => null, sleep: noSleep });
    expect(d.kind).toBe("stale");
    if (d.kind === "stale") expect(d.reason).toContain("is gone");
  });

  test("recorded pid ALIVE but silent → wedged, and the reason names the holder", async () => {
    await writeRendezvous(path(), rv({ pid: process.pid, port: 4187 }));
    const d = await discover({ ledger, path: path(), probe: async () => null, sleep: noSleep });
    expect(d.kind).toBe("wedged");
    if (d.kind === "wedged") {
      expect(d.reason).toContain("4187");
      expect(d.reason).toContain(`pid ${process.pid}`);
    }
  });

  test("a slow server is retried before being declared dead", async () => {
    await writeRendezvous(path(), rv());
    let calls = 0;
    const d = await discover({
      ledger,
      path: path(),
      probe: async () => (++calls < 3 ? null : healthy()),
      sleep: noSleep,
    });
    expect(calls).toBe(3);
    expect(d.kind).toBe("live");
  });

  test("one probe is not enough to displace a server: tries=1 would have called it wedged", async () => {
    await writeRendezvous(path(), rv());
    let calls = 0;
    const d = await discover({
      ledger,
      path: path(),
      probe: async () => (++calls < 3 ? null : healthy()),
      tries: 1,
      sleep: noSleep,
    });
    expect(d.kind).toBe("wedged");
  });
});

describe("findServing — the check a rendezvous file cannot make", () => {
  // A child binds and only THEN publishes, so "nothing recorded" does not mean "nothing serving".
  // Two children racing on that assumption gave one ledger three servers at once.
  const probeOf = (map: Record<number, string>): ((p: number) => Promise<Health | null>) => {
    return async (p) => (map[p] ? { ok: true, ledger: map[p]! } : null);
  };

  test("finds a live server for this ledger even with nothing published", async () => {
    const found = await findServing([4180, 4181, 4182], ledger, probeOf({ 4182: ledger }));
    expect(found?.port).toBe(4182);
  });

  test("ignores a server on another ledger — that one is not ours to share", async () => {
    expect(await findServing([4180, 4181], ledger, probeOf({ 4180: "/other.db" }))).toBeNull();
  });

  test("returns the FIRST match so the scan is deterministic", async () => {
    const found = await findServing(
      [4180, 4181, 4182],
      ledger,
      probeOf({ 4181: ledger, 4182: ledger }),
    );
    expect(found?.port).toBe(4181);
  });

  test("an empty range is null, not a throw", async () => {
    expect(await findServing([], ledger, probeOf({}))).toBeNull();
  });
});

describe("bindWithProbe — the bind is the mutex", () => {
  test("takes the first port and reports nothing skipped", async () => {
    const r = await bindWithProbe({ ports: [4180, 4181], start: (p) => `on:${p}` });
    expect(r).toEqual({ kind: "bound", handle: "on:4180", port: 4180, skipped: [] });
  });

  test("EADDRINUSE walks the range and hands the skipped list to the server", async () => {
    const seen: number[][] = [];
    const r = await bindWithProbe({
      ports: [4180, 4181, 4182],
      start: (p, skipped) => {
        seen.push(skipped);
        if (p < 4182) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
        return `on:${p}`;
      },
    });
    expect(r.kind).toBe("bound");
    if (r.kind === "bound") {
      expect(r.port).toBe(4182);
      expect(r.skipped).toEqual([4180, 4181]);
    }
    expect(seen.at(-1)).toEqual([4180, 4181]);
  });

  test("yields when another server publishes while we walk the range", async () => {
    const r = await bindWithProbe({
      ports: [4180, 4181],
      onFallback: async () => true,
      start: (p) => {
        if (p === 4180) throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
        return `on:${p}`;
      },
    });
    expect(r.kind).toBe("yielded");
  });

  test("the whole range taken is exhausted — never a silent no-op", async () => {
    const r = await bindWithProbe({
      ports: [4180, 4181],
      start: () => {
        throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
      },
    });
    expect(r).toEqual({ kind: "exhausted", skipped: [4180, 4181] });
  });

  test("a non-port error is NOT swallowed as a busy port", async () => {
    await expect(
      bindWithProbe({
        ports: [4180],
        start: () => {
          throw new Error("cannot open the harness ledger");
        },
      }),
    ).rejects.toThrow("ledger");
  });

  test("isAddrInUse matches Bun's shape and does not over-match", () => {
    expect(isAddrInUse({ code: "EADDRINUSE" })).toBe(true);
    expect(isAddrInUse(new Error("Failed to start server. Is port 4180 in use?"))).toBe(false);
    expect(isAddrInUse(new Error("address already in use"))).toBe(true);
    expect(isAddrInUse(new Error("EACCES"))).toBe(false);
  });
});

describe("managed argv — two builds, two shapes", () => {
  test("a compiled binary re-enters itself; dev passes the entry to bun", () => {
    expect(isCompiledBinary("/$bunfs/root/minima")).toBe(true);
    expect(isCompiledBinary("/opt/homebrew/bin/minima")).toBe(true);
    expect(isCompiledBinary("/repo/packages/tui/src/cli/main.ts")).toBe(false);

    const compiled = managedArgv("/l.db", "/$bunfs/root/minima");
    expect(compiled.slice(1)).toEqual(["dashboard", "--managed", "--db", "/l.db"]);
    const dev = managedArgv("/l.db", "/repo/src/cli/main.ts");
    expect(dev[1]).toBe("/repo/src/cli/main.ts");
    expect(dev.slice(2)).toEqual(["dashboard", "--managed", "--db", "/l.db"]);
  });

  test("the ledger is passed explicitly, so the child never re-derives a relative path", () => {
    expect(managedArgv("./rel.db", "/$bunfs/root/minima")).toContain("./rel.db");
  });
});

describe("what /dashboard prints", () => {
  const state = (over: Partial<DashboardState> = {}): DashboardState => ({
    status: "attached",
    reason: null,
    url: "http://127.0.0.1:4181/?k=exp.mac",
    port: 4181,
    ledger,
    serverPid: 4242,
    startedAt: 1_700_000_000_000,
    portNote: null,
    clients: 3,
    ...over,
  });
  const text = (...args: Parameters<typeof dashboardReport>) => dashboardReport(...args).join("\n");

  test("the happy line carries the URL, the ledger, the port and who is attached", () => {
    const out = text(state(), { age: () => "14m ago" });
    expect(out).toContain("?k=");
    expect(out).toContain("valid 60s");
    expect(out).toContain(ledger);
    expect(out).toContain("port     4181");
    expect(out).toContain("3 attached");
    expect(out).toContain("server pid 4242");
    expect(out).toContain("started 14m ago");
  });

  test("a non-default port always explains itself", () => {
    const out = text(state({ portNote: "4180 already in use — pid 32357 is not answering" }));
    expect(out).toContain("4181 — 4180 already in use");
    expect(out).toContain("32357");
  });

  test("no dashboard at all says WHY, and the two reasons are different", () => {
    expect(text(null, { disabled: true })).toContain("MINIMA_TUI_DASHBOARD=0");
    expect(text(null, { disabled: false })).toContain("nothing to serve");
    expect(text(null)).toContain("minima dashboard --open");
  });

  test("unreachable leads with the reason and never prints a dead URL", () => {
    const out = text(
      state({ url: null, status: "reconnecting", reason: "the dashboard did not come up" }),
    );
    expect(out).toContain("not reachable");
    expect(out).toContain("did not come up");
    expect(out).not.toContain("http://");
  });

  test("an unknown client count is omitted rather than printed as null or 0", () => {
    const out = text(state({ clients: null }));
    expect(out).not.toContain("null");
    expect(out).not.toContain("0 attached");
  });
});

describe("tickets", () => {
  test("a fresh ticket validates and the durable token is not in it", () => {
    const token = "s3cret-token-value";
    const k = mintTicket(token, 1_000);
    expect(ticketValid(token, k, 1_000)).toBe(true);
    expect(k).not.toContain(token);
  });

  test("expiry is enforced, and a ticket for another token never validates", () => {
    const k = mintTicket("token-a", 1_000);
    expect(ticketValid("token-a", k, 1_000 + 60_001)).toBe(false);
    expect(ticketValid("token-b", k, 1_000)).toBe(false);
  });

  test("a forged far-future expiry is rejected even with a valid-looking shape", () => {
    const token = "t";
    const k = mintTicket(token, 1_000, 10 * 60_000);
    expect(ticketValid(token, k, 1_000)).toBe(false);
  });

  test("garbage is rejected without throwing", () => {
    for (const bad of ["", ".", "abc", "12345", "12345.", ".mac", "NaN.mac"]) {
      expect(ticketValid("t", bad, 1_000)).toBe(false);
    }
  });
});
