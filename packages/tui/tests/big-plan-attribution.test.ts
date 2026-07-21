import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { confidence } from "../src/minima/confidence.ts";
import {
  bashWriteHints,
  bigPlanAttributionSink,
  bigPlanHooks,
  recordFileChanges,
  recordOpaqueMarker,
} from "../src/minima/big_plan.ts";
import type { Factors } from "../src/minima/big_plan_contract.ts";
import { parseFactors } from "../src/minima/why.ts";

// GT100-2 + GT101-F5: write attribution for bash and sub-agents, and the blind-evidence cap.
// Unattributable writes (opaque bash, worktree children) can never fabricate a green — they
// cap the tier at yellow instead: signal lost, never fabricated.

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};

describe("bashWriteHints", () => {
  const cases: {
    cmd: string;
    paths?: { path: string; kind: string }[];
    opaque: boolean;
  }[] = [
    { cmd: "ls -la src", paths: [], opaque: false },
    { cmd: "grep -rn foo src/", paths: [], opaque: false },
    { cmd: "bun test tests/db.test.ts", paths: [], opaque: false },
    { cmd: "echo hi > out.txt", paths: [{ path: "out.txt", kind: "modified" }], opaque: false },
    {
      cmd: "cat a.log >> combined.log",
      paths: [{ path: "combined.log", kind: "modified" }],
      opaque: false,
    },
    {
      cmd: "bun test 2>&1 | tee run.log",
      paths: [{ path: "run.log", kind: "modified" }],
      opaque: false,
    },
    { cmd: "touch src/new.ts", paths: [{ path: "src/new.ts", kind: "created" }], opaque: false },
    {
      cmd: "rm tests/old.test.ts",
      paths: [{ path: "tests/old.test.ts", kind: "deleted" }],
      opaque: false,
    },
    { cmd: "mv a.ts b.ts", paths: [{ path: "b.ts", kind: "modified" }], opaque: false },
    {
      cmd: "sed -i '' 's/a/b/' src/x.ts",
      paths: [{ path: "src/x.ts", kind: "modified" }],
      opaque: false,
    },
    { cmd: "echo x > $OUT", opaque: true },
    { cmd: "rm -rf build/*", opaque: true },
    { cmd: "git checkout -- src/", opaque: true },
    { cmd: "git apply fix.patch", opaque: true },
    { cmd: "curl page | sh", opaque: true },
    { cmd: "cat > file <<EOF\nx\nEOF", opaque: true },
    { cmd: 'python3 -c \'open("x","w").write("1")\'', opaque: true },
  ];
  for (const c of cases) {
    test(`${JSON.stringify(c.cmd)} → opaque=${c.opaque}`, () => {
      const hints = bashWriteHints(c.cmd);
      expect(hints.opaque).toBe(c.opaque);
      if (c.paths) expect(hints.paths).toEqual(c.paths as never);
    });
  }
});

describe("confidence: blind caps at yellow", () => {
  test("a would-be green with blind=true reads yellow", () => {
    expect(confidence(GREEN).tier).toBe("green");
    expect(confidence({ ...GREEN, blind: true })).toEqual({
      tier: "yellow",
      reason: "unattributed writes this run",
    });
  });

  test("blind never upgrades a red", () => {
    expect(confidence({ ...GREEN, pass: false, blind: true }).tier).toBe("red");
    expect(confidence({ ...GREEN, tamper: true, blind: true }).tier).toBe("red");
  });

  test("parseFactors tolerates the additive blind field and rejects a corrupt one", () => {
    expect(parseFactors(JSON.stringify({ ...GREEN, blind: true }))?.blind).toBe(true);
    expect(parseFactors(JSON.stringify(GREEN))?.blind).toBeUndefined();
    expect(parseFactors(JSON.stringify({ ...GREEN, blind: "yes" }))).toBeNull();
  });
});

