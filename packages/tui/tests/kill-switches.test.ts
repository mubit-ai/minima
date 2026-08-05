import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { headlessVerifyConsent } from "../src/minima/big_plan.ts";
import { configFromEnv, type HarnessConfig } from "../src/minima/config.ts";
import { PROJECT_CONFIG_RELPATH, resolveEnvLayers } from "../src/minima/project_config.ts";
import { code, readSource } from "./_source.ts";

// MINIMA_TUI_<X>=0 is the documented rollback for every default-ON harness behavior
// (docs-site/pages/harness/configuration.mdx, and the v0.14.4 release note). These were
// verified once by hand on one machine; this table is what keeps the promise true from here
// on. A kill switch that silently stops working is worse than no kill switch — the published
// rollback instruction becomes wrong at exactly the moment someone needs it.

const SRC_DIR = join(import.meta.dir, "..", "src");

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Neutralize the umbrella + every switch, so each case sets exactly one variable. */
function clean(vars: Record<string, string | undefined>): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { MINIMA_TUI_EXPERIMENTAL: undefined };
  for (const s of [...DEFAULT_ON, ...OPT_IN]) base[s.env] = undefined;
  return { ...base, ...vars };
}

interface Switch {
  env: string;
  field: keyof HarnessConfig;
}

// Default ON: shipped enabled, `=0` is the rollback. Every row here resolves through
// configFromEnv, so the assertion is behavioral — the flag reaches the field the feature
// reads.
const DEFAULT_ON: readonly Switch[] = [
  { env: "MINIMA_TUI_BIG_PLAN", field: "bigPlan" },
  { env: "MINIMA_TUI_IMAGES", field: "images" },
  { env: "MINIMA_TUI_NOTIFY", field: "notify" },
  { env: "MINIMA_TUI_MEMORY", field: "memoryLedger" },
  { env: "MINIMA_TUI_ARTIFACTS", field: "artifacts" },
  { env: "MINIMA_TUI_BGJOBS", field: "bgJobs" },
  { env: "MINIMA_TUI_COMPACT2", field: "compact2" },
  { env: "MINIMA_TUI_CONTEXT_METER", field: "contextMeter" },
  { env: "MINIMA_TUI_STEER", field: "steer" },
  { env: "MINIMA_TUI_REWIND", field: "contextRewind" },
  { env: "MINIMA_TUI_GIT", field: "git" },
  { env: "MINIMA_TUI_EDIT_GUARD", field: "editGuard" },
  { env: "MINIMA_TUI_TYPED_TASK", field: "typedTask" },
  { env: "MINIMA_TUI_PLAN_PREMIUM", field: "planPremium" },
  { env: "MINIMA_TUI_FAILURE_MATCHER", field: "failureMatcher" },
  { env: "MINIMA_TUI_TOOL_ALLOWLIST", field: "toolAllowlist" },
  { env: "MINIMA_TUI_GRADED_OUTCOME", field: "gradedOutcome" },
  { env: "MINIMA_TUI_EDITOR", field: "externalEditor" },
];

// Opt-in: shipped disabled, `=1` enables. Promotion to default-ON moves the row up.
const OPT_IN: readonly Switch[] = [
  { env: "MINIMA_TUI_TTSR", field: "ttsr" },
  { env: "MINIMA_TUI_LSP", field: "lsp" },
  { env: "MINIMA_TUI_INTERVIEW", field: "interview" },
  { env: "MINIMA_TUI_TUNER", field: "tuner" },
  { env: "MINIMA_TUI_OBSERVER", field: "observer" },
  { env: "MINIMA_TUI_CLASSIFY", field: "classify" },
];

/**
 * Default-ON switches that do NOT go through configFromEnv — the feature reads
 * `process.env` where it is wired. There is no config field to assert, and the read sites
 * sit inside app.tsx / main.ts / a finalize path that cannot be driven from a unit test, so
 * what is pinned is the gating EXPRESSION at the read site. That catches the failure that
 * matters (the gate deleted, or its sense inverted) without pretending to be behavioral.
 *
 * These rows are a standing argument for routing them through config.ts like every other
 * switch; until then, an ambient read that no table knows about is exactly how the previous
 * version of this file came to assert full coverage while missing six switches.
 */
interface AmbientSwitch {
  env: string;
  file: string;
  gate: string;
}

/**
 * Default-ON switches read outside configFromEnv that ARE drivable from a unit test, because
 * the feature reading them is a pure function taking its environment by injection. Neither
 * table above fits: there is no config field to assert (so not DEFAULT_ON), but pinning a
 * source string would be a downgrade from an assertion that actually runs the gate (so not
 * AMBIENT_DEFAULT_ON). Each row here owns a real behavioral test below; the table exists so
 * the completeness check knows the switch is covered.
 */
