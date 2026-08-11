import { describe, expect, test } from "bun:test";
import { parseArgs, resolveBudget } from "../src/cli/main.ts";
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

describe("resolveBudget — where the env layers' ceiling lands", () => {
  // The clamp itself lives in the loader (see project-config.test.ts); by the time a value
  // reaches here it is already the safer one, so this only pins the flags-over-env order.
  test("no flag and no env → no ledger, warn mode", () => {
    const r = resolveBudget(parseArgs([]), {});
    expect(r.limitUsd).toBeUndefined();
    expect(r.mode).toBe("warn");
  });

  test("MINIMA_BUDGET_USD creates a ceiling without a flag", () => {
    expect(resolveBudget(parseArgs([]), { MINIMA_BUDGET_USD: "2.5" }).limitUsd).toBe(2.5);
  });

  test("--budget wins over the env layers (the user acting now)", () => {
    const r = resolveBudget(parseArgs(["--budget", "9"]), { MINIMA_BUDGET_USD: "2.5" });
    expect(r.limitUsd).toBe(9);
  });

  test("an unusable ceiling is treated as unset, never coerced", () => {
    for (const bad of ["nope", "0", "-1", ""]) {
      expect(resolveBudget(parseArgs([]), { MINIMA_BUDGET_USD: bad }).limitUsd).toBeUndefined();
    }
  });

  test("MINIMA_BUDGET_MODE sets the mode; --budget-enforce still wins; junk falls back", () => {
    expect(resolveBudget(parseArgs([]), { MINIMA_BUDGET_MODE: "enforce" }).mode).toBe("enforce");
    expect(resolveBudget(parseArgs([]), { MINIMA_BUDGET_MODE: "shadow" }).mode).toBe("shadow");
    expect(resolveBudget(parseArgs([]), { MINIMA_BUDGET_MODE: "loose" }).mode).toBe("warn");
    expect(
      resolveBudget(parseArgs(["--budget-enforce"]), { MINIMA_BUDGET_MODE: "shadow" }).mode,
    ).toBe("enforce");
  });
});

describe("parseArgs renderer flags (opt-in fullscreen, ADR 2026-07-31 amendment)", () => {
  test("tri-state: unset by default; --fullscreen true; --inline/--no-fullscreen false", () => {
    // undefined = no explicit choice — main() falls back to env, then the persisted
    // per-project /fullscreen pref, then the inline default.
    expect(parseArgs([]).fullscreen).toBeUndefined();
    expect(parseArgs(["--fullscreen"]).fullscreen).toBe(true);
    expect(parseArgs(["--inline"]).fullscreen).toBe(false);
    expect(parseArgs(["--no-fullscreen"]).fullscreen).toBe(false);
    expect(parseArgs(["--fullscreen", "--inline"]).fullscreen).toBe(false); // last wins
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

describe("`minima acp` — the subcommand's argument grammar (MUB-239)", () => {
  // The acp branch of main() returns before the bootstrap builds anything, so these are safe to
  // drive directly: no DB, no provider, no stdin. Serving is covered end to end through the ACP
  // seam (acp-e2e.test.ts); what is pinned here is the entry point's refusals, which is the half
  // that would otherwise be discovered by a user typing the wrong thing at a stalled process.
  const stderrOf = async (argv: string[]): Promise<{ code: number; err: string }> => {
    const { main } = await import("../src/cli/main.ts");
    const original = process.stderr.write.bind(process.stderr);
    let err = "";
    // A narrow test double for the two write signatures.
    process.stderr.write = (chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    };
    try {
      return { code: await main(argv), err };
    } finally {
      process.stderr.write = original;
    }
  };

  test("a prompt is refused — the editor sends prompts, the command line does not", async () => {
    const { code, err } = await stderrOf(["acp", "fix the bug"]);
    expect(code).toBe(2);
    expect(err).toContain("takes no prompt");
  });

  test("combining it with an output mode is refused rather than silently ignored", async () => {
    expect((await stderrOf(["acp", "--print"])).code).toBe(2);
    const { code, err } = await stderrOf(["acp", "--mode", "json"]);
    expect(code).toBe(2);
    expect(err).toContain("cannot be combined");
  });

  test("`acp` is a subcommand, not a flag or an output mode", () => {
    // The rejected alternatives, pinned: a fourth --mode value would have meant "run this one
    // prompt and render it this way" for something that takes no prompt, and a bare --acp flag
    // would add a third invocation grammar beside the existing subcommands.
    expect(() => parseArgs(["--acp"])).toThrow("unknown flag");
    expect(parseArgs(["acp"]).prompt).toEqual(["acp"]); // a bare positional to parseArgs itself
    const src = readSource("cli/main.ts");
    expect(src).toContain('const acp = argv[0] === "acp";');
  });
});
