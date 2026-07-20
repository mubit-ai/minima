import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachAutoGates, fastGate, fullGate, mineRepoGates } from "../src/minima/index.ts";

// E3 auto-gates: manifest mining per ecosystem (pure file reads — nothing executes) and
// the fast/full tier attachment that fills only verify-less steps.

function dir(): string {
  return mkdtempSync(join(tmpdir(), "minima-repo-"));
}

describe("repo-gate mining", () => {
  test("bun package.json: native test runner + check/lint scripts", () => {
    const d = dir();
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({
        scripts: { test: "bun test", check: "tsc --noEmit", lint: "biome check src" },
      }),
    );
    writeFileSync(join(d, "bun.lock"), "");
    const gates = mineRepoGates(d);
    expect(gates.find((g) => g.kind === "test")?.command).toBe("bun test");
    expect(gates.find((g) => g.kind === "typecheck")?.command).toBe("bun run check");
    expect(gates.find((g) => g.kind === "lint")?.command).toBe("bun run lint");
  });

  test("npm package.json without a bun lock uses npm run", () => {
    const d = dir();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    expect(mineRepoGates(d).find((g) => g.kind === "test")?.command).toBe("npm run test");
  });

  test("Makefile targets outrank package scripts; pyproject mines pytest", () => {
    const d = dir();
    writeFileSync(join(d, "Makefile"), "test:\n\tpytest\nlint:\n\truff check\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const gates = mineRepoGates(d);
    expect(gates.find((g) => g.kind === "test")?.command).toBe("make test");

    const py = dir();
    writeFileSync(join(py, "pyproject.toml"), "[project]\nname='x'\n");
    writeFileSync(join(py, "uv.lock"), "");
    mkdirSync(join(py, "tests"));
    expect(mineRepoGates(py).find((g) => g.kind === "test")?.command).toBe("uv run pytest");
  });

  test("empty repo mines nothing; malformed package.json is fail-open", () => {
    expect(mineRepoGates(dir())).toEqual([]);
    const d = dir();
    writeFileSync(join(d, "package.json"), "{not json");
    expect(mineRepoGates(d)).toEqual([]);
  });
});

describe("auto-gate attachment", () => {
  const gates = [
    { command: "bun test", kind: "test" as const, source: "package.json" },
    { command: "bun run check", kind: "typecheck" as const, source: "package.json" },
  ];

  test("fast in-loop, full suite on the final step; authored verifies never overwritten", () => {
    const result = attachAutoGates(
      [
        { content: "step 1" },
        { content: "step 2", verify: "bun test tests/authored.test.ts" },
        { content: "step 3" },
      ],
      gates,
    );
    expect(result.steps[0]!.verify).toBe("bun run check"); // fast tier
    expect(result.steps[1]!.verify).toBe("bun test tests/authored.test.ts"); // untouched
    expect(result.steps[2]!.verify).toBe("bun test"); // full suite at the end
    expect(result.attached).toEqual([1, 3]);
    expect(fastGate(gates)?.command).toBe("bun run check");
    expect(fullGate(gates)?.command).toBe("bun test");
  });

  test("no mined gates → steps unchanged", () => {
    const result = attachAutoGates([{ content: "step 1" }], []);
    expect(result.steps[0]!.verify).toBeUndefined();
    expect(result.attached).toEqual([]);
  });
});

describe("finalize integration", () => {
  test("mined checks land on the seeded plan and the note; opt-out env respected", async () => {
    const { finalizePlan } = await import("../src/minima/plan_finalize.ts");
    const { PlanSessionStore } = await import("../src/minima/plan_session.ts");
    const store = new PlanSessionStore("mine the checks");
    const synthesize = async () =>
      ({
        title: "t",
        goal: "mine the checks",
        overview: "",
        requirements: [],
        constraints: [],
        decisions: [],
        approach: [
          { action: "implement the thing", verify: null, tools: [] },
          { action: "wrap up", verify: null, tools: [] },
        ],
        risks: [],
        successCriteria: [],
        openItems: [],
      }) as never;
    const seeded: { verify?: string | null }[][] = [];
    const db = {
      seedPlanFromSteps: (_s: string, _t: string | null, steps: { verify?: string | null }[]) => {
        seeded.push(steps);
        return { planId: "p", stepIds: steps.map((_, i) => `s${i}`) };
      },
    };
    const outcome = await finalizePlan(store, {
      metaModel: { id: "m" } as never,
      signal: null,
      force: true,
      transcript: "",
      outPath: join(dir(), "GT.md"),
      db,
      runId: "run-1",
      synthesize,
      answerQuestions: async () => [],
      critic: async () => null,
      repoDir: "unused-because-injected",
      mineGates: () => [
        { command: "bun test", kind: "test", source: "package.json" },
        { command: "bun run check", kind: "typecheck", source: "package.json" },
      ],
    });
    if (outcome.kind !== "ok") throw new Error(`finalize failed: ${JSON.stringify(outcome)}`);
    expect(outcome.auditNote).toContain("Auto-gates");
    expect(outcome.seededVerifies).toContain("bun run check");
    expect(outcome.seededVerifies).toContain("bun test");
    expect(seeded[0]![0]!.verify).toBe("bun run check");
    expect(seeded[0]![1]!.verify).toBe("bun test");
  });
});
