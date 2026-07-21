import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash.ts";

// Default-path fix: a timed-out bash command only signaled the bash LEADER, so its
// grandchildren survived and ran unbounded — the same orphan bug the Big Plan check runner had.
// Clean exits are untouched (deliberately started daemons live).

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
    await Bun.sleep(20);
  }
  return cond();
}

describe("bash tool: process-group kill on timeout", () => {
  test("a timed-out command's grandchild dies with the group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bash-group-"));
    try {
      const pidfile = join(dir, "pid");
      const tool = bashTool();
      const res = await tool.execute(
        "t1",
        { command: `sleep 30 & echo $! > ${pidfile}; wait`, timeout: 300 },
        null,
        null,
      );
      expect((res.content[0] as { text: string }).text).toContain("timed out");
      const gpid = Number(readFileSync(pidfile, "utf8").trim());
      expect(Number.isFinite(gpid)).toBe(true);
      expect(await waitFor(() => !alive(gpid), 4000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("a clean exit leaves no error and reports the exit code", async () => {
    const tool = bashTool();
    const res = await tool.execute("t2", { command: "echo ok", timeout: 5000 }, null, null);
    expect((res.content[0] as { text: string }).text).toContain("ok");
    expect(res.details?.exit_code).toBe(0);
  });
});
