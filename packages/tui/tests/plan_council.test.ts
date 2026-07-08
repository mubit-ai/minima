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
import {
  type CouncilOptions,
  Critic,
  runCouncilRound,
  shouldConveneCouncil,
} from "../src/minima/plan_council.ts";
import { PlanSessionStore } from "../src/minima/plan_session.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";

const META_MODEL: Model = {
  id: "meta-faux",
  provider: "faux",
  api: "faux",
  name: "Meta Faux",
  cost: { input: 1, output: 1 },
  context_window: 8192,
  max_tokens: 1024,
};

// The faux provider is a FIFO response queue; every meta complete() call shifts one.
const msg = (s: string): AssistantMessage => new AssistantMessage({ content: [text(s)] });
const json = (v: unknown): AssistantMessage => msg(JSON.stringify(v));

// A mock spawn: NO real child agents run, so `parent` is never touched. Cost keyed by step_id.
const spawnWith = (costs: Record<string, number>, fallback = 0.01): SpawnFn => {
  return async (d: Delegation): Promise<ChildResult> => ({
    step_id: d.step_id,
    childId: `${d.step_id}-child`,
    text: `finding for ${d.objective}`,
    costUsd: costs[d.step_id] ?? fallback,
    quality: 0.9,
    outcome: "success",
    workdir: null,
  });
};

const makeOpts = (over: Partial<CouncilOptions>): CouncilOptions => ({
  // parent is unused because a mock spawn is injected; a bare stub is enough.
  parent: {} as unknown as CouncilOptions["parent"],
  metaModel: META_MODEL,
  signal: null,
  ...over,
});

const sessionFor = (goal: string): PlanSessionStore["session"] =>
  new PlanSessionStore(goal).session;

let reg: FauxRegistration;

beforeEach(() => {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(META_MODEL);
  reg = registerFauxProvider([META_MODEL]);
});

afterEach(() => reg.unregister());

