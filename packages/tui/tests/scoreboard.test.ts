/**
 * Task-type × model scoreboards: ledger SQL (routing_decisions ⋈ gates by rec_id, latest
 * gate per decision, project-scoped), the n-floor, the /bp table, the bounded SYNTH-context
 * injection, finalize advisories, and the zero-writes guarantee. Hermetic: in-memory DB +
 * faux provider; no network, no spend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type FauxRegistration,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { type DecisionWrite, MinimaDb } from "../src/db/minima_db.ts";
import { runCouncilRound } from "../src/minima/plan_council.ts";
import { PlanSessionStore } from "../src/minima/plan_session.ts";
import {
  SCOREBOARD_CONTEXT_CAP_CHARS,
  SCOREBOARD_MIN_N,
  type ScoreboardCell,
  renderScoreboardContext,
  renderScoreboardTable,
  runTaskTypes,
  scoreboardAdvisories,
  taskTypeScoreboard,
} from "../src/minima/scoreboard.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";

let recSeq = 0;

function writeDecision(
  db: MinimaDb,
  runId: string,
  over: Partial<DecisionWrite> & { taskType: string; chosenModel: string },
): string {
  const recId = over.recId ?? `rec-${++recSeq}`;
  db.writeDecision({
    recId,
    runId,
    taskLabel: "task",
    decisionBasis: "memory",
    confidence: 0.8,
    thresholdUsed: 0.5,
    ranked: [],
    estCostUsd: 0.001,
    actualCostUsd: 0.001,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 10,
    ...over,
  });
  return recId;
}

function label(
  db: MinimaDb,
  recId: string,
  tier: "green" | "yellow" | "red",
  verifiedBy: "deterministic" | "judge" | "user" = "deterministic",
): void {
  db.insertGate({
    recId,
    outcome: tier === "red" ? "failed" : "verified",
    confidence: tier,
    verifiedBy,
  });
}

function fixture(): { db: MinimaDb; runId: string } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  return { db, runId };
}

/** k labeled decisions for (taskType, model): `greens` green, `reds` red, rest yellow. */
function seedCell(
  db: MinimaDb,
  runId: string,
  taskType: string,
  model: string,
  opts: { greens: number; reds: number; yellows?: number; costs?: number[] },
): void {
  const tiers: ("green" | "red" | "yellow")[] = [
    ...Array<"green">(opts.greens).fill("green"),
    ...Array<"red">(opts.reds).fill("red"),
    ...Array<"yellow">(opts.yellows ?? 0).fill("yellow"),
  ];
  tiers.forEach((tier, i) => {
    const recId = writeDecision(db, runId, {
      taskType,
      chosenModel: model,
      actualCostUsd: opts.costs?.[i] ?? 0.001,
    });
    label(db, recId, tier);
  });
}

describe("taskTypeScoreboard", () => {
  test("aggregates gate-labeled decisions per (task_type, model) with median cost", () => {
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "claude-x", {
      greens: 2,
      reds: 1,
      costs: [0.01, 0.04, 0.02],
    });
    const cells = taskTypeScoreboard(db, "proj");
    expect(cells).toHaveLength(1);
    const c = cells[0]!;
    expect(c.taskType).toBe("code");
    expect(c.model).toBe("claude-x");
    expect(c.n).toBe(3);
    expect(c.greens).toBe(2);
    expect(c.reds).toBe(1);
    expect(c.greenRate).toBeCloseTo(2 / 3);
    expect(c.redRate).toBeCloseTo(1 / 3);
    expect(c.medianCostUsd).toBeCloseTo(0.02);
  });

  test("suppresses cells below the n-floor", () => {
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "thin-model", { greens: SCOREBOARD_MIN_N - 1, reds: 0 });
    seedCell(db, runId, "code", "thick-model", { greens: SCOREBOARD_MIN_N, reds: 0 });
    expect(taskTypeScoreboard(db, "proj").map((c) => c.model)).toEqual(["thick-model"]);
  });

  test("unlabeled decisions (no gate) and other projects never count", () => {
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "claude-x", { greens: 3, reds: 0 });
    for (let i = 0; i < 5; i++) {
      writeDecision(db, runId, { taskType: "code", chosenModel: "claude-x" }); // no gate
    }
    db.ensureProject("other");
    const otherRun = db.startRun({ projectKey: "other" });
    seedCell(db, otherRun, "code", "other-model", { greens: 4, reds: 0 });

    const cells = taskTypeScoreboard(db, "proj");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.n).toBe(3);
    expect(taskTypeScoreboard(db, "other").map((c) => c.model)).toEqual(["other-model"]);
  });

  test("a decision is labeled by its LATEST gate only", () => {
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "claude-x", { greens: 2, reds: 0 });
    const recId = writeDecision(db, runId, { taskType: "code", chosenModel: "claude-x" });
    label(db, recId, "green");
    label(db, recId, "red"); // newest verdict wins
    const c = taskTypeScoreboard(db, "proj")[0]!;
    expect(c.n).toBe(3);
    expect(c.greens).toBe(2);
    expect(c.reds).toBe(1);
  });

  test("a green gate only counts when deterministically verified", () => {
    const { db, runId } = fixture();
    for (let i = 0; i < 3; i++) {
      const recId = writeDecision(db, runId, { taskType: "code", chosenModel: "claude-x" });
      label(db, recId, "green", "judge");
    }
    const c = taskTypeScoreboard(db, "proj")[0]!;
    expect(c.n).toBe(3);
    expect(c.greens).toBe(0);
  });
});

