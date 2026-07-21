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
import { bigPlanHooks } from "../src/minima/big_plan.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { type PlanFinalizeOutcome, finalizePlan } from "../src/minima/plan_finalize.ts";
import { SEED_ROUND_1 } from "../src/minima/plan_seed.ts";
import { type BigPlanSynthesis, PlanSessionStore } from "../src/minima/plan_session.ts";
import { whyReportFor } from "../src/minima/why.ts";
import { exitPlanTool } from "../src/tools/exit_plan.ts";
import type { QuestionParams } from "../src/tools/question.ts";
import { todowriteTool } from "../src/tools/todowrite.ts";
import { writeTool } from "../src/tools/write.ts";
import { buildPlanOverview, stepCardLines } from "../src/tui/plan_overview.ts";
import { draftPanelState, draftRows } from "../src/tui/plan_draft_view.ts";

// MP19 — the Track W acceptance story, in-process and hermetic. ONE run that: (1) PLANS — a
// council round lands in the PlanSessionStore and the MP16 draft view renders it; (2) APPROVES
// through the exit_plan tool (MP17 contract) — finalize seeds the check-engine ledger and, per
// MP18, the approval IS the seeded verify's consent event; (3) EXECUTES through the REAL
// done-gate with the strict consent checker installed — consented baseline runs red, a premature
// completion is blocked mid-dispatch, the fix flips the check red→green, the plan closes with a
// milestone; (4) LEARNS — the captured /v1/feedback carries realized usage and the A7
// deterministic outcome mapping; (5) shows EVIDENCE — the Ctrl+G overview and /why report tell
// the red→green story. Composes the proven harnesses of plan-loop-audit.test.ts (finalize
// seeding + scripted rung), big-plan-e2e.test.ts (flag-file done-gate), and verify-consent.test.ts.

