import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyJudgeCommand } from "../src/minima/judge.ts";

describe("applyJudgeCommand (/judge state transition)", () => {
  const DEFAULT = 0.15;

  test("bare /judge round-trips: sampled default -> off -> sampled default", () => {
    const off = applyJudgeCommand("", { judgeEvery: 1, judgeSampleRate: DEFAULT }, DEFAULT);
    expect(off.judgeEvery).toBe(0);
    expect(off.message).toContain("off");

    const on = applyJudgeCommand(
      "",
      { judgeEvery: off.judgeEvery, judgeSampleRate: off.judgeSampleRate },
      DEFAULT,
    );
    expect(on.judgeEvery).toBe(1);
    expect(on.judgeSampleRate).toBeCloseTo(DEFAULT, 8);
    expect(on.message).toContain("sampled");
    expect(on.message).toContain("15%");
  });

  test("bare /judge with an every-turn default (rate 0 or 1) toggles to every turn", () => {
    const on = applyJudgeCommand("", { judgeEvery: 0, judgeSampleRate: 0 }, 0);
    expect(on.judgeEvery).toBe(1);
    expect(on.judgeSampleRate).toBe(1);
    expect(on.message).toContain("every");
  });

  test("explicit args: on = every turn, off = off, legacy truthy spellings keep working", () => {
    for (const arg of ["on", "1", "true", "yes"]) {
      const s = applyJudgeCommand(arg, { judgeEvery: 0, judgeSampleRate: DEFAULT }, DEFAULT);
      expect(s.judgeEvery).toBe(1);
      expect(s.judgeSampleRate).toBe(1);
      expect(s.message).toContain("every");
    }
    for (const arg of ["off", "0", "false", "no"]) {
      const s = applyJudgeCommand(arg, { judgeEvery: 1, judgeSampleRate: 1 }, DEFAULT);
      expect(s.judgeEvery).toBe(0);
      expect(s.message).toContain("off");
    }
  });

  test("/judge sample restores the sampled default — the path back from every-turn", () => {
    const s = applyJudgeCommand("sample", { judgeEvery: 1, judgeSampleRate: 1 }, DEFAULT);
    expect(s.judgeEvery).toBe(1);
    expect(s.judgeSampleRate).toBeCloseTo(DEFAULT, 8);
    expect(s.message).toContain("sampled");
  });

  test("/judge sample falls back to 15% when the session default is degenerate", () => {
    for (const degenerate of [0, 1]) {
      const s = applyJudgeCommand("sample", { judgeEvery: 0, judgeSampleRate: 0 }, degenerate);
      expect(s.judgeSampleRate).toBeCloseTo(0.15, 8);
    }
  });

  test("an unknown arg changes nothing and shows usage — a typo must not kill judging", () => {
    const s = applyJudgeCommand("banana", { judgeEvery: 1, judgeSampleRate: DEFAULT }, DEFAULT);
    expect(s.judgeEvery).toBe(1);
    expect(s.judgeSampleRate).toBeCloseTo(DEFAULT, 8);
    expect(s.message).toContain("usage");
  });
});

describe("/judge TUI wiring", () => {
  const src = readFileSync(join(import.meta.dir, "../src/tui/app.tsx"), "utf8");

  test("the handler delegates to applyJudgeCommand (no inline truthy check)", () => {
    expect(src).toContain("applyJudgeCommand(");
    expect(src).not.toContain('in { on: 1, "1": 1, true: 1, yes: 1 }');
  });

  test("the registry description documents the real toggle surface", () => {
    expect(src).toContain("on|off|sample");
  });
});
