import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { MinimaDb, type PlanRow } from "../src/db/minima_db.ts";
import { groundTruthHooks } from "../src/minima/ground_truth.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { finalizePlan } from "../src/minima/plan_finalize.ts";
import {
  type CouncilRoundResult,
  type GroundTruthSynthesis,
  PlanSessionStore,
} from "../src/minima/plan_session.ts";
import { todowriteTool } from "../src/tools/todowrite.ts";
import { writeTool } from "../src/tools/write.ts";

// MP13 — the plan-loop audit: one scripted GT run driving plan→execute→verify→learn against the
// faux provider, asserting EVERY ledger row the spine writes. Test 1 pins the /plan finalize →
// seedPlanFromSteps bridge (user-origin checks, pending steps). Test 2 executes the seeded plan
// through the real done-gate (baseline red → blocked completion → escalation → red→green pass →
// closure) and dumps plans/plan_steps/gates/file_changes/routing_decisions plus both feedback
// payloads. Test 3 pins the write-only constants (synced/schema_v), the sticky-verify + baseline
// -void swap semantics, and the zero-consent baseline execution MP18 exists to fix.

const CHEAP: Model = {
  id: "cheap-model",
  provider: "faux",
  api: "faux",
  name: "Cheap",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const BIG: Model = {
  id: "big-model",
  provider: "faux",
  api: "faux",
  name: "Big",
  cost: { input: 10, output: 20 },
  context_window: 8192,
  max_tokens: 4096,
};
const META: Model = {
  id: "meta-model",
  provider: "faux",
  api: "faux",
  name: "Meta",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 1024,
};

const STEP_ONE = "produce the audit outputs demo.txt and demo.flag";
const STEP_TWO = "record the audit summary notes";

const cannedRound = (): CouncilRoundResult => ({
  title: "Audit Loop",
  refinedGoal: "Drive the seeded two-step plan through the verified loop",
  draft: "1. produce the audit outputs\n2. record the audit summary",
  decisions: [
    { topic: "verification", decision: "gate on the flag file", rationale: "deterministic" },
  ],
  findings: [
    { source: "researcher", summary: "the flag file is the observable output", severity: "info" },
  ],
  faults: [],
  questions: [],
  facts: ["the loop must stay hermetic"],
  constraints: ["no network"],
  costUsd: 0.01,
  aborted: false,
});

const cannedSynth = (verify: string): GroundTruthSynthesis => ({
  title: "Audit Loop",
  goal: "drive the seeded plan through the verified loop",
  overview: "",
  requirements: [],
  constraints: [],
  decisions: [],
  approach: [
    { action: STEP_ONE, verify, tools: [] },
    { action: STEP_TWO, verify: "", tools: [] },
  ],
  risks: [],
  successCriteria: [],
  openItems: [],
});

// The /plan finalize core with canned council/synthesis — the exact seeding path exit_plan and
// /plan finalize share. The doc lands only in the injected writer, never on disk.
async function seedViaFinalize(db: MinimaDb, runId: string, dir: string, verify: string) {
  const store = new PlanSessionStore("audit goal");
  store.applyCouncilResult(cannedRound());
  store.recordUserTurn("approved: flag-gated two-step plan");
  const written: { path: string; content: string }[] = [];
  const outcome = await finalizePlan(store, {
    metaModel: META,
    signal: null,
    force: false,
    transcript: "User: audit goal\n\nPlanner: two verifiable steps",
    outPath: join(dir, "GROUND_TRUTH.md"),
    db,
    runId,
    write: async (path, content) => {
      written.push({ path, content: String(content) });
    },
    answerQuestions: async () => [],
    synthesize: async () => cannedSynth(verify),
  });
  return { outcome, written };
}

/** gt-e2e-style gated mock service: routes cheap→big once cheap is excluded, captures payloads. */
function gatedService(onEscalationRung: () => Promise<void>) {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      const req = init?.body ? JSON.parse(init.body) : {};
      recommendCalls.push(req);
      const excluded: string[] = req.constraints?.excluded_models ?? [];
      const pick = excluded.includes("cheap-model") ? "big-model" : "cheap-model";
      if (pick === "big-model") await onEscalationRung();
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: {
            model_id: pick,
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: pick,
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 1,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.7,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, recommendCalls, feedbackCalls };
}

describe("plan-loop audit (MP13)", () => {
  test("finalize seeds the ledger exactly as approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-audit-"));
    const db = new MinimaDb(join(dir, "audit.db"));
    db.ensureProject("p");
    const runId = db.startRun({ runId: "run-audit-1", projectKey: "p" });
    const verify = `test -f ${join(dir, "demo.flag")}`;

    const { outcome, written } = await seedViaFinalize(db, runId, dir, verify);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.seededCount).toBe(2);
    expect(outcome.synthFailed).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe(join(dir, "GROUND_TRUTH.md"));
    expect(written[0]!.content).toContain(`verify: \`${verify}\``);
    expect(existsSync(join(dir, "GROUND_TRUTH.md"))).toBe(false); // memory-only writer

    const plans = db.db.query("SELECT * FROM plans WHERE session_id = ?").all(runId) as PlanRow[];
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe("active");
    expect(plans[0]!.closed_at).toBeNull();
    expect(plans[0]!.title).toBe("Audit Loop");

    const steps = db.getPlanSteps(plans[0]!.id);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.idx)).toEqual([0, 1]);
    expect(steps.map((s) => s.content)).toEqual([STEP_ONE, STEP_TWO]);
    expect(steps.map((s) => s.status)).toEqual(["pending", "pending"]);
    expect(steps[0]!.verify).toBe(verify); // verbatim — the user-approved check
    expect(steps[1]!.verify).toBeNull(); // "" trims to NULL, never an empty-string check
    expect(steps[0]!.check_origin).toBe("user"); // approved at finalize, not agent homework
    expect(steps[1]!.check_origin).toBeNull();
    expect(steps.map((s) => s.baseline)).toEqual([null, null]); // captured at execution, not seed
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the executed loop writes every ledger table coherently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-audit-"));
    const flag = join(dir, "demo.flag");
    const notes = join(dir, "demo.txt");
    const verify = `test -f ${flag}`;

    const db = new MinimaDb(join(dir, "audit.db"));
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const { outcome } = await seedViaFinalize(db, runId, dir, verify);
    expect(outcome.kind).toBe("ok");
    const planId = db.getActivePlan(runId)!.id;
    const stepIds = db.getPlanSteps(planId).map((s) => s.id);

    // Between-rung snapshot, taken inside the escalation recommend: rung 1's blocked attempt
    // must already be durable while nothing was completed and the plan is still open.
    const midLoop: {
      planStatus: string | null;
      stepStatus: string | null;
      baseline: string | null;
      gates: { outcome: string | null; recId: string | null }[];
    }[] = [];
    const { fetchLike, recommendCalls, feedbackCalls } = gatedService(async () => {
      const step = db.getPlanSteps(planId)[0]!;
      midLoop.push({
        planStatus: db.getPlan(planId)!.status,
        stepStatus: step.status,
        baseline: step.baseline,
        gates: db.getGates(planId).map((g) => ({ outcome: g.outcome, recId: g.rec_id })),
      });
    });

    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(CHEAP);
    registerModel(BIG);
    const reg = registerFauxProvider([CHEAP, BIG]);
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["cheap-model", "big-model"],
      allowOffline: false,
      minimaApiKey: "k",
      groundTruth: true,
      stopStrikes: 0, // this test scripts the done-gate ladder, not the A2 stop-gate
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const agent = new MinimaAgent({
      config,
      router,
      meter: new CostMeter(),
      tools: [todowriteTool([], { groundTruth: true }), writeTool()],
    });
    agent.db = db;
    agent.runId = runId;

    // Judge stays OFF (default abstain) — every grade below must come from gates. The gate's
    // before-hook is wrapped only to capture the block verdict the tool result carries.
    const { before: beforeGate, after: afterGate } = groundTruthHooks(agent);
    const blocks: { tool: string; reason: string }[] = [];
    agent.addBeforeToolCall(async (ctx) => {
      const decision = await beforeGate(ctx);
      if (decision?.block) blocks.push({ tool: ctx.toolCall.name, reason: decision.reason });
      return decision;
    });
    agent.addAfterToolCall(afterGate);

    const start = [
      { content: STEP_ONE, status: "in_progress", verify },
      { content: STEP_TWO, status: "pending" },
    ];
    const redDone = [
      { content: STEP_ONE, status: "completed" },
      { content: STEP_TWO, status: "pending" },
    ];
    const allDone = [
      { content: STEP_ONE, status: "completed" },
      { content: STEP_TWO, status: "completed" },
    ];
    // Rung 1 (cheap, rec-1): adopt the seeded plan (baseline runs red: flag absent), do claimed
    // work (demo.txt → on_plan file_change), then claim completion while red → the done-gate
    // blocks mid-dispatch and mints the failed attempt under rec-1. Rung 2 (big, rec-2): create
    // the flag via a real write tool call, then complete → verified, plan closes.
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("tc-plan", "todowrite", { tasks: JSON.stringify(start) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-notes", "write", { path: notes, content: "audit notes\n" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-red", "todowrite", { tasks: JSON.stringify(redDone) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("blocked on cheap")] }),
      new AssistantMessage({
        content: [toolCall("tc-work", "write", { path: flag, content: "ok\n" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-green", "todowrite", { tasks: JSON.stringify(allDone) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done on big")] }),
    ]);

    const routing = await agent.promptRouted("execute the audit plan");

    // --- the ladder: one escalation, recovered on the bigger model ---
    expect(routing?.chosenModelId).toBe("big-model");
    expect(agent.ladderEscalations).toBe(1);
    expect(recommendCalls).toHaveLength(2);
    expect((recommendCalls[1] as any).constraints?.excluded_models).toContain("cheap-model");

    // --- the block: the refused todowrite's tool result carried the check failure ---
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tool).toBe("todowrite");
    expect(blocks[0]!.reason).toContain(`Step not verified — "${STEP_ONE}"`);
    expect(blocks[0]!.reason).toContain(verify);

    // --- between rungs: the failed attempt was durable before any recovery ran ---
    expect(midLoop).toHaveLength(1);
    expect(midLoop[0]!.planStatus).toBe("active");
    expect(midLoop[0]!.stepStatus).toBe("in_progress");
    expect(midLoop[0]!.baseline).toBe("red");
    expect(midLoop[0]!.gates).toEqual([{ outcome: "failed", recId: "rec-1" }]);

    // --- plans: closed by the completing after-hook ---
    const plan = db.getPlan(planId)!;
    expect(plan.status).toBe("done");
    expect(plan.closed_at).not.toBeNull();

    // --- plan_steps: seeded ids survived the whole loop; red baseline is permanent evidence ---
    const steps = db.getPlanSteps(planId);
    expect(steps.map((s) => s.id)).toEqual(stepIds);
    expect(steps[0]).toMatchObject({
      idx: 0,
      status: "completed",
      verify,
      baseline: "red",
      check_origin: "user",
    });
    expect(steps[1]).toMatchObject({
      idx: 1,
      status: "completed",
      verify: null,
      baseline: null,
      check_origin: null,
    });

    // --- file_changes: both writes attributed to the in-progress step, on_plan (claimed) ---
    const changes = db.getFileChanges(planId).map((c) => ({
      path: c.path,
      kind: c.kind,
      origin: c.origin,
      stepId: c.step_id,
      agentId: c.agent_id,
    }));
    expect(changes).toEqual([
      { path: notes, kind: "created", origin: "on_plan", stepId: stepIds[0]!, agentId: null },
      { path: flag, kind: "created", origin: "on_plan", stepId: stepIds[0]!, agentId: null },
    ]);

    // --- gates: blocked attempt, red→green pass, the verify-less completion, the rollup.
    // step_check rows store confidence NULL (tier is derived from factors at read time); the
    // milestone rolls up "unchecked" because the verify-less step 2's terminal gate is unchecked.
    const gates = db.getGates(planId);
    expect(
      gates.map((g) => ({
        kind: g.kind,
        outcome: g.outcome,
        confidence: g.confidence,
        verifiedBy: g.verified_by,
        stepId: g.step_id,
        recId: g.rec_id,
        sessionId: g.session_id,
      })),
    ).toEqual([
      {
        kind: "step_check",
        outcome: "failed",
        confidence: null,
        verifiedBy: "deterministic",
        stepId: stepIds[0]!,
        recId: "rec-1",
        sessionId: runId,
      },
      {
        kind: "step_check",
        outcome: "verified",
        confidence: null,
        verifiedBy: "deterministic",
        stepId: stepIds[0]!,
        recId: "rec-2",
        sessionId: runId,
      },
      {
        kind: "step_check",
        outcome: "unchecked",
        confidence: null,
        verifiedBy: null,
        stepId: stepIds[1]!,
        recId: "rec-2",
        sessionId: runId,
      },
      {
        kind: "milestone",
        outcome: "unchecked",
        confidence: "yellow",
        verifiedBy: null,
        stepId: null,
        recId: "rec-2",
        sessionId: runId,
      },
    ]);
    const failFactors = JSON.parse(gates[0]!.factors_json!) as Record<string, unknown>;
    expect(failFactors.pass).toBe(false);
    expect(failFactors.checkOrigin).toBe("user"); // the stored origin outranks classification
    const passFactors = JSON.parse(gates[1]!.factors_json!) as Record<string, unknown>;
    expect(passFactors.pass).toBe(true);
    expect(passFactors.redToGreen).toBe(true); // measured against the captured red baseline
    expect(passFactors.checkOrigin).toBe("user");
    expect(passFactors.coverageHit).toBe("unknown"); // `test -f` names no test file → never green

    // --- routing_decisions: two rungs, grounded stamps, the escalation chain ---
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rec_id).toBe("rec-1");
    expect(rows[0]!.chosen_model).toBe("cheap-model");
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[0]!.quality).toBeNull(); // gate verdict → label only, no fabricated quality
    expect(rows[0]!.judged).toBe(0);
    expect(rows[0]!.gt_outcome).toBe("failed");
    expect(rows[0]!.gt_verified_by).toBe("deterministic");
    expect(rows[0]!.gt_confidence).toBe("red");
    expect(rows[0]!.parent_rec_id).toBeNull();
    expect(rows[0]!.step_id).toBe(stepIds[0]!); // the in-progress step at persist time
    expect(rows[1]!.rec_id).toBe("rec-2");
    expect(rows[1]!.chosen_model).toBe("big-model");
    // A7 graded outcome: the pass is a YELLOW check (user-origin + red→green but coverage
    // unknown), so the label is `partial`, never a fabricated clean `success`.
    expect(rows[1]!.outcome).toBe("partial");
    expect(rows[1]!.quality).toBeNull();
    expect(rows[1]!.judged).toBe(0);
    expect(rows[1]!.gt_outcome).toBe("verified");
    expect(rows[1]!.gt_verified_by).toBe("deterministic");
    expect(rows[1]!.gt_confidence).toBe("yellow");
    expect(rows[1]!.parent_rec_id).toBe("rec-1"); // the ladder chained rung 2 → rung 1
    // Plan closure precedes persistDecision, so the closing rung's row loses its step stamp.
    expect(rows[1]!.step_id).toBeNull();
    for (const r of rows) {
      expect(r.routed).toBe("server");
      expect(r.synced).toBe(0);
      expect(r.schema_v).toBe(2);
      expect(r.actual_cost_usd as number).toBeGreaterThan(0);
    }

    // --- feedback: realized numbers only, labels from the deterministic mapping, vip never
    // claimed below green. Faux usage carries zero input tokens and the router omits zero
    // fields, so input_tokens is ABSENT here — output/cost/latency are the realized evidence.
    expect(feedbackCalls).toHaveLength(2);
    const fb1 = feedbackCalls[0] as Record<string, unknown>;
    const fb2 = feedbackCalls[1] as Record<string, unknown>;
    expect(fb1.recommendation_id).toBe("rec-1");
    expect(fb1.outcome).toBe("failure");
    expect(fb1.judged).toBe(false);
    expect(fb1.quality_score).toBeUndefined();
    expect(fb1.verified_in_production).toBe(false);
    expect(String(fb1.notes)).toBe("verified_by=deterministic;tier=red");
    expect(fb1.input_tokens).toBeUndefined();
    expect(fb1.output_tokens as number).toBeGreaterThan(0);
    expect(fb1.actual_cost_usd as number).toBeCloseTo(rows[0]!.actual_cost_usd as number, 8);
    expect(fb1.latency_ms).toBe(rows[0]!.latency_ms);
    expect(fb2.recommendation_id).toBe("rec-2");
    expect(fb2.outcome).toBe("partial");
    expect(fb2.judged).toBe(false);
    expect(fb2.quality_score).toBeUndefined();
    expect(fb2.verified_in_production).toBe(false); // yellow pass — vip is green-only
    expect(String(fb2.notes)).toBe("verified_by=deterministic;tier=yellow");
    expect(fb2.input_tokens).toBeUndefined();
    expect(fb2.output_tokens as number).toBeGreaterThan(0);
    expect(fb2.actual_cost_usd as number).toBeCloseTo(rows[1]!.actual_cost_usd as number, 8);
    expect(fb2.latency_ms).toBe(rows[1]!.latency_ms);

    reg.unregister();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("audit seeds pinned as executable facts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-audit-"));
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(CHEAP);
    const reg = registerFauxProvider([CHEAP]);
    const { fetchLike } = gatedService(async () => {});
    const config = harnessConfig({
      candidates: ["cheap-model"],
      allowOffline: false,
      minimaApiKey: "k",
      groundTruth: true,
      stopStrikes: 0,
    });

    // (a) write-only constants: every routed decision row lands synced=0, schema_v=2.
    {
      const db = new MinimaDb(join(dir, "seeds.db"));
      db.ensureProject("p");
      const runId = db.startRun({ projectKey: "p" });
      const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
      const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
      const agent = new MinimaAgent({ config, router, meter: new CostMeter(), tools: [] });
      agent.db = db;
      agent.runId = runId;
      reg.setResponses([
        new AssistantMessage({ content: [text("one")] }),
        new AssistantMessage({ content: [text("two")] }),
      ]);
      await agent.promptRouted("first prompt");
      await agent.promptRouted("second prompt");
      const rows = db.db
        .query("SELECT synced, schema_v FROM routing_decisions ORDER BY ts")
        .all() as { synced: number; schema_v: number }[];
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.synced).toBe(0);
        expect(r.schema_v).toBe(2);
      }
      db.close();
    }

    // (b) verify is uncleanable (omission keeps it) and a CHANGED verify voids the baseline —
    // red→green evidence is scoped to the check that produced the red.
    {
      const db = new MinimaDb(":memory:");
      db.ensureProject("p");
      const runId = db.startRun({ projectKey: "p" });
      const first = db.upsertPlanFromTodos(runId, [
        { content: "wire the audit step", status: "in_progress", verify: "test -f a.flag" },
      ]);
      db.setStepBaseline(first.stepIds[0]!, "red");
      db.upsertPlanFromTodos(runId, [{ content: "wire the audit step", status: "in_progress" }]);
      let step = db.getPlanSteps(first.planId)[0]!;
      expect(step.verify).toBe("test -f a.flag"); // omitted → COALESCE kept it
      expect(step.baseline).toBe("red");
      db.upsertPlanFromTodos(runId, [
        { content: "wire the audit step", status: "in_progress", verify: "test -f b.flag" },
      ]);
      step = db.getPlanSteps(first.planId)[0]!;
      expect(step.verify).toBe("test -f b.flag"); // overwrite allowed
      expect(step.baseline).toBeNull(); // the swap voided the old red
      db.close();
    }

    // (c) headless zero-consent fact: hooks wired exactly as cli/main.ts wires them today (no
    // consent seam), so an LLM-authored baseline verify EXECUTES the moment a step goes
    // in_progress. This is the red fact MP18 fixes at the wiring layer.
    {
      const leak = join(dir, "consent-leak");
      const db = new MinimaDb(join(dir, "consent.db"));
      db.ensureProject("p");
      const runId = db.startRun({ projectKey: "p" });
      const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
      const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
      const agent = new MinimaAgent({
        config,
        router,
        meter: new CostMeter(),
        tools: [todowriteTool([], { groundTruth: true })],
      });
      agent.db = db;
      agent.runId = runId;
      const { before, after } = groundTruthHooks(agent, {
        enforceAllowlist: config.toolAllowlist, // main.ts:485 builds the hooks exactly so
      });
      agent.addAfterToolCall(after);
      agent.addBeforeToolCall(before); // main.ts:580 (headless) registers the gate too
      const tasks = [
        {
          content: "prepare the consent audit step",
          status: "in_progress",
          verify: `touch ${leak}`,
        },
      ];
      reg.setResponses([
        new AssistantMessage({
          content: [toolCall("tc-leak", "todowrite", { tasks: JSON.stringify(tasks) })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({ content: [text("planned")] }),
      ]);
      expect(existsSync(leak)).toBe(false);
      await agent.promptRouted("plan the step");
      expect(existsSync(leak)).toBe(true); // the verify RAN — no consent was ever asked
      const plan = db.getLatestPlan(runId)!;
      expect(db.getPlanSteps(plan.id)[0]!.baseline).toBe("green"); // and its result was recorded
      db.close();
    }

    reg.unregister();
    rmSync(dir, { recursive: true, force: true });
  });
});