describe("runTaskTypes", () => {
  test("distinct task types of one run's decisions", () => {
    const { db, runId } = fixture();
    writeDecision(db, runId, { taskType: "code", chosenModel: "m" });
    writeDecision(db, runId, { taskType: "code", chosenModel: "m" });
    writeDecision(db, runId, { taskType: "reasoning", chosenModel: "m" });
    const otherRun = db.startRun({ projectKey: "proj" });
    writeDecision(db, otherRun, { taskType: "summarize", chosenModel: "m" });
    expect(runTaskTypes(db, runId).sort()).toEqual(["code", "reasoning"]);
  });
});

describe("rendering", () => {
  test("/bp table renders only when data exists", () => {
    expect(renderScoreboardTable([])).toBe("");
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "claude-x", { greens: 3, reds: 0 });
    const table = renderScoreboardTable(taskTypeScoreboard(db, "proj"));
    expect(table).toContain("Model scoreboard");
    expect(table).toContain("claude-x");
    expect(table).toContain("100%");
  });

  test("SYNTH context rendering is bounded and drops whole trailing lines", () => {
    expect(renderScoreboardContext([])).toBe("");
    const many: ScoreboardCell[] = Array.from({ length: 40 }, (_, i) => ({
      taskType: `task-type-${i}`,
      model: `some-rather-long-model-id-${i}`,
      n: 5,
      greens: 4,
      reds: 1,
      greenRate: 0.8,
      redRate: 0.2,
      medianCostUsd: 0.0123,
    }));
    const ctx = renderScoreboardContext(many);
    expect(ctx.length).toBeLessThanOrEqual(SCOREBOARD_CONTEXT_CAP_CHARS);
    expect(ctx).toContain("Observed model scoreboard");
    for (const line of ctx.split("\n").slice(1)) expect(line).toMatch(/^- task-type-\d+ · /);
  });
});

