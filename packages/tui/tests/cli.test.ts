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

describe("parseArgs renderer default (inline is the CC-parity default)", () => {
  const KEYS = ["MINIMA_TUI_FULLSCREEN", "MINIMA_TUI_INLINE"] as const;
  const withEnv = (env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void) => {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      fn();
    } finally {
      for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  test("no flags, no env → inline (native scroll + select + copy, no /mouse)", () => {
    withEnv({}, () => expect(parseArgs([]).fullscreen).toBe(false));
  });

  test("--fullscreen opts into the alt-screen frame", () => {
    withEnv({}, () => expect(parseArgs(["--fullscreen"]).fullscreen).toBe(true));
  });

  test("MINIMA_TUI_FULLSCREEN=1 opts in via env", () => {
    withEnv({ MINIMA_TUI_FULLSCREEN: "1" }, () => expect(parseArgs([]).fullscreen).toBe(true));
  });

  test("MINIMA_TUI_INLINE=1 forces inline even with the fullscreen env set", () => {
    withEnv({ MINIMA_TUI_FULLSCREEN: "1", MINIMA_TUI_INLINE: "1" }, () =>
      expect(parseArgs([]).fullscreen).toBe(false),
    );
  });

  test("--no-fullscreen forces inline over the fullscreen env", () => {
    withEnv({ MINIMA_TUI_FULLSCREEN: "1" }, () =>
      expect(parseArgs(["--no-fullscreen"]).fullscreen).toBe(false),
    );
  });

  test("--inline is the alias form (the decision doc's name for it)", () => {
    withEnv({ MINIMA_TUI_FULLSCREEN: "1" }, () =>
      expect(parseArgs(["--inline"]).fullscreen).toBe(false),
    );
  });
});
