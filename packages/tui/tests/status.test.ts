import { describe, expect, test } from "bun:test";
import { fmtUsd, permsSummary } from "../src/tui/status.tsx";

describe("fmtUsd (adaptive money precision)", () => {
  test("two decimals at cent scale and above", () => {
    expect(fmtUsd(5)).toBe("$5.00");
    expect(fmtUsd(0.01)).toBe("$0.01");
    expect(fmtUsd(0)).toBe("$0.00");
  });

  test("sub-cent budgets keep their significant digits", () => {
    expect(fmtUsd(0.002)).toBe("$0.002"); // /budget set 0.002 must not display as $0.00
    expect(fmtUsd(0.0025)).toBe("$0.0025");
    expect(fmtUsd(0.000001)).toBe("$0.000001");
  });

  test("degenerate values fall back to $0.00", () => {
    expect(fmtUsd(Number.NaN)).toBe("$0.00");
    expect(fmtUsd(1e-9)).toBe("$0.00");
  });
});

describe("permsSummary (mode-aware perms footer)", () => {
  test("states what the ACTIVE mode does with w/e/b", () => {
    expect(permsSummary("build", [], []).effective).toBe("w/e/b: ask");
    expect(permsSummary("acceptEdits", [], []).effective).toBe("w/e: auto (cwd) · b: ask");
    expect(permsSummary("bypass", [], []).effective).toBe("w/e/b: auto");
    expect(permsSummary("plan", [], []).effective).toBe("PLAN (deny)");
  });

  test("grants list: whole tools, bash families, and the supersede rule", () => {
    expect(permsSummary("build", [], []).grants).toBeNull();
    expect(permsSummary("build", ["write"], []).grants).toBe("--x write");
    expect(permsSummary("build", [], ["git", "pip"]).grants).toBe("--x bash[git,pip]");
    expect(permsSummary("build", ["write"], ["pip"]).grants).toBe("--x write, bash[pip]");
    // A whole-tool bash grant supersedes its family list — never both.
    expect(permsSummary("build", ["bash"], ["pip"]).grants).toBe("--x bash");
  });

  test("grants render regardless of mode (the effective segment stays separate)", () => {
    const s = permsSummary("acceptEdits", [], ["pip"]);
    expect(s.effective).toBe("w/e: auto (cwd) · b: ask");
    expect(s.grants).toBe("--x bash[pip]");
  });
});