const PURE_DEFAULT_ON: readonly { env: string }[] = [{ env: "MINIMA_TUI_PROJECT_CONFIG" }];

const AMBIENT_DEFAULT_ON: readonly AmbientSwitch[] = [
  {
    env: "MINIMA_TUI_PLAN_CRITIC",
    file: "tui/app.tsx",
    gate: 'critic: process.env.MINIMA_TUI_PLAN_CRITIC === "0" ? async () => null : undefined,',
  },
  {
    env: "MINIMA_TUI_DIFF_REVIEW",
    file: "cli/main.ts",
    gate: 'process.env.MINIMA_TUI_DIFF_REVIEW !== "0" &&',
  },
  {
    env: "MINIMA_TUI_AUTO_GATES",
    file: "minima/plan_finalize.ts",
    gate: 'if (process.env.MINIMA_TUI_AUTO_GATES !== "0") {',
  },
];

/**
 * Tunables, umbrellas, diagnostics and legacy rollbacks. Not kill switches for a shipped
 * behavior — each is asserted elsewhere, by shape, or is a developer-only escape hatch.
 * Anything NOT in this set and not in a table above fails the completeness check below.
 */
const NOT_A_SWITCH = new Set([
  // Umbrella + consent gates (asserted by their own tests below).
  "MINIMA_TUI_EXPERIMENTAL",
  "MINIMA_TUI_FETCH_LOCAL",
  "MINIMA_TUI_ALLOW_VERIFY",
  // Numeric tunables.
  "MINIMA_TUI_ARTIFACT_GC_MB",
  "MINIMA_TUI_NOTIFY_AFTER_MS",
  "MINIMA_TUI_TTSR_CAP",
  "MINIMA_TUI_LSP_TIMEOUT_MS",
  "MINIMA_TUI_STOP_STRIKES",
  "MINIMA_TUI_SPIRAL_REPEATS",
  "MINIMA_TUI_STEP_CAP",
  "MINIMA_TUI_BACKOFF_MS",
  "MINIMA_TUI_MEMORY_CAP",
  "MINIMA_TUI_CHECK_TIMEOUT",
  // Opt-in extras to an already-flagged feature (=1 adds a signal source / forces a path).
  "MINIMA_TUI_CLASSIFY_FORCE",
  "MINIMA_TUI_SCRIBE_CONTRAST",
  "MINIMA_TUI_SCRIBE_WORKFLOW",
  // Developer diagnostics and one-release legacy rollbacks — never a shipped feature gate.
  "MINIMA_TUI_ANCHOR_LEGACY",
  "MINIMA_TUI_DEBUG_ANCHOR",
  "MINIMA_TUI_BADGE",
  "MINIMA_TUI_PERF",
]);

/** Every .ts/.tsx file under src/, so an ambient read cannot hide outside config.ts. */
function srcFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => join(SRC_DIR, f));
}

