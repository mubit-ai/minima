import { describe, expect, test } from "bun:test";
import { judgeEnabled, parseArgs } from "../src/cli/main.ts";

describe("judgeEnabled (F7: no judge banner for a judge that can't run)", () => {
  test("--offline disables the judge outright — offline turns are never judged", () => {
    expect(judgeEnabled(true, undefined, 0.15)).toBe(false);
    expect(judgeEnabled(true, "1", 1)).toBe(false);
  });

  test("online: the existing gates hold (MINIMA_LLM_JUDGE=0 or rate 0 disable)", () => {
    expect(judgeEnabled(false, undefined, 0.15)).toBe(true);
    expect(judgeEnabled(false, "0", 0.15)).toBe(false);
    expect(judgeEnabled(false, undefined, 0)).toBe(false);
    expect(judgeEnabled(false, "1", 1)).toBe(true);
  });
});

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