describe("runCouncilRound — full round", () => {
  test("returns researcher findings + critic faults + a draftDelta; sums child costs", async () => {
    // Meta call order: deriveScopes → keeperPostCheck → draftPlan → attack#0 (faults) →
    // reviseDraft#0 → attack#1 (clean) → synth.  Researchers use the injected mock spawn.
    reg.setResponses([
      json([
        {
          focus: "inspect storage layer",
          boundaries: "read only",
          output_format: "notes",
          difficulty: "easy",
        },
        {
          focus: "survey web docs",
          boundaries: "read only",
          output_format: "notes",
          difficulty: "easy",
        },
      ]),
      json([]), // keeper post-check: nothing off-scope
      msg("Initial plan draft."),
      json([{ summary: "missing error handling", severity: "concern" }]), // attack#0
      msg("Revised plan draft addressing error handling."), // reviser
      json([]), // attack#1: clean → loop stops before the cap
      json({
        draftDelta: "", // empty → result falls back to the revised draft prose
        decisions: [
          { topic: "storage", decision: "use the embedded store", rationale: "already a dep" },
        ],
        findings: [
          { source: "researcher", summary: "repo uses an embedded store", severity: "info" },
        ],
        questions: [],
        facts: ["the harness runs on Bun"],
        constraints: ["must stay db-free for this feature"],
      }),
    ]);

    const spawn = spawnWith({ "research-1": 0.02, "research-2": 0.03 });
    const result = await runCouncilRound(
      sessionFor("build a planning council"),
      "Design the council pipeline end to end",
      makeOpts({ spawn, maxCriticPasses: 3 }),
    );

    // researcher finding surfaced
    expect(
      result.findings.some(
        (f) => f.source === "researcher" && f.summary.includes("embedded store"),
      ),
    ).toBe(true);
    // critic faults surfaced
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]!.summary).toBe("missing error handling");
    // reviser RAN: draftDelta is the revised prose (synth draftDelta was empty)
    expect(result.draftDelta).toBe("Revised plan draft addressing error handling.");
    // loop STOPPED at the clean pass, not the cap: exactly 7 meta calls
    expect(reg.state.callCount).toBe(7);
    // costUsd sums both injected child costs
    expect(result.costUsd).toBeCloseTo(0.05, 8);
    expect(result.decisions).toHaveLength(1);
    expect(result.facts).toContain("the harness runs on Bun");
    expect(result.constraints).toContain("must stay db-free for this feature");
    expect(result.aborted).toBe(false);
  });

  test("critic self-improve loop stops at maxCriticPasses when faults never clear", async () => {
    reg.setResponses([
      json([{ focus: "x", boundaries: "read only", output_format: "notes", difficulty: "easy" }]),
      json([]), // keeper
      msg("Draft v1."),
      json([{ summary: "fault A", severity: "blocker" }]), // attack#0
      msg("Draft v2."), // revise#0
      json([{ summary: "fault B", severity: "concern" }]), // attack#1
      msg("Draft v3."), // revise#1
      json({ draftDelta: "Final plan." }), // synth
      // Sentinel: a 3rd critic attack would consume this — the cap MUST prevent that.
      json([{ summary: "fault C (must never run)", severity: "blocker" }]),
    ]);

    const result = await runCouncilRound(
      sessionFor("goal"),
      "A substantive turn requiring real deliberation here",
      makeOpts({ spawn: spawnWith({}), maxCriticPasses: 2 }),
    );

    // exactly 8 meta calls (2 attacks + 2 revisions, capped); sentinel left unconsumed
    expect(reg.state.callCount).toBe(8);
    expect(reg.state.pendingResponseCount).toBe(1);
    // both distinct faults kept (deduped), the capped-out one absent
    expect(result.faults.map((f) => f.summary).sort()).toEqual(["fault A", "fault B"]);
    expect(result.faults.some((f) => f.summary.includes("fault C"))).toBe(false);
    expect(result.draftDelta).toBe("Final plan.");
  });

  test("synth resolves a trivial question as a decision but surfaces a genuine one", async () => {
    reg.setResponses([
      json([{ focus: "x", boundaries: "read only", output_format: "notes", difficulty: "easy" }]),
      json([]), // keeper
      msg("Plan."),
      json([]), // attack#0: clean immediately
      json({
        draftDelta: "Plan finalized.",
        // trivial/self-answerable → RESOLVED as a decision
        decisions: [
          { topic: "module name", decision: "call it plan_council", rationale: "self-evident" },
        ],
        // genuine decision-point → SURFACED as a question
        questions: [
          {
            question: "Which storage backend should durable plans use?",
            header: "storage",
            options: [
              { label: "sqlite", description: "embedded, already a dep" },
              { label: "postgres", description: "server, heavier" },
            ],
            why: "it changes the deploy story materially",
          },
        ],
      }),
    ]);

    const result = await runCouncilRound(
      sessionFor("goal"),
      "Please decide the module layout and storage design in detail",
      makeOpts({ spawn: spawnWith({}) }),
    );

    expect(result.decisions.map((d) => d.topic)).toContain("module name");
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.question).toContain("storage backend");
    expect(result.questions[0]!.options.map((o) => o.label)).toEqual(["sqlite", "postgres"]);
  });

  test("a pre-aborted signal yields aborted:true with a partial result and no throw", async () => {
    // deriveScopes' complete() sees the aborted signal, the faux throws, completeJson swallows it
    // and returns the fallback scope — then the round bails with aborted:true before research.
    reg.setResponses([]); // nothing should be consumed
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await runCouncilRound(
      sessionFor("goal"),
      "A substantive turn that would otherwise convene research",
      makeOpts({ spawn: spawnWith({ "research-1": 0.99 }), signal: ctrl.signal }),
    );

    expect(result.aborted).toBe(true);
    expect(result.costUsd).toBe(0); // research never launched
    expect(result.draftDelta).toBe("");
    expect(reg.state.callCount).toBe(0); // faux threw before counting the aborted call
  });
});

describe("shouldConveneCouncil (adaptive cadence)", () => {
  test("false for short acknowledgements / confirmations", () => {
    expect(shouldConveneCouncil("ok")).toBe(false);
    expect(shouldConveneCouncil("yes")).toBe(false);
    expect(shouldConveneCouncil("yes do that")).toBe(false);
    expect(shouldConveneCouncil("option b")).toBe(false);
    expect(shouldConveneCouncil("")).toBe(false);
  });

  test("true for a substantive turn", () => {
    expect(
      shouldConveneCouncil("Let's design the caching layer with Redis and TTL eviction policies"),
    ).toBe(true);
  });
});

describe("Critic.attack", () => {
  test("returns [] on an unparseable reply instead of throwing", async () => {
    reg.setResponses([msg("This plan reads well to me — no JSON, no faults worth listing.")]);
    const critic = new Critic(META_MODEL);
    const faults = await critic.attack("goal", "the approach", "the findings");
    expect(faults).toEqual([]);
    expect(reg.state.callCount).toBe(1);
  });

  test("parses a well-formed fault list", async () => {
    reg.setResponses([json([{ summary: "unstated assumption about auth", severity: "blocker" }])]);
    const critic = new Critic(META_MODEL);
    const faults = await critic.attack("goal", "the approach", "the findings");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toEqual({ summary: "unstated assumption about auth", severity: "blocker" });
  });
});