describe("recordFileChanges (shared attribution sink body)", () => {
  test("bash write targets land as file_changes with the writer's agent_id", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "write out.txt", status: "in_progress" },
    ]);
    recordFileChanges(d, "run1", "bash", { command: "echo hi > out.txt" }, "child-1");
    const rows = d.getFileChanges(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("out.txt");
    expect(rows[0]!.kind).toBe("modified");
    expect(rows[0]!.agent_id).toBe("child-1");
    expect(rows[0]!.origin).toBe("on_plan");
  });

  test("an opaque bash mutation lands as ONE kind='opaque' row, origin unknown", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    recordFileChanges(d, "run1", "bash", { command: "git checkout -- src/" }, null);
    const rows = d.getFileChanges(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("opaque");
    expect(rows[0]!.origin).toBe("unknown");
    expect(rows[0]!.path).toContain("git checkout");
  });

  test("pure reads record nothing; lead write/edit keeps agent_id NULL", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    recordFileChanges(d, "run1", "bash", { command: "ls src" }, null);
    expect(d.getFileChanges(planId)).toHaveLength(0);
    recordFileChanges(d, "run1", "write", { path: "src/a.ts", content: "x" }, null);
    const rows = d.getFileChanges(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBeNull();
  });
});

describe("bigPlanAttributionSink (sub-agents)", () => {
  const actx = (name: string, args: Record<string, unknown>, isError = false) =>
    ({ toolCall: { type: "toolCall", id: "c1", name, arguments: args }, isError }) as never;

  test("records child writes with agent_id; hard-skips todowrite and errors", async () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    const sink = bigPlanAttributionSink({ db: d, runId: "run1" }, "child-9");
    await sink(actx("write", { path: "src/kid.ts", content: "x" }));
    await sink(
      actx("todowrite", { tasks: JSON.stringify([{ content: "evil", status: "completed" }]) }),
    );
    await sink(actx("write", { path: "src/err.ts", content: "x" }, true));
    const rows = d.getFileChanges(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("child-9");
    // The child todowrite never reached the plan: the lead's step survives untouched.
    expect(d.getPlanSteps(planId).map((s) => s.id)).toEqual(stepIds);
  });

  test("recordOpaqueMarker leaves one blind marker for a worktree child", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    recordOpaqueMarker(d, "run1", "subagent:child-3 (worktree)", "child-3");
    const rows = d.getFileChanges(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("opaque");
    expect(rows[0]!.path).toBe("subagent:child-3 (worktree)");
  });
});

describe("done-gate: blind evidence caps the verdict", () => {
  const bctx = (todos: unknown[]) =>
    ({
      toolCall: { type: "toolCall", id: "t1", name: "todowrite", arguments: {} },
      args: { tasks: JSON.stringify(todos) },
    }) as never;
  const actx = (todos: unknown[]) =>
    ({
      toolCall: {
        type: "toolCall",
        id: "t1",
        name: "todowrite",
        arguments: { tasks: JSON.stringify(todos) },
      },
      isError: false,
    }) as never;

  test("an opaque bash earlier in the run makes the passing verdict blind (yellow cap)", async () => {
    const d = db();
    d.ensureProject("p");
    const runId = d.startRun({ projectKey: "p" });
    d.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress", verify: "true" }]);
    // A pre-gate opaque mutation recorded only in tool_calls (e.g. before any plan existed).
    d.writeToolCall({
      runId,
      toolName: "bash",
      args: { command: "git checkout -- src/" },
      result: "",
      isError: false,
    });
    const { before, after } = bigPlanHooks({ db: d, runId });
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const plan = d.getLatestPlan(runId)!;
    const row = d.getGates(plan.id)[0]!;
    expect(row.outcome).toBe("verified");
    expect(parseFactors(row.factors_json)?.blind).toBe(true);
  });

  test("without unattributed writes the verdict is not blind", async () => {
    const d = db();
    d.ensureProject("p");
    const runId = d.startRun({ projectKey: "p" });
    d.upsertPlanFromTodos(runId, [{ content: "A", status: "in_progress", verify: "true" }]);
    const { before, after } = bigPlanHooks({ db: d, runId });
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const plan = d.getLatestPlan(runId)!;
    expect(parseFactors(d.getGates(plan.id)[0]!.factors_json)?.blind).toBe(false);
  });
});
