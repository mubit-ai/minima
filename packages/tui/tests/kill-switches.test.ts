import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configFromEnv, type HarnessConfig } from "../src/minima/config.ts";

// MINIMA_TUI_<X>=0 is the documented rollback for every default-ON harness behavior
// (docs/configuration.md, and the v0.14.4 release note). These were verified once by hand
// on one machine; this table is what keeps the promise true from here on. A kill switch
// that silently stops working is worse than no kill switch — the published rollback
// instruction becomes wrong at exactly the moment someone needs it.

const CONFIG_SRC = join(import.meta.dir, "..", "src", "minima", "config.ts");

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

// Default ON: shipped enabled, `=0` is the rollback.
const DEFAULT_ON: readonly Switch[] = [
  { env: "MINIMA_TUI_BIG_PLAN", field: "bigPlan" },
  { env: "MINIMA_TUI_MEMORY", field: "memoryLedger" },
  { env: "MINIMA_TUI_ARTIFACTS", field: "artifacts" },
  { env: "MINIMA_TUI_BGJOBS", field: "bgJobs" },
  { env: "MINIMA_TUI_COMPACT2", field: "compact2" },
  { env: "MINIMA_TUI_STEER", field: "steer" },
  { env: "MINIMA_TUI_REWIND", field: "contextRewind" },
  { env: "MINIMA_TUI_EDIT_GUARD", field: "editGuard" },
  { env: "MINIMA_TUI_TYPED_TASK", field: "typedTask" },
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

  test("every feature flag config.ts reads is covered by this table", () => {
    const src = readFileSync(CONFIG_SRC, "utf8");
    const read = new Set(
      [...src.matchAll(/process\.env\.(MINIMA_TUI_[A-Z0-9_]+)/g)].map((m) => m[1] as string),
    );
    // Tunables and umbrellas are not kill switches; they are asserted elsewhere or by shape.
    const NOT_A_SWITCH = new Set([
      "MINIMA_TUI_EXPERIMENTAL",
      "MINIMA_TUI_ARTIFACT_GC_MB",
      "MINIMA_TUI_FETCH_LOCAL",
      "MINIMA_TUI_TTSR_CAP",
      "MINIMA_TUI_LSP_TIMEOUT_MS",
      "MINIMA_TUI_CLASSIFY_FORCE",
      "MINIMA_TUI_STOP_STRIKES",
      "MINIMA_TUI_SPIRAL_REPEATS",
      "MINIMA_TUI_STEP_CAP",
      "MINIMA_TUI_BACKOFF_MS",
      "MINIMA_TUI_PLAN_PREMIUM",
      "MINIMA_TUI_FAILURE_MATCHER",
      "MINIMA_TUI_TOOL_ALLOWLIST",
      "MINIMA_TUI_GRADED_OUTCOME",
      "MINIMA_TUI_PLAN_CRITIC",
      "MINIMA_TUI_DIFF_REVIEW",
      "MINIMA_TUI_ALLOW_VERIFY",
    ]);
    const covered = new Set([...DEFAULT_ON, ...OPT_IN].map((s) => s.env));
    const uncovered = [...read].filter((e) => !covered.has(e) && !NOT_A_SWITCH.has(e)).sort();
    // A new default-ON behavior must either get a row above or be declared not-a-switch.
    expect(uncovered).toEqual([]);
  });
});
