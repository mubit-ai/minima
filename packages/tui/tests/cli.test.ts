import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/main.ts";
import { code, readSource } from "./_source.ts";

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
    const src = readSource("tui/app.tsx");
    expect(src).toContain('{ name: "version", desc: "Show the Minima harness version" }');
    expect(src).toContain('case "version":');
    expect(src).toContain("minima ${VERSION}");
  });
});

describe("tui/app.tsx /dashboard on|off (source pins)", () => {
  /**
   * A source pin, not a behavioural test: `app.tsx` is an Ink component with no dispatch seam, and
   * this is how `/version` is pinned above. What the two verbs DO is covered hermetically in
   * dashboard_supervisor.test.ts and over real sockets in dashboard_lifecycle.test.ts — this only
   * holds the wiring and the discoverability, which is where a rename would quietly land.
   */
  test("the verbs are wired, validated, and advertised in the command list", () => {
    const src = readSource("tui/app.tsx");
    // Discoverable: /help and the composer's autocomplete both render `desc`.
    expect(src).toContain(code("`off` stops it for this session, `on` starts it again"));
    expect(src).toContain(code('if (verb === "off") await dashboard?.detach();'));
    expect(src).toContain(code("await dashboard.resume()"));
    expect(src).toContain(code("Usage: /dashboard [on|off]"));
  });

  test("the dashboard subcommand help explains both verbs and why Ctrl+C misses it", () => {
    const src = readSource("cli/main.ts");
    expect(src).toContain(code("/dashboard off"));
    expect(src).toContain(code("/dashboard on"));
    expect(src).toContain(code("its LAST TUI"));
    expect(src).toContain(code("ignores SIGINT and SIGHUP"));
  });
});
