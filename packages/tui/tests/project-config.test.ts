import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CANDIDATES } from "../src/minima/config.ts";
import {
  PROJECT_CONFIG_ALLOWLIST,
  PROJECT_CONFIG_RELPATH,
  resolveEnvLayers,
} from "../src/minima/project_config.ts";

/**
 * `.minima/config.toml` is the harness's first COMMITTED config surface. Every other one
 * (`.env.harness`, `.env`, the per-user store) is uncommitted and therefore trusted because
 * the user wrote it; this one arrives with `git clone`, written by someone else. So the
 * assertions below are not "does the merge work" — they are "can a repo author move any
 * value toward the less safe side". The answer has to be no for every allowlisted key.
 *
 * The seam is the loader itself, as a pure function over a project directory plus the
 * per-user store's values. Clamping happens BEFORE anything reaches `process.env` (once a
 * value is env you can no longer tell which layer set it), so these tests assert the merged
 * result directly and never touch the environment — which is why they cannot reuse the
 * `withEnv` helper the other config suites share.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project directory, optionally carrying a committed config + the user's own .env files. */
function projectDir(files: { toml?: string; envHarness?: string; env?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "minima-proj-"));
  dirs.push(dir);
  if (files.toml !== undefined) {
    mkdirSync(join(dir, ".minima"), { recursive: true });
    writeFileSync(join(dir, PROJECT_CONFIG_RELPATH), files.toml);
  }
  if (files.envHarness !== undefined) writeFileSync(join(dir, ".env.harness"), files.envHarness);
  if (files.env !== undefined) writeFileSync(join(dir, ".env"), files.env);
  return dir;
}

/** Did any notice mention this? (Exact wording is free to change; visibility is not.) */
function mentions(notices: string[], needle: string): boolean {
  return notices.some((n) => n.includes(needle));
}

describe("project config — budget limit (lower wins)", () => {
  test("a project budget below the user's lowers the effective ceiling", () => {
    const dir = projectDir({
      toml: "[budget]\nlimit_usd = 1.5\n",
      envHarness: "MINIMA_BUDGET_USD=5\n",
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_USD).toBe("1.5");
  });

  test("a project budget above the user's has no effect, and says so", () => {
    const dir = projectDir({ toml: "[budget]\nlimit_usd = 50\n" });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_BUDGET_USD: "5" } });
    // The user's own ceiling stands: nothing is written, so the shell value survives.
    expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(mentions(r.notices, "budget.limit_usd")).toBe(true);
  });

  test("the clamp beats precedence: a shell-set ceiling is still lowered", () => {
    // .minima/config.toml sits BELOW shell env in precedence, so plain layering would drop
    // the project value entirely. The safer side wins regardless of layer order.
    const dir = projectDir({ toml: "[budget]\nlimit_usd = 2\n" });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_BUDGET_USD: "9" } });
    expect(r.values.MINIMA_BUDGET_USD).toBe("2");
  });

  test("with no user ceiling at all, the project's ceiling applies", () => {
    const dir = projectDir({ toml: "[budget]\nlimit_usd = 3\n" });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_USD).toBe("3");
  });

  test("a non-numeric or non-positive budget is ignored, not coerced", () => {
    for (const bad of ['limit_usd = "5"', "limit_usd = 0", "limit_usd = -2"]) {
      const dir = projectDir({ toml: `[budget]\n${bad}\n` });
      const r = resolveEnvLayers({ projectDir: dir, env: {} });
      expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
      expect(mentions(r.notices, "budget.limit_usd")).toBe(true);
    }
  });
});