describe("scoreboardAdvisories", () => {
  const cell = (over: Partial<ScoreboardCell>): ScoreboardCell => ({
    taskType: "code",
    model: "m",
    n: 4,
    greens: 4,
    reds: 0,
    greenRate: 1,
    redRate: 0,
    medianCostUsd: 0.001,
    ...over,
  });

  test("suggests a strictly better non-pool model, phrased as /profile set", () => {
    const cells = [
      cell({ model: "pool-model", greens: 1, n: 3, greenRate: 1 / 3 }),
      cell({ model: "challenger", greens: 4, n: 4, greenRate: 1 }),
    ];
    const lines = scoreboardAdvisories(cells, ["pool-model"], ["code"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("challenger is 4/4 green on code");
    expect(lines[0]).toContain("pool-model, 1/3");
    expect(lines[0]).toContain("/profile set");
  });

  test("no advisory when the pool's best is at least as good, or without a pool baseline", () => {
    const tied = [
      cell({ model: "pool-model", greenRate: 1 }),
      cell({ model: "challenger", greenRate: 1 }),
    ];
    expect(scoreboardAdvisories(tied, ["pool-model"])).toEqual([]);
    // No in-pool cell for the task type → nothing to compare against.
    expect(scoreboardAdvisories([cell({ model: "challenger" })], ["pool-model"])).toEqual([]);
  });

  test("restricts to task types the plan's run touched", () => {
    const cells = [
      cell({ taskType: "summarize", model: "pool-model", greens: 1, n: 3, greenRate: 1 / 3 }),
      cell({ taskType: "summarize", model: "challenger", greens: 4, n: 4, greenRate: 1 }),
    ];
    expect(scoreboardAdvisories(cells, ["pool-model"], ["code"])).toEqual([]);
    expect(scoreboardAdvisories(cells, ["pool-model"], ["summarize"])).toHaveLength(1);
    // Empty touched-list = no restriction (the run routed nothing typed).
    expect(scoreboardAdvisories(cells, ["pool-model"], [])).toHaveLength(1);
  });
});

describe("zero writes", () => {
  test("every scoreboard read leaves total_changes untouched", () => {
    const { db, runId } = fixture();
    seedCell(db, runId, "code", "claude-x", { greens: 3, reds: 1 });
    seedCell(db, runId, "reasoning", "gpt-x", { greens: 4, reds: 0 });
    const changes = () => (db.db.query("SELECT total_changes() AS c").get() as { c: number }).c;

    const before = changes();
    const cells = taskTypeScoreboard(db, "proj");
    runTaskTypes(db, runId);
    renderScoreboardTable(cells);
    renderScoreboardContext(cells);
    scoreboardAdvisories(cells, ["claude-x"], ["code", "reasoning"]);
    expect(changes()).toBe(before);
    expect(cells.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------- SYNTH-context injection

const META_MODEL: Model = {
  id: "meta-faux",
  provider: "faux",
  api: "faux",
  name: "Meta Faux",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

const msg = (s: string): AssistantMessage => new AssistantMessage({ content: [text(s)] });
const json = (v: unknown): AssistantMessage => msg(JSON.stringify(v));

const mockSpawn: SpawnFn = async (d: Delegation): Promise<ChildResult> => ({
  step_id: d.step_id,
  childId: `${d.step_id}-child`,
  text: `finding for ${d.objective}`,
  costUsd: 0.01,
  quality: 0.9,
  outcome: "success",
  workdir: null,
});

describe("plan-council SYNTH context injection", () => {
  let reg: FauxRegistration;

  beforeEach(() => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(META_MODEL);
    reg = registerFauxProvider([META_MODEL]);
  });

  afterEach(() => reg.unregister());

  const roundResponses = () => [
    json([{ focus: "look", boundaries: "ro", output_format: "notes", difficulty: "easy" }]),
    json([]), // keeper post-check
    msg("Draft plan."),
    json([]), // critic fresh-draft attack: sound
    json({ plan: "Final plan.", decisions: [], findings: [], questions: [] }),
  ];

  test("opts.scoreboard lands verbatim in the SYNTH prompt", async () => {
    reg.setResponses(roundResponses());
    const scoreboard = renderScoreboardContext([
      {
        taskType: "code",
        model: "claude-x",
        n: 5,
        greens: 4,
        reds: 1,
        greenRate: 0.8,
        redRate: 0.2,
        medianCostUsd: 0.0123,
      },
    ]);
    const session = new PlanSessionStore("goal").session;
    await runCouncilRound(session, "please plan something substantive here", {
      parent: {} as never,
      metaModel: META_MODEL,
      spawn: mockSpawn,
      signal: null,
      scoreboard,
    });
    const synthReq = reg.state.requests.find((r) => r.user.includes("Produce the round result."));
    expect(synthReq).toBeDefined();
    expect(synthReq!.user).toContain(scoreboard);
    // Only the SYNTH stage sees it — not the researcher-scope or draft prompts.
    for (const r of reg.state.requests) {
      if (r === synthReq) continue;
      expect(r.user).not.toContain("Observed model scoreboard");
    }
  });

  test("without opts.scoreboard the SYNTH prompt carries no scoreboard block", async () => {
    reg.setResponses(roundResponses());
    const session = new PlanSessionStore("goal").session;
    await runCouncilRound(session, "please plan something substantive here", {
      parent: {} as never,
      metaModel: META_MODEL,
      spawn: mockSpawn,
      signal: null,
    });
    const synthReq = reg.state.requests.find((r) => r.user.includes("Produce the round result."));
    expect(synthReq).toBeDefined();
    expect(synthReq!.user).not.toContain("Observed model scoreboard");
  });
});
