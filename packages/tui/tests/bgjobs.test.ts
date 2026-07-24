import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { BgJobRegistry } from "../src/tools/_bgjobs.ts";
import { ArtifactStore } from "../src/tools/_artifacts.ts";
import { bashTool } from "../src/tools/bash.ts";
import { bgJobTool } from "../src/tools/bgjob.ts";

const AWK_20K = `awk 'BEGIN { for (i=0;i<20000;i++) printf "line %06d abcdefghijklmnopqrstuvwxyz\\n", i }'`;

const cleanups: (() => void)[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best-effort teardown
    }
  }
});

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return Boolean(await cond());
}

describe("bgjobs lifecycle (W4.1)", () => {
  test("AC4: a bg job is pollable and killable — the whole group dies, the row is killed", async () => {
    const dir = tempDir("bgjobs-ac4-");
    const db = new MinimaDb(":memory:");
    const registry = new BgJobRegistry();
    registry.attach(db, "run-ac4");
    const bash = bashTool({ bgJobs: registry });
    const bgjob = bgJobTool(registry);
    const pidfile = join(dir, "pid");
    const res = await bash.execute(
      "t",
      { command: `sleep 30 & echo $! > ${pidfile}; wait`, background: true },
      null,
      null,
    );
    const id = String(res.details?.job_id);
    expect(id.startsWith("bg_")).toBe(true);

    const st = await bgjob.execute("t", { action: "status", id }, null, null);
    expect(body(st)).toContain("running");

    expect(await waitFor(() => existsSync(pidfile), 4000)).toBe(true);
    const gpid = Number(readFileSync(pidfile, "utf8").trim());
    expect(Number.isFinite(gpid)).toBe(true);
    expect(alive(gpid)).toBe(true);

    await bgjob.execute("t", { action: "kill", id }, null, null);
    expect(await waitFor(() => !alive(gpid), 4000)).toBe(true);

    const row = db.db.query("SELECT state FROM bg_jobs WHERE id = ?").get(id) as { state: string };
    expect(row.state).toBe("killed");
    registry.shutdown();
    db.db.close();
  }, 20000);

  test("AC5: output is bounded mid-run and spills a GC-claimed artifact under the run", async () => {
    const artDir = join(tempDir("bgjobs-ac5-"), "artifacts");
    const db = new MinimaDb(":memory:");
    const store = new ArtifactStore({ dir: artDir });
    store.attach(db, "run-ac5");
    const registry = new BgJobRegistry();
    registry.attach(db, "run-ac5");
    const bash = bashTool({ bgJobs: registry, artifacts: store });
    const bgjob = bgJobTool(registry);

    const res = await bash.execute(
      "t",
      { command: `${AWK_20K}; sleep 30`, background: true },
      null,
      null,
    );
    const id = String(res.details?.job_id);

    // Mid-run: the whole 20k-line torrent has streamed but output stays bounded.
    expect(
      await waitFor(async () => {
        const o = body(await bgjob.execute("t", { action: "output", id }, null, null));
        return o.includes("line 019999");
      }, 6000),
    ).toBe(true);
    const out = body(await bgjob.execute("t", { action: "output", id }, null, null));
    expect(out.length).toBeLessThan(65_000);
    expect(out).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(out).toContain("line 000000");

    // Kill → finalize commits the truncated buffer as a spilled artifact.
    await bgjob.execute("t", { action: "kill", id }, null, null);
    const row = db.db
      .query("SELECT state, spill_ref, output_chars, truncated FROM bg_jobs WHERE id = ?")
      .get(id) as {
      state: string;
      spill_ref: string | null;
      output_chars: number;
      truncated: number;
    };
    expect(row.state).toBe("killed");
    expect(row.truncated).toBe(1);
    expect(row.output_chars).toBeGreaterThan(50_000);
    expect(row.spill_ref).toBeTruthy();
    expect(existsSync(row.spill_ref ?? "")).toBe(true);
    const full = readFileSync(row.spill_ref ?? "", "utf8");
    expect(full.length).toBeGreaterThan(50_000);

    // W3.3 exemption: the artifact row carries the CURRENT run id.
    const art = db.db.query("SELECT run_id FROM artifacts").all() as { run_id: string }[];
    expect(art.length).toBeGreaterThan(0);
    expect(art.some((r) => r.run_id === "run-ac5")).toBe(true);

    registry.shutdown();
    db.db.close();
  }, 20000);

  test("AC6: aborting the launching run's signal kills the job's group, row killed", async () => {
    const dir = tempDir("bgjobs-ac6-");
    const db = new MinimaDb(":memory:");
    const registry = new BgJobRegistry();
    registry.attach(db, "run-ac6");
    const bash = bashTool({ bgJobs: registry });
    const controller = new AbortController();
    const pidfile = join(dir, "pid");
    const res = await bash.execute(
      "t",
      { command: `sleep 30 & echo $! > ${pidfile}; wait`, background: true },
      controller.signal,
      null,
    );
    const id = String(res.details?.job_id);
    expect(await waitFor(() => existsSync(pidfile), 4000)).toBe(true);
    const gpid = Number(readFileSync(pidfile, "utf8").trim());
    expect(alive(gpid)).toBe(true);

    controller.abort();
    expect(await waitFor(() => !alive(gpid), 4000)).toBe(true);
    expect(
      await waitFor(() => {
        const row = db.db.query("SELECT state FROM bg_jobs WHERE id = ?").get(id) as {
          state: string;
        };
        return row.state === "killed";
      }, 4000),
    ).toBe(true);
    registry.shutdown();
    db.db.close();
  }, 20000);

  test("a clean background job exits; wait + output report the code and stdout", async () => {
    const db = new MinimaDb(":memory:");
    const registry = new BgJobRegistry();
    registry.attach(db, "run-clean");
    const bash = bashTool({ bgJobs: registry });
    const bgjob = bgJobTool(registry);
    const res = await bash.execute("t", { command: "echo hello-bg", background: true }, null, null);
    const id = String(res.details?.job_id);
    const w = await bgjob.execute("t", { action: "wait", id, timeout: 5000 }, null, null);
    expect(body(w)).toContain("exited");
    const o = await bgjob.execute("t", { action: "output", id }, null, null);
    expect(body(o)).toContain("hello-bg");
    const row = db.db.query("SELECT state, exit_code FROM bg_jobs WHERE id = ?").get(id) as {
      state: string;
      exit_code: number;
    };
    expect(row.state).toBe("exited");
    expect(row.exit_code).toBe(0);
    registry.shutdown();
    db.db.close();
  }, 15000);

  test("the concurrent-running cap (16) rejects the 17th launch with an error result", async () => {
    const registry = new BgJobRegistry();
    const bash = bashTool({ bgJobs: registry });
    try {
      for (let i = 0; i < 16; i++) {
        const r = await bash.execute("t", { command: "sleep 30", background: true }, null, null);
        expect(r.details?.job_id).toBeDefined();
      }
      const over = await bash.execute("t", { command: "sleep 30", background: true }, null, null);
      expect(over.details?.error).toBe(true);
      expect(body(over)).toContain("too many background jobs");
    } finally {
      registry.shutdown();
    }
  }, 20000);

  test("bgjob rejects a non-list action without an id, and unknown ids", async () => {
    const registry = new BgJobRegistry();
    const bgjob = bgJobTool(registry);
    const missing = bgjob.parameters.validate({ action: "status" });
    expect(missing.ok).toBe(false);
    const list = await bgjob.execute("t", { action: "list" }, null, null);
    expect(body(list)).toBe("no background jobs");
    const bad = await bgjob.execute("t", { action: "status", id: "bg_nope1234" }, null, null);
    expect(bad.details?.error).toBe(true);
  });
});