describe("project config — budget mode (strictest wins)", () => {
  test("project enforce beats the user's warn", () => {
    const dir = projectDir({ toml: '[budget]\nmode = "enforce"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_BUDGET_MODE: "warn" } });
    expect(r.values.MINIMA_BUDGET_MODE).toBe("enforce");
  });

  test("the user's enforce is never relaxed to shadow by the project", () => {
    const dir = projectDir({ toml: '[budget]\nmode = "shadow"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_BUDGET_MODE: "enforce" } });
    expect(r.values.MINIMA_BUDGET_MODE).toBeUndefined();
    expect(mentions(r.notices, "budget.mode")).toBe(true);
  });

  test("shadow loses to the harness default (warn) even with nothing set by the user", () => {
    const dir = projectDir({ toml: '[budget]\nmode = "shadow"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_MODE).toBeUndefined();
  });

  test("a mode equal to what is in effect is a silent no-op, not a refusal", () => {
    // A project file agreeing with you must not print a "may only make it STRICTER" line on
    // every startup — that is how a real refusal notice gets trained out of being read.
    const dir = projectDir({ toml: '[budget]\nmode = "enforce"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_BUDGET_MODE: "enforce" } });
    expect(r.values.MINIMA_BUDGET_MODE).toBeUndefined();
    expect(mentions(r.notices, "budget.mode")).toBe(false);
  });

  test("an unknown mode is ignored", () => {
    const dir = projectDir({ toml: '[budget]\nmode = "off"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_MODE).toBeUndefined();
    expect(mentions(r.notices, "budget.mode")).toBe(true);
  });
});

describe("project config — candidate pool (intersection only)", () => {
  test("a project pool intersects the user's and keeps the user's order", () => {
    const dir = projectDir({ toml: '[routing]\ncandidates = ["c", "a"]\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_CANDIDATES: "a,b,c" } });
    expect(r.values.MINIMA_CANDIDATES).toBe("a,c");
  });

  test("it can never widen the pool — ids the user does not allow are dropped", () => {
    const dir = projectDir({ toml: '[routing]\ncandidates = ["a", "gpt-4o-mini"]\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_CANDIDATES: "a,b" } });
    expect(r.values.MINIMA_CANDIDATES).toBe("a");
    expect(mentions(r.notices, "gpt-4o-mini")).toBe(true);
  });

  test("with no user pool the intersection is against the shipped default pool", () => {
    const inDefault = DEFAULT_CANDIDATES[0] as string;
    const dir = projectDir({
      toml: `[routing]\ncandidates = ["${inDefault}", "not-a-shipped-model"]\n`,
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_CANDIDATES).toBe(inDefault);
  });

  test("a disjoint pool is refused rather than emptied — an empty pool is a widening", () => {
    const dir = projectDir({ toml: '[routing]\ncandidates = ["x", "y"]\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_CANDIDATES: "a,b" } });
    expect(r.values.MINIMA_CANDIDATES).toBeUndefined();
    expect(mentions(r.notices, "routing.candidates")).toBe(true);
  });

  test("a pool that is a superset of the user's writes nothing", () => {
    const dir = projectDir({ toml: '[routing]\ncandidates = ["a", "b"]\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_CANDIDATES: "a,b" } });
    expect(r.values.MINIMA_CANDIDATES).toBeUndefined();
  });

  test("a non-array or non-string-array value is ignored", () => {
    for (const bad of ['candidates = "a,b"', "candidates = [1, 2]"]) {
      const dir = projectDir({ toml: `[routing]\n${bad}\n` });
      const r = resolveEnvLayers({ projectDir: dir, env: { MINIMA_CANDIDATES: "a,b" } });
      expect(r.values.MINIMA_CANDIDATES).toBeUndefined();
      expect(mentions(r.notices, "routing.candidates")).toBe(true);
    }
  });
});

describe("project config — neutral keys plainly shadow", () => {
  test("a compaction preference applies when the user has none", () => {
    const dir = projectDir({ toml: "[compaction]\nartifact_spill = false\n" });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_TUI_COMPACT2).toBe("0");
  });

  test("it beats the per-user store but loses to the user's shell and .env files", () => {
    const withStore = projectDir({ toml: "[compaction]\nartifact_spill = false\n" });
    expect(
      resolveEnvLayers({
        projectDir: withStore,
        env: {},
        stored: { MINIMA_TUI_COMPACT2: "1" },
      }).values.MINIMA_TUI_COMPACT2,
    ).toBe("0");

    expect(
      resolveEnvLayers({ projectDir: withStore, env: { MINIMA_TUI_COMPACT2: "1" } }).values
        .MINIMA_TUI_COMPACT2,
    ).toBeUndefined();

    const withEnvFile = projectDir({
      toml: "[compaction]\nartifact_spill = false\n",
      envHarness: "MINIMA_TUI_COMPACT2=1\n",
    });
    expect(
      resolveEnvLayers({ projectDir: withEnvFile, env: {} }).values.MINIMA_TUI_COMPACT2,
    ).toBe("1");
  });
});

describe("project config — the allowlist is the gate", () => {
  test("a key not on the allowlist is ignored, and the fact is visible", () => {
    const dir = projectDir({
      toml: '[thinking]\nlevel = "high"\n\n[judge]\nsample = 1.0\n\n[budget]\nlimit_usd = 2\n',
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_USD).toBe("2");
    expect(mentions(r.notices, "thinking.level")).toBe(true);
    expect(mentions(r.notices, "judge.sample")).toBe(true);
  });

  test("no key outside the allowlist can reach the environment", () => {
    const dir = projectDir({
      toml: [
        "[thinking]",
        'level = "high"',
        "",
        "[env]",
        'MINIMA_TUI_BIG_PLAN = "0"',
        'MINIMA_TUI_STEER = "0"',
        'ANTHROPIC_API_KEY = "stolen"',
      ].join("\n"),
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    const allowed = new Set(PROJECT_CONFIG_ALLOWLIST.map((k) => k.env));
    for (const key of Object.keys(r.values)) expect(allowed.has(key)).toBe(true);
  });
});

describe("project config — the clamp happens before process.env", () => {
  test("every value the loader emits is at or below the user's own", () => {
    const dir = projectDir({
      toml: [
        "[budget]",
        "limit_usd = 100",
        'mode = "shadow"',
        "",
        "[routing]",
        'candidates = ["a", "b", "z"]',
      ].join("\n"),
    });
    const r = resolveEnvLayers({
      projectDir: dir,
      env: { MINIMA_BUDGET_USD: "5", MINIMA_BUDGET_MODE: "enforce", MINIMA_CANDIDATES: "a,b" },
    });
    // Every project value here tried to widen. Not one of them may be written — the
    // downstream read sites see the user's values untouched.
    expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(r.values.MINIMA_BUDGET_MODE).toBeUndefined();
    expect(r.values.MINIMA_CANDIDATES).toBeUndefined();
  });
});

describe("project config — never blocks startup", () => {
  test("malformed TOML produces a clear message and the other layers still resolve", () => {
    const dir = projectDir({
      toml: "[budget\nlimit_usd = ",
      envHarness: "MINIMA_URL=http://localhost:8080\n",
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_URL).toBe("http://localhost:8080");
    expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(mentions(r.notices, PROJECT_CONFIG_RELPATH)).toBe(true);
  });

  test("a top-level scalar instead of a table is refused without throwing", () => {
    const dir = projectDir({ toml: 'budget = "all of it"\n' });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe("project config — absent or disabled", () => {
  test("absent .minima/config.toml resolves exactly the pre-existing layers", () => {
    const dir = projectDir({
      envHarness: "MINIMA_URL=http://localhost:8080\nMUBIT_API_KEY=from-harness\n",
      env: "MUBIT_API_KEY=from-dotenv\nEXA_API_KEY=from-dotenv\n",
    });
    const r = resolveEnvLayers({
      projectDir: dir,
      env: { MINIMA_URL: "https://shell.example" },
      stored: { MUBIT_API_KEY: "from-store", MINIMA_API_KEY: "from-store" },
    });
    // Shell wins; .env.harness beats .env; the store fills only what nothing else set.
    expect(r.values).toEqual({
      MUBIT_API_KEY: "from-harness",
      EXA_API_KEY: "from-dotenv",
      MINIMA_API_KEY: "from-store",
    });
    expect(r.path).toBeNull();
    expect(r.notices).toEqual([]);
  });

  test("MINIMA_TUI_PROJECT_CONFIG=0 ignores the file entirely", () => {
    const dir = projectDir({
      toml: "[budget]\nlimit_usd = 1\n\n[thinking]\nlevel = \"high\"\n",
      envHarness: "MINIMA_URL=http://localhost:8080\n",
    });
    const off = resolveEnvLayers({
      projectDir: dir,
      env: { MINIMA_TUI_PROJECT_CONFIG: "0" },
    });
    expect(off.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(off.path).toBeNull();
    expect(off.notices).toEqual([]);
    // …and the untouched layers still load, so the switch is a no-op for everything else.
    expect(off.values.MINIMA_URL).toBe("http://localhost:8080");

    // Default ON: the same tree with the switch unset does read the file.
    const on = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(on.values.MINIMA_BUDGET_USD).toBe("1");
    expect(on.path).not.toBeNull();
  });

  test("the switch is honored from a .env file too, not just the shell", () => {
    const dir = projectDir({
      toml: "[budget]\nlimit_usd = 1\n",
      envHarness: "MINIMA_TUI_PROJECT_CONFIG=0\n",
    });
    const r = resolveEnvLayers({ projectDir: dir, env: {} });
    expect(r.values.MINIMA_BUDGET_USD).toBeUndefined();
    expect(r.path).toBeNull();
  });
});

describe("project config — the allowlist itself", () => {
  test("every entry declares a direction and a distinct env var", () => {
    expect(PROJECT_CONFIG_ALLOWLIST.length).toBeGreaterThan(0);
    const envs = new Set<string>();
    const paths = new Set<string>();
    for (const k of PROJECT_CONFIG_ALLOWLIST) {
      expect(["lower-wins", "strictest-wins", "intersect", "neutral"]).toContain(k.direction);
      expect(envs.has(k.env)).toBe(false);
      expect(paths.has(k.path)).toBe(false);
      envs.add(k.env);
      paths.add(k.path);
    }
  });

  test("v1 holds the four legislated keys and nothing else", () => {
    // Thinking level, judge sampling and default model are deliberately absent: nobody can
    // name their safer side yet. The list grows by argument, not by default.
    expect(PROJECT_CONFIG_ALLOWLIST.map((k) => k.path).sort()).toEqual([
      "budget.limit_usd",
      "budget.mode",
      "compaction.artifact_spill",
      "routing.candidates",
    ]);
  });
});
