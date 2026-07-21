import { describe, expect, test } from "bun:test";
import { permsSummary } from "../src/tui/status.tsx";

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
