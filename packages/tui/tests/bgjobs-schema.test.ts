import { describe, expect, test } from "bun:test";
import type { ToolResult } from "../src/agent/tools.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { configFromEnv } from "../src/minima/config.ts";
import { bashTool } from "../src/tools/bash.ts";
import { builtinTools } from "../src/tools/index.ts";

// Behavioral reds against EXISTING surfaces only (no new-module imports): the config
// flag default, the bg_jobs table via sqlite_master, and the <1s launch handle. The
// AC1 launch red flips green once bash is wired to a real BgJobRegistry.

function body(res: ToolResult): string {
  return (res.content[0] as { text: string }).text;
}

describe("bgjobs schema/config (W4.1)", () => {
  test("AC1: bash background:true returns a job handle in <1.5s", async () => {
    const bash = builtinTools().find((t) => t.name === "bash");
    if (!bash) throw new Error("bash tool missing");
    const parsed = bash.parameters.validate({
      command: "sleep 30; echo late",
      background: true,
      timeout: 2000,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const t0 = performance.now();
    const res = await bash.execute("t", parsed.value, null, null);
    const elapsed = performance.now() - t0;
    expect(body(res)).toContain("background job");
    expect(elapsed).toBeLessThan(1500);
    expect(res.details?.job_id).toBeDefined();
    expect(res.details?.background).toBe(true);
  }, 20000);

  test("AC2: a fresh DB has the bg_jobs table", () => {
    const db = new MinimaDb(":memory:");
    const row = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bg_jobs'")
      .get();
    expect(row).not.toBeNull();
    db.db.close();
  });

  test("AC3: MINIMA_TUI_BGJOBS defaults on; flag-off keeps bash byte-identical, drops bgjob", () => {
    const saved = process.env.MINIMA_TUI_BGJOBS;
    delete process.env.MINIMA_TUI_BGJOBS;
    try {
      expect(configFromEnv().bgJobs).toBe(true);
      process.env.MINIMA_TUI_BGJOBS = "0";
      expect(configFromEnv().bgJobs).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MINIMA_TUI_BGJOBS;
      else process.env.MINIMA_TUI_BGJOBS = saved;
    }
    // Flag-off byte-identity: a registry-less bash carries no `background` prop and the
    // default roster has no `bgjob` tool.
    const props = (bashTool().parameters.jsonSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props)).not.toContain("background");
    expect(builtinTools().map((t) => t.name)).not.toContain("bgjob");
  });
});
