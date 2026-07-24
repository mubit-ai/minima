import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { type ChildEvent, createSpawn, delegationPrompt } from "../src/minima/spawn.ts";
import { taskTool } from "../src/tools/task.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${Math.random().toString(16).slice(2, 8)}`,
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return fetchLike;
}

function leadAgent(db: MinimaDb | null, runId: string | null): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: mockService() });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  agent.db = db;
  agent.runId = runId;
  return agent;
}

describe("createSpawn (default child factory)", () => {
  test("gate: child routes on its own model in its own workdir and returns text", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("child answer: 42")] })]);

    const wd = mkdtempSync(join(tmpdir(), "minima-spawn-"));
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const lead = leadAgent(db, runId);

    const events: ChildEvent[] = [];
    const spawn = createSpawn({ parent: lead, workdir: wd, onChildEvent: (e) => events.push(e) });
    const tool = taskTool({ spawn, spawnDepth: 0, maxDepth: 2 });

    const res = await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          {
            step_id: "answer",
            objective: "compute the answer",
            output_format: "one line",
            boundaries: "read-only",
            difficulty: "easy",
            effort: "light",
          },
        ]),
      },
      null,
      null,
    );

    const out = res.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join("");
    expect(out).toContain("child answer: 42");
    expect(out).toContain("1 succeeded");

    // The child's decision row landed in the shared run, demuxed by agentId.
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.agent_id)).toStartWith("answer-");
    expect(rows[0]!.routed).toBe("server"); // the child routed via Minima itself

    // Tagged events flowed up (message + routing activity, all carrying the child id).
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.stepId))).toEqual(new Set(["answer"]));
    expect(events[0]!.depth).toBe(1);

    // The lead's own conversation is untouched by the child's run.
    expect(lead.agentState.messages).toHaveLength(0);

    reg.unregister();
    db.close();
    rmSync(wd, { recursive: true, force: true });
  });

  test("isolation=workdir creates a git worktree and cleans it up on exit", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("worktree child done")] })]);

    // Set up a minimal git repo so git worktree add has somewhere to attach.
    const repoDir = mkdtempSync(join(tmpdir(), "minima-wt-repo-"));
    Bun.spawnSync(["git", "init", repoDir]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.local"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"]);
    Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"]);

    const worktreesBefore = Bun.spawnSync(["git", "worktree", "list"], { cwd: repoDir })
      .stdout.toString()
      .trim()
      .split("\n").length;

    const lead = leadAgent(null, null);
    const spawn = createSpawn({ parent: lead, workdir: repoDir });
    const result = await spawn(
      {
        step_id: "wt-step",
        objective: "do something",
        output_format: "one line",
        boundaries: "read-only",
        isolation: "workdir",
      },
      { depth: 1, parentSignal: null, priorResults: [] },
    );

    // result.workdir should have been the worktree path (cleanup happened in finally).
    expect(result.workdir).toMatch(/minima-wt-wt-step/);
    expect(result.outcome).toBe("success");
    expect(result.text).toContain("worktree child done");

    // Verify worktree was removed — git worktree list should be back to baseline.
    const worktreesAfter = Bun.spawnSync(["git", "worktree", "list"], { cwd: repoDir })
      .stdout.toString()
      .trim()
      .split("\n").length;
    expect(worktreesAfter).toBe(worktreesBefore);

    reg.unregister();
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("isolation=workdir emits dirty-tree warning when repo has uncommitted changes", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const repoDir = mkdtempSync(join(tmpdir(), "minima-wt-dirty-"));
    Bun.spawnSync(["git", "init", repoDir]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.local"]);
    Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"]);
    Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"]);

    // Leave an uncommitted file to trigger the dirty-tree warning.
    writeFileSync(join(repoDir, "dirty.txt"), "unstaged");

    const lead = leadAgent(null, null);
    const spawn = createSpawn({ parent: lead, workdir: repoDir });
    const result = await spawn(
      {
        step_id: "dirty-step",
        objective: "check warning",
        output_format: "one line",
        boundaries: "read-only",
        isolation: "workdir",
      },
      { depth: 1, parentSignal: null, priorResults: [] },
    );

    expect(result.text).toContain("uncommitted changes");

    reg.unregister();
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("isolation=inherit skips worktree creation and uses parent workdir", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("inherit child")] })]);

    const wd = mkdtempSync(join(tmpdir(), "minima-inherit-"));
    const lead = leadAgent(null, null);
    const spawn = createSpawn({ parent: lead, workdir: wd });
    const result = await spawn(
      {
        step_id: "inh-step",
        objective: "do work",
        output_format: "one line",
        boundaries: "read-only",
        isolation: "inherit",
      },
      { depth: 1, parentSignal: null, priorResults: [] },
    );

    expect(result.workdir).toBe(wd);
    expect(result.text).toContain("inherit child");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });

  test("delegationPrompt carries the contract + dependency results", () => {
    const p = delegationPrompt(
      {
        step_id: "b",
        objective: "use A's output",
        output_format: "json",
        boundaries: "src/ only",
        depends_on: ["a"],
      },
      {
        depth: 1,
        parentSignal: null,
        priorResults: [
          {
            step_id: "a",
            childId: "a-1",
            text: "A RESULT",
            costUsd: 0,
            quality: null,
            outcome: "success",
            workdir: null,
          },
        ],
      },
    );
    expect(p).toContain("use A's output");
    expect(p).toContain("Return exactly");
    expect(p).toContain("do NOT touch");
    expect(p).toContain("A RESULT");
  });

  test("delegationPrompt restates ops rules and the BLOCKED refusal convention", () => {
    // Children don't inherit the lead's system prompt — a live bench showed a child
    // editing a file without any verification step. The contract must carry the rules.
    const p = delegationPrompt(
      { step_id: "x", objective: "o", output_format: "f", boundaries: "b" },
      { depth: 1, parentSignal: null, priorResults: [] },
    );
    expect(p).toContain("## Rules");
    expect(p).toContain("Read a file before editing");
    expect(p).toContain("verify");
    expect(p).toContain('"BLOCKED: "');
    expect(p).toContain("Boundaries override the objective");
  });

  async function runChildRead(
    stepId: string,
    editGuard: boolean,
  ): Promise<{ db: MinimaDb; wd: string }> {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const wd = mkdtempSync(join(tmpdir(), "minima-seen-child-"));
    const file = join(wd, "seen.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    reg.setResponses([
      new AssistantMessage({ content: [toolCall("c1", "read", { path: file })] }),
      new AssistantMessage({ content: [text("done")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const lead = leadAgent(db, runId);
    lead.config = { ...lead.config, editGuard };
    const spawn = createSpawn({ parent: lead, workdir: wd });
    const tool = taskTool({ spawn, spawnDepth: 0, maxDepth: 2 });
    await tool.execute(
      "1",
      {
        delegations: JSON.stringify([
          {
            step_id: stepId,
            objective: "read the file and report",
            output_format: "one line",
            boundaries: "read-only",
            difficulty: "easy",
            effort: "light",
          },
        ]),
      },
      null,
      null,
    );
    reg.unregister();
    return { db, wd };
  }

  test("seen: an editGuard child records seen_lines under its own agent_id", async () => {
    const { db, wd } = await runChildRead("seenon", true);
    const rows = db.db.query("SELECT * FROM seen_lines WHERE agent_id LIKE 'seenon-%'").all();
    expect(rows.length).toBeGreaterThan(0);
    // No lead-scoped (NULL agent_id) rows leaked from the child's read.
    const leadRows = db.db.query("SELECT * FROM seen_lines WHERE agent_id IS NULL").all();
    expect(leadRows.length).toBe(0);
    db.close();
    rmSync(wd, { recursive: true, force: true });
  });

  test("seen: with editGuard off the child records nothing", async () => {
    const { db, wd } = await runChildRead("seenoff", false);
    const rows = db.db.query("SELECT * FROM seen_lines").all();
    expect(rows.length).toBe(0);
    db.close();
    rmSync(wd, { recursive: true, force: true });
  });

  test("a BLOCKED: reply maps to outcome=partial, not success", async () => {
    resetRegistry();
    resetProviderRegistration();
    resetModelRegistry();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [text("BLOCKED: objective requires editing config.py, which boundaries forbid")],
      }),
    ]);

    const wd = mkdtempSync(join(tmpdir(), "minima-blocked-"));
    const lead = leadAgent(null, null);
    const spawn = createSpawn({ parent: lead, workdir: wd });
    const result = await spawn(
      {
        step_id: "blocked-step",
        objective: "edit config.py",
        output_format: "one line",
        boundaries: "do not touch config.py",
      },
      { depth: 1, parentSignal: null, priorResults: [] },
    );

    // A correct refusal is not an accomplishment: the parent must be able to tell
    // "did it" from "couldn't do it" without a judge.
    expect(result.outcome).toBe("partial");
    expect(result.text).toContain("BLOCKED:");

    reg.unregister();
    rmSync(wd, { recursive: true, force: true });
  });
});
