import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("perm_grants persistence", () => {
  test("round-trips per project, merges grants, survives a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-perm-grants-"));
    const prevEnv = process.env.MINIMA_HARNESS_DIR;
    process.env.MINIMA_HARNESS_DIR = dir;
    try {
      const { loadBashGrants, persistBashGrants } = await import("../src/tui/perm_grants.ts");
      expect(loadBashGrants("github.com/x/y")).toEqual([]);
      persistBashGrants("github.com/x/y", ["pip"]);
      persistBashGrants("github.com/x/y", ["git", "pip"]); // merge, dedupe
      persistBashGrants("github.com/other/repo", ["make"]);
      expect(loadBashGrants("github.com/x/y")).toEqual(["git", "pip"]);
      expect(loadBashGrants("github.com/other/repo")).toEqual(["make"]);
      // Non-string entries in a hand-edited file are dropped, not crashed on.
      writeFileSync(
        join(dir, "perm-grants.json"),
        JSON.stringify({ "github.com/x/y": { bash: ["pip", 42, ""] } }),
        "utf8",
      );
      expect(loadBashGrants("github.com/x/y")).toEqual(["pip"]);
      writeFileSync(join(dir, "perm-grants.json"), "{corrupt", "utf8");
      expect(loadBashGrants("github.com/x/y")).toEqual([]); // fresh start, no throw
      persistBashGrants("github.com/x/y", ["uv"]); // writes over the corrupt file
      expect(loadBashGrants("github.com/x/y")).toEqual(["uv"]);
    } finally {
      if (prevEnv === undefined) delete process.env.MINIMA_HARNESS_DIR;
      else process.env.MINIMA_HARNESS_DIR = prevEnv;
    }
  });
});
