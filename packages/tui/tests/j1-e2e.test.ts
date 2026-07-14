import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
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
import { MinimaDb } from "../src/db/minima_db.ts";
import { groundTruthHooks } from "../src/minima/ground_truth.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { runPlanRefutation } from "../src/minima/plan_refute.ts";
import { whyReportFor } from "../src/minima/why.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readTool } from "../src/tools/read.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";
import { todowriteTool } from "../src/tools/todowrite.ts";
import { buildGtOverview, stepCardLines } from "../src/tui/gt_overview.ts";

// J1.3 (M8.2 acceptance): the WHOLE journey in one scripted run, pinned as a regression —
//   plan → done blocked while red → doom-loop flail (identical failing read ×3) → anti-spiral
//   nudge then stop → fix → red→green → verified gate → plan closes → /why → whole-plan
//   refutation subagent (J1.2) → grounded outcomes stamped on every rung.
// Nothing is seeded: every gate row is minted by the hooks during real tool dispatch.

describe("J1 — end-to-end acceptance demo", () => {
  test("plan → blocked done → doom-loop stop → fix → red→green → gate → /why → refutation", async () => {
    const DEMO: Model = {
      id: "demo-model",
      provider: "faux",
      api: "faux",
      name: "Demo",
      cost: { input: 1, output: 2 },
      context_window: 8192,
      max_tokens: 4096,
    };

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");

    const recommendCalls: unknown[] = [];
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
              model_id: "demo-model",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
            ranked: [
              {
                model_id: "demo-model",
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

    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(DEMO);
    const reg = registerFauxProvider([DEMO]);
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["demo-model"],
      allowOffline: false,
      minimaApiKey: "k",
      groundTruth: true,
      stopStrikes: 0, // the A2 stop-gate would force-continue past the scripted responses
      spiralRepeats: 2, // 2 identical failures → nudge; failing again after the nudge → stop
      stepCap: 0,
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const dir = mkdtempSync(join(tmpdir(), "j1-e2e-"));
    const flag = join(dir, "done.flag");
    const agent = new MinimaAgent({
      config,
      router,
      judge: new ConstJudge(0.9),
      meter: new CostMeter(),
      tools: [
        todowriteTool([], { groundTruth: true }),
        bashTool({ workdir: dir }),
        readTool({ workdir: dir }),
      ],
      recoveryRungs: 0, // the demo's fix is the NEXT prompt, not a ladder rung
    });
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });
    const { before: beforeGate, after: afterGate } = groundTruthHooks(agent);
    agent.addBeforeToolCall(beforeGate);
    agent.addAfterToolCall(afterGate);

    const start = [
      { content: "wire the endpoint", status: "in_progress", verify: `test -f ${flag}` },
    ];
    const done = [{ content: "wire the endpoint", status: "completed", verify: `test -f ${flag}` }];
    const doneArgs = { tasks: JSON.stringify(done) }; // identical args → identical doom-loop signature

    // ---- Prompt 1 (rec-1): plan lands (baseline red), the model claims done while the check
    // is red (done-gate BLOCKS it — the failed attempt gate under rec-1), then flails: the
    // identical failing read repeats — 2 fails trip the detector (nudge, steering injected),
    // and failing again AFTER the nudge stops the run with the doom-loop audit gate. (A
    // blocked call never reaches the ring — hammering the gate is A2 N-strike territory —
    // so the spiral here is an EXECUTED failure, exactly what A3 watches.)
    const flail = { path: join(dir, "does-not-exist.log") };
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("tc-plan", "todowrite", { tasks: JSON.stringify(start) })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-red", "todowrite", doneArgs)],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-flail-1", "read", flail)],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-flail-2", "read", flail)],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-flail-3", "read", flail)],
        stop_reason: "toolUse",
      }),
    ]);
    await agent.promptRouted("ship the endpoint");

    // The anti-spiral steer reached the model's context before the stop.
    expect(
      agent.agentState.messages.some(
        (m) => m.role === "user" && m.textContent.includes("stuck in a loop"),
      ),
    ).toBe(true);

    const plan = db.getLatestPlan(agent.runId)!;
    const step = db.getPlanSteps(plan.id)[0]!;
    expect(step.baseline).toBe("red"); // captured before the flag existed
    expect(step.status).toBe("in_progress"); // the gate held the line — never marked done red

    const spiralGates = db
      .getGates(plan.id)
      .filter((g) => g.kind === "stop")
      .map((g) => JSON.parse(g.factors_json ?? "{}") as Record<string, unknown>);
    expect(spiralGates).toHaveLength(1);
    expect(spiralGates[0]!.spiral).toBe(true);
    expect(spiralGates[0]!.reason).toBe("doom_loop");
    expect(reg.state.pendingResponseCount).toBe(0); // all five scripted moves were consumed

    // ---- Prompt 2 (rec-2): the fix — the agent does the WORK (touch the flag through the real
    // bash tool), then the same todowrite passes the gate red→green and the plan closes.
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("tc-fix", "bash", { command: `touch ${flag}` })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("tc-green", "todowrite", doneArgs)],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("shipped")] }),
    ]);
    await agent.promptRouted("fix it properly");

    expect(existsSync(flag)).toBe(true);
    expect(db.getPlanSteps(plan.id)[0]!.status).toBe("completed");
    expect(db.getLatestPlan(agent.runId)!.status).toBe("done");

    // Step gates: the blocked attempt under rec-1, the real red→green pass under rec-2.
    const stepGates = db.getGates(plan.id).filter((g) => g.kind === "step_check");
    expect(stepGates.map((g) => g.outcome)).toEqual(["failed", "verified"]);
    expect(stepGates.map((g) => g.rec_id)).toEqual(["rec-1", "rec-2"]);
    const passFactors = JSON.parse(stepGates[1]!.factors_json!) as Record<string, unknown>;
    expect(passFactors.redToGreen).toBe(true);

    // ---- J1.1: /why tells the whole story, and the step card carries red→green evidence.
    const report = whyReportFor(db, agent.runId);
    expect(report).toContain("✓ step 1");
    expect(report).toContain("plan gates:"); // closure milestone now visible at plan level
    const overview = buildGtOverview(db, agent.runId);
    if (!overview) throw new Error("expected overview");
    const card = stepCardLines(overview.steps[0]!, overview.gatesByStep.get(step.id) ?? []);
    expect(card.some((l) => l.includes("red→green vs the captured baseline"))).toBe(true);
    expect(card.some((l) => l.includes("baseline: red"))).toBe(true);

    // ---- J1.2: whole-plan refutation (scripted subagent) — judge-verified, capped at 🟡,
    // stamped onto rec-2 alongside the deterministic gates.
    const refuterSpawn: SpawnFn = async (d: Delegation): Promise<ChildResult> => {
      expect(d.objective).toContain("wire the endpoint");
      expect(d.boundaries).toContain("READ-ONLY");
      return {
        step_id: d.step_id,
        childId: "refuter",
        text: "VERDICT: confirmed\nREASONS:\n- reran `test -f` — green, and the flag is real",
        costUsd: 0.02,
        quality: null,
        outcome: "success",
        workdir: null,
      };
    };
    const refutation = await runPlanRefutation({
      db,
      sessionId: agent.runId,
      spawn: refuterSpawn,
    });
    if (!refutation) throw new Error("expected refutation outcome");
    expect(refutation.verdict.refuted).toBe(false);
    expect(refutation.recId).toBe("rec-2");

    const milestones = db.getGates(plan.id).filter((g) => g.kind === "milestone");
    expect(milestones).toHaveLength(2); // plan closure (deterministic) + refutation (judge)
    expect(milestones.map((g) => g.verified_by).sort()).toEqual(["deterministic", "judge"]);
    expect(milestones.every((g) => g.outcome === "verified")).toBe(true);
    expect(milestones.every((g) => g.confidence === "yellow")).toBe(true); // judge caps at 🟡

    // ---- DB dump: both rungs carry grounded outcomes; red rung red, recovered rung yellow.
    const rows = db.getRunDecisions(agent.runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.gt_outcome).toBe("failed");
    expect(rows[0]!.gt_confidence).toBe("red");
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[1]!.gt_outcome).toBe("verified");
    expect(rows[1]!.gt_confidence).toBe("yellow");
    expect(feedbackCalls.length).toBe(2);

    // The refutation verdict is visible in the /why plan-gates section.
    const finalReport = whyReportFor(db, agent.runId);
    expect(finalReport).toContain("reran `test -f`");

    reg.unregister();
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });
});