const WORKER: Model = {
  id: "worker-model",
  provider: "faux",
  api: "faux",
  name: "Worker",
  cost: { input: 1, output: 2 },
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

const ACTION = "Create the demo flag file";

const cannedSynth = (verify: string): BigPlanSynthesis => ({
  title: "Demo Widget Wiring",
  goal: "ship the demo widget behind a verifiable flag-file gate",
  overview: "",
  requirements: [],
  constraints: [],
  decisions: [],
  approach: [{ action: ACTION, verify, tools: [] }],
  risks: [],
  successCriteria: [],
  openItems: [],
});

/** plan-loop-audit-style mock service: one candidate, captures recommend + feedback payloads. */
function mockService() {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: {
            model_id: "worker-model",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "worker-model",
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

describe("MP19 — Track W acceptance demo (plan → approve → gated build → learn → evidence)", () => {
  test("one run composes the whole story end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "accept-e2e-"));
    const db = new MinimaDb(join(dir, "accept.db"));
    let reg: ReturnType<typeof registerFauxProvider> | null = null;
    try {
      db.ensureProject("p");
      const runId = db.startRun({ runId: "accept-run", projectKey: "p" });
      const flag = join(dir, "demo.flag");
      const verify = `test -f ${flag}`;

      // --- 1. PLAN: a council round lands in the store; the MP16 draft view sees it ---
      const store = new PlanSessionStore("ship the demo widget");
      store.applyCouncilResult(SEED_ROUND_1);
      const draft = draftRows(store, 100)
        .map((r) => r.text)
        .join("\n");
      expect(draft).toContain("Scaffold"); // a step line from the drafted plan
      expect(draft).toContain("Should the widget register eagerly or lazily?"); // open question
      expect(draftPanelState(store, 100).stack[0]!.title).toBe("plan (draft) · round 1");

      // --- 2. APPROVE via exit_plan: finalize seeds the ledger; approval IS verify consent ---
      const asked: QuestionParams[] = [];
      const written: { path: string; content: string }[] = [];
      const outcomes: PlanFinalizeOutcome[] = [];
      const tool = exitPlanTool({
        ask: {
          current: async (params) => {
            asked.push(params);
            return "Finalize & build";
          },
        },
        finalize: async () => {
          const outcome = await finalizePlan(store, {
            metaModel: META,
            signal: null,
            force: false,
            transcript: "User: ship the demo widget\n\nPlanner: one flag-gated step",
            outPath: join(dir, "BigPlan.md"),
            db,
            runId,
            write: async (path, content) => {
              written.push({ path, content: String(content) });
            },
            answerQuestions: async () => [],
            synthesize: async () => cannedSynth(verify),
          });
          outcomes.push(outcome);
          return {
            ok: outcome.kind === "ok",
            message: outcome.kind === "ok" ? "finalized — build mode on" : outcome.message,
          };
        },
        cancel: () => {},
        isActive: () => true,
        requiresPlan: () => false,
      });
      const approved = await tool.execute(
        "tc-exit",
        { summary: "Ship the demo widget." },
        null,
        null,
      );
      expect(asked).toHaveLength(1); // the decision flowed through the user-approval seam
      expect(approved.details?.choice).toBe("finalize");
      expect(approved.details?.ok).toBe(true);

      expect(outcomes).toHaveLength(1);
      const fin = outcomes[0]!;
      expect(fin.kind).toBe("ok");
      if (fin.kind !== "ok") throw new Error("unreachable");
      expect(fin.seededCount).toBe(1);
      expect(fin.synthFailed).toBe(false);
      expect(written).toHaveLength(1);
      expect(written[0]!.content).toContain(`verify: \`${verify}\``);
      expect(existsSync(join(dir, "BigPlan.md"))).toBe(false); // memory-only writer

      const plans = db.db.query("SELECT * FROM plans WHERE session_id = ?").all(runId) as PlanRow[];
      expect(plans).toHaveLength(1);
      expect(plans[0]!.status).toBe("active");
      expect(plans[0]!.title).toBe("Demo Widget Wiring");
      const planId = plans[0]!.id;
      const seeded = db.getPlanSteps(planId);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]!).toMatchObject({
        idx: 0,
        content: ACTION,
        status: "pending",
        verify, // verbatim — the user-approved check
        check_origin: "user",
        baseline: null,
      });
      const stepId = seeded[0]!.id;

      // MP18: plan approval is the consent event for exactly the seeded verify commands.
      expect(fin.seededVerifies).toEqual([verify]);
      const consented = new Set(fin.seededVerifies);

      // --- 3. EXECUTE through the real done-gate, strict consent checker installed ---
      resetRegistry();
      resetProviderRegistration();
      resetModelRegistry();
      registerModel(WORKER);
      reg = registerFauxProvider([WORKER]);
      const { fetchLike, recommendCalls, feedbackCalls } = mockService();
      const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
      const config = harnessConfig({
        candidates: ["worker-model"],
        allowOffline: false,
        minimaApiKey: "k",
        bigPlan: true,
        stopStrikes: 0, // this test scripts the done-gate, not the A2 stop-gate
      });
      const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
      const agent = new MinimaAgent({
        config,
        router,
        meter: new CostMeter(),
        tools: [todowriteTool([], { bigPlan: true }), writeTool()],
      });
      agent.db = db;
      agent.runId = runId;

      // Judge stays OFF (default abstain) — every grade below comes from gates. The consent
      // checker admits ONLY the plan-approved string; the gate's before-hook is wrapped just to
      // capture the block verdict the refused todowrite carries.
      const { before: beforeGate, after: afterGate } = bigPlanHooks(agent, {
        verifyConsent: (cmd) => consented.has(cmd),
      });
      const blocks: { tool: string; reason: string }[] = [];
      agent.addBeforeToolCall(async (ctx) => {
        const decision = await beforeGate(ctx);
        if (decision?.block) blocks.push({ tool: ctx.toolCall.name, reason: decision.reason });
        return decision;
      });
      agent.addAfterToolCall(afterGate);

      // The starting todowrite carries NO verify of its own: the seeded (consented) check is
      // sourced from the ledger, so a red baseline below proves the consented path executed.
      const start = [{ content: ACTION, status: "in_progress" }];
      const done = [{ content: ACTION, status: "completed" }];
      reg.setResponses([
        new AssistantMessage({
          content: [toolCall("tc-start", "todowrite", { tasks: JSON.stringify(start) })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({
          content: [toolCall("tc-red", "todowrite", { tasks: JSON.stringify(done) })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({
          content: [toolCall("tc-fix", "write", { path: flag, content: "shipped\n" })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({
          content: [toolCall("tc-green", "todowrite", { tasks: JSON.stringify(done) })],
          stop_reason: "toolUse",
        }),
        new AssistantMessage({ content: [text("demo widget shipped")] }),
      ]);

      const routing = await agent.promptRouted("execute the approved demo plan");
      expect(routing?.chosenModelId).toBe("worker-model");
      expect(agent.ladderEscalations).toBe(0); // recovered within the rung — no escalation
      expect(recommendCalls).toHaveLength(1);

      // The done-gate BLOCKED the premature completion (statuses unchanged, durable red row).
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.tool).toBe("todowrite");
      expect(blocks[0]!.reason).toContain(`Step not verified — "${ACTION}"`);
      expect(blocks[0]!.reason).toContain(verify);

      // Plan closed by the completing after-hook; the red baseline is permanent evidence that
      // the consented verify RAN at in_progress (an unconsented one leaves baseline NULL).
      const plan = db.getPlan(planId)!;
      expect(plan.status).toBe("done");
      expect(plan.closed_at).not.toBeNull();
      const step = db.getPlanSteps(planId)[0]!;
      expect(step.id).toBe(stepId); // the seeded step survived the whole loop
      expect(step).toMatchObject({
        status: "completed",
        verify,
        baseline: "red",
        check_origin: "user",
      });

      // The fix was a real write-tool call, so file_changes has the row. The action text never
      // names demo.flag, so attribution is honestly off_plan — the drift the overview surfaces.
      const changes = db.getFileChanges(planId).map((c) => ({
        path: c.path,
        kind: c.kind,
        origin: c.origin,
        stepId: c.step_id,
      }));
      expect(changes).toEqual([{ path: flag, kind: "created", origin: "off_plan", stepId }]);

      // Gates: blocked attempt → red→green pass → the closure milestone, all under rec-1.
      const gates = db.getGates(planId);
      expect(
        gates.map((g) => ({
          kind: g.kind,
          outcome: g.outcome,
          verifiedBy: g.verified_by,
          stepId: g.step_id,
          recId: g.rec_id,
          sessionId: g.session_id,
        })),
      ).toEqual([
        {
          kind: "step_check",
          outcome: "failed",
          verifiedBy: "deterministic",
          stepId,
          recId: "rec-1",
          sessionId: runId,
        },
        {
          kind: "step_check",
          outcome: "verified",
          verifiedBy: "deterministic",
          stepId,
          recId: "rec-1",
          sessionId: runId,
        },
        {
          kind: "milestone",
          outcome: "verified",
          verifiedBy: "deterministic",
          stepId: null,
          recId: "rec-1",
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
      expect(gates[2]!.confidence).toBe("yellow"); // the milestone rolls up the worst step tier

      // --- 4. LEARN: one routed rung, verified stamp, feedback with realized usage only ---
      const rows = db.getRunDecisions(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rec_id).toBe("rec-1");
      expect(rows[0]!.chosen_model).toBe("worker-model");
      // A7 graded outcome: a YELLOW verified pass (user-origin + red→green, coverage unknown)
      // maps to `partial` — never a fabricated clean `success`.
      expect(rows[0]!.outcome).toBe("partial");
      expect(rows[0]!.quality).toBeNull(); // gate verdict → label only, no fabricated quality
      expect(rows[0]!.judged).toBe(0);
      expect(rows[0]!.big_plan_outcome).toBe("verified");
      expect(rows[0]!.big_plan_verified_by).toBe("deterministic");
      expect(rows[0]!.big_plan_confidence).toBe("yellow");
      expect(rows[0]!.step_id).toBeNull(); // plan closure precedes persistDecision
      expect(rows[0]!.actual_cost_usd as number).toBeGreaterThan(0);

      expect(feedbackCalls).toHaveLength(1);
      const fb = feedbackCalls[0] as Record<string, unknown>;
      expect(fb.recommendation_id).toBe("rec-1");
      expect(fb.outcome).toBe("partial"); // consistent with the deterministic mapping above
      expect(fb.judged).toBe(false);
      expect(fb.quality_score).toBeUndefined();
      expect(fb.verified_in_production).toBe(false); // vip is green-only; this pass is yellow
      expect(String(fb.notes)).toBe("verified_by=deterministic;tier=yellow");
      // Realized usage: faux usage carries zero input tokens and the router omits zero fields,
      // so input_tokens is ABSENT — output/cost/latency are the realized evidence.
      expect(fb.input_tokens).toBeUndefined();
      expect(fb.output_tokens as number).toBeGreaterThan(0);
      expect(fb.actual_cost_usd as number).toBeGreaterThan(0);
      expect(fb.actual_cost_usd as number).toBeCloseTo(rows[0]!.actual_cost_usd as number, 8);
      expect(typeof fb.latency_ms).toBe("number");
      expect(fb.latency_ms).toBe(rows[0]!.latency_ms);

      // --- 5. EVIDENCE: the overview and /why retell the story from the ledger alone ---
      const overview = buildPlanOverview(db, runId);
      expect(overview).not.toBeNull();
      expect(overview!.title).toBe("Demo Widget Wiring");
      expect(overview!.stepTotal).toBe(1);
      expect(overview!.steps[0]!.statusGlyph).toBe("✅");
      expect(overview!.steps[0]!.tierGlyph).toBe("🟡");
      expect(overview!.steps[0]!.verify).toBe(verify);
      expect(overview!.steps[0]!.baseline).toBe("red");
      expect(overview!.steps[0]!.checkOrigin).toBe("user");
      expect(overview!.driftCount).toBe(1); // the off_plan flag write
      expect(overview!.steps[0]!.costUsd).toBeNull(); // no step stamp (closure preceded persist)
      const stepGates = overview!.gatesByStep.get(stepId) ?? [];
      expect(stepGates.map((g) => g.outcome)).toEqual(["failed", "verified"]);
      const card = stepCardLines(overview!.steps[0]!, stepGates).join("\n");
      expect(card).toContain("red→green vs the captured baseline");

      const why = whyReportFor(db, runId);
      expect(why).toContain("Big Plan verification - Demo Widget Wiring");
      expect(why).toContain("✓ step 1");
      expect(why).toContain(`check: ${verify}`);
      expect(why).toContain("milestone");
    } finally {
      reg?.unregister();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