describe("kill-switch matrix — the documented rollback contract", () => {
  for (const { env, field } of DEFAULT_ON) {
    test(`${env} is ON by default and =0 disables ${String(field)}`, () => {
      withEnv(clean({}), () => expect(configFromEnv()[field]).toBe(true));
      withEnv(clean({ [env]: "0" }), () => expect(configFromEnv()[field]).toBe(false));
      withEnv(clean({ [env]: "1" }), () => expect(configFromEnv()[field]).toBe(true));
    });
  }

  for (const { env, field } of OPT_IN) {
    test(`${env} is OFF by default and =1 enables ${String(field)}`, () => {
      withEnv(clean({}), () => expect(configFromEnv()[field]).toBe(false));
      withEnv(clean({ [env]: "1" }), () => expect(configFromEnv()[field]).toBe(true));
    });

    // The umbrella must never override an explicit off: an operator rolling back one
    // experimental feature while leaving EXPERIMENTAL=1 set must still get it off.
    test(`${env}=0 beats MINIMA_TUI_EXPERIMENTAL=1`, () => {
      withEnv(clean({ MINIMA_TUI_EXPERIMENTAL: "1" }), () =>
        expect(configFromEnv()[field]).toBe(true),
      );
      withEnv(clean({ MINIMA_TUI_EXPERIMENTAL: "1", [env]: "0" }), () =>
        expect(configFromEnv()[field]).toBe(false),
      );
    });
  }

  for (const { env, file, gate } of AMBIENT_DEFAULT_ON) {
    test(`${env} still gates its read site in ${file} (wiring pin, not behavior)`, () => {
      expect(readSource(file)).toContain(code(gate));
    });
  }

  test("MINIMA_TUI_ARTIFACT_GC_MB defaults to 512 and =0 disables GC", () => {
    withEnv(clean({ MINIMA_TUI_ARTIFACT_GC_MB: undefined }), () =>
      expect(configFromEnv().artifactGcMb).toBe(512),
    );
    withEnv(clean({ MINIMA_TUI_ARTIFACT_GC_MB: "0" }), () =>
      expect(configFromEnv().artifactGcMb).toBe(0),
    );
    withEnv(clean({ MINIMA_TUI_ARTIFACT_GC_MB: "16" }), () =>
      expect(configFromEnv().artifactGcMb).toBe(16),
    );
  });

  test("MINIMA_TUI_FETCH_LOCAL is a consent gate: absent means DENY", () => {
    withEnv(clean({ MINIMA_TUI_FETCH_LOCAL: undefined }), () =>
      expect(configFromEnv().fetchLocal).toBe(false),
    );
    withEnv(clean({ MINIMA_TUI_FETCH_LOCAL: "1" }), () =>
      expect(configFromEnv().fetchLocal).toBe(true),
    );
    // A consent gate must NOT be openable by the experimental umbrella.
    withEnv(clean({ MINIMA_TUI_EXPERIMENTAL: "1" }), () =>
      expect(configFromEnv().fetchLocal).toBe(false),
    );
  });

  test("MINIMA_TUI_ALLOW_VERIFY is a consent gate: absent means DENY", () => {
    // headlessVerifyConsent takes its env by injection, so this one is testable for real.
    expect(headlessVerifyConsent({}) ("echo hi")).toBe(false);
    expect(headlessVerifyConsent({ MINIMA_TUI_ALLOW_VERIFY: "0" })("echo hi")).toBe(false);
    expect(headlessVerifyConsent({ MINIMA_TUI_ALLOW_VERIFY: "1" })("echo hi")).toBe(true);
    // Consent is explicit: the umbrella must not open it.
    expect(headlessVerifyConsent({ MINIMA_TUI_EXPERIMENTAL: "1" })("echo hi")).toBe(false);
  });

  test("every MINIMA_TUI_* flag read anywhere in src/ is covered by a table above", () => {
    // Scans ALL of src/, not just config.ts: MINIMA_TUI_PLAN_CRITIC, _DIFF_REVIEW and
    // _AUTO_GATES are read at their wiring sites, so a config.ts-only scan reported full
    // coverage while three default-ON switches had no row at all.
    const read = new Set<string>();
    for (const file of srcFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/process\.env\.(MINIMA_TUI_[A-Z0-9_]+)/g))
        read.add(m[1] as string);
      // big_plan.ts reads its injected env object rather than process.env.
      for (const m of src.matchAll(/\benv\.(MINIMA_TUI_[A-Z0-9_]+)/g)) read.add(m[1] as string);
    }
    const covered = new Set([
      ...DEFAULT_ON.map((s) => s.env),
      ...OPT_IN.map((s) => s.env),
      ...AMBIENT_DEFAULT_ON.map((s) => s.env),
      ...PURE_DEFAULT_ON.map((s) => s.env),
    ]);
    const uncovered = [...read].filter((e) => !covered.has(e) && !NOT_A_SWITCH.has(e)).sort();
    // A new default-ON behavior must either get a row above or be declared not-a-switch.
    expect(
      uncovered,
      "These MINIMA_TUI_* flags are read in src/ but appear in no table here. Add a row to " +
        "DEFAULT_ON (config-backed), AMBIENT_DEFAULT_ON (read at the wiring site), " +
        "PURE_DEFAULT_ON (read by an injectable pure function), OPT_IN, or declare it in " +
        "NOT_A_SWITCH if it is a tunable or a diagnostic.",
    ).toEqual([]);
  });

  test("the tables are not vacuous", () => {
    expect(DEFAULT_ON.length).toBeGreaterThan(0);
    expect(OPT_IN.length).toBeGreaterThan(0);
    expect(AMBIENT_DEFAULT_ON.length).toBeGreaterThan(0);
    expect(PURE_DEFAULT_ON.length).toBeGreaterThan(0);
  });

  test("MINIMA_TUI_PROJECT_CONFIG is ON by default and =0 ignores .minima/config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-killsw-"));
    try {
      mkdirSync(join(dir, ".minima"), { recursive: true });
      writeFileSync(join(dir, PROJECT_CONFIG_RELPATH), "[budget]\nlimit_usd = 1\n");
      // The loader takes its environment by injection, so this asserts the gate for real
      // rather than pinning the text of the expression that implements it.
      expect(resolveEnvLayers({ projectDir: dir, env: {} }).values.MINIMA_BUDGET_USD).toBe("1");
      expect(
        resolveEnvLayers({ projectDir: dir, env: { MINIMA_TUI_PROJECT_CONFIG: "1" } }).values
          .MINIMA_BUDGET_USD,
      ).toBe("1");
      const off = resolveEnvLayers({ projectDir: dir, env: { MINIMA_TUI_PROJECT_CONFIG: "0" } });
      expect(off.values.MINIMA_BUDGET_USD).toBeUndefined();
      expect(off.path).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
