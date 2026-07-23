import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/main.ts";

describe("parseArgs --resume (B1)", () => {
  test("--resume captures the name-or-id and composes with other flags", () => {
    const args = parseArgs(["--resume", "demo run", "--offline"]);
    expect(args.resume).toBe("demo run");
    expect(args.offline).toBe(true);
  });

  test("--resume without a value throws (never silently ignored)", () => {
    expect(() => parseArgs(["--resume"])).toThrow("requires a value");
  });

  test("omitted → undefined (fresh session)", () => {
    expect(parseArgs([]).resume).toBeUndefined();
  });
});

describe("parseArgs renderer flags are gone (MP3, MUB-146 — inline is the only renderer)", () => {
  test("CliArgs carries no fullscreen field and no renderer flags parse", () => {
    expect("fullscreen" in parseArgs([])).toBe(false);
  });
});

describe("parseArgs -v/--version and --experimental", () => {
  test("--experimental sets the flag; omitted leaves it unset", () => {
    expect(parseArgs(["--experimental"]).experimental).toBe(true);
    expect(parseArgs([]).experimental).toBeUndefined();
  });

  test("VERSION_LINE is the single-line package version scripts can parse", async () => {
    const { VERSION_LINE } = await import("../src/cli/main.ts");
    const { VERSION } = await import("../src/version.ts");
    expect(VERSION_LINE).toBe(`minima ${VERSION}`);
    expect(VERSION_LINE).not.toContain("\n");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("buildConfig --experimental turns on the umbrella", () => {
  test("unset opt-in features ride the umbrella; an explicit env 0 still wins", async () => {
    const { buildConfig } = await import("../src/cli/main.ts");
    const prevUmbrella = process.env.MINIMA_TUI_EXPERIMENTAL;
    const prevObserver = process.env.MINIMA_TUI_OBSERVER;
    try {
      delete process.env.MINIMA_TUI_EXPERIMENTAL;
      process.env.MINIMA_TUI_OBSERVER = "0";
      const cfg = buildConfig(parseArgs(["--experimental"]));
      expect(cfg.experimental).toBe(true);
      expect(cfg.tuner).toBe(true);
      expect(cfg.observer).toBe(false);
    } finally {
      if (prevUmbrella === undefined) delete process.env.MINIMA_TUI_EXPERIMENTAL;
      else process.env.MINIMA_TUI_EXPERIMENTAL = prevUmbrella;
      if (prevObserver === undefined) delete process.env.MINIMA_TUI_OBSERVER;
      else process.env.MINIMA_TUI_OBSERVER = prevObserver;
    }
  });

  test("without the flag the env alone decides", async () => {
    const { buildConfig } = await import("../src/cli/main.ts");
    const prev = process.env.MINIMA_TUI_EXPERIMENTAL;
    try {
      delete process.env.MINIMA_TUI_EXPERIMENTAL;
      expect(buildConfig(parseArgs([])).experimental).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MINIMA_TUI_EXPERIMENTAL;
      else process.env.MINIMA_TUI_EXPERIMENTAL = prev;
    }
  });
});

describe("tui/app.tsx /version command (source pins)", () => {
  test("registered in COMMANDS, dispatched, and prints the harness version", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");
    expect(src).toContain('{ name: "version", desc: "Show the Minima harness version" }');
    expect(src).toContain('case "version":');
    expect(src).toContain("minima ${VERSION}");
  });
});
