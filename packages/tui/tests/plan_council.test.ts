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
  answerOpenQuestions,
  runCouncilRound,
  shouldConveneCouncil,
  synthesizeGroundTruth,
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
  test("returns researcher findings + critic faults + a draft; sums child + meta spend", async () => {
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
        plan: "", // empty → result falls back to the revised draft prose
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
    const captured: number[] = [];
    const result = await runCouncilRound(
      sessionFor("build a planning council"),
      "Design the council pipeline end to end",
      makeOpts({ spawn, maxCriticPasses: 3, onCostUsd: (usd) => captured.push(usd) }),
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
    // reviser RAN: draft is the revised prose (synth plan was empty)
    expect(result.draft).toBe("Revised plan draft addressing error handling.");
    // loop STOPPED at the clean pass, not the cap: exactly 7 meta calls
    expect(reg.state.callCount).toBe(7);
    // costUsd = injected child costs + every meta call's realized spend (onCostUsd saw each)
    expect(captured).toHaveLength(7);
    const metaSpend = captured.reduce((a, b) => a + b, 0);
    expect(metaSpend).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.05 + metaSpend, 10);
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
      json({ plan: "Final plan." }), // synth
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
    expect(result.draft).toBe("Final plan.");
  });

  test("raw.draftDelta legacy synth key still lands as the plan", async () => {
    reg.setResponses([
      json([{ focus: "x", boundaries: "read only", output_format: "notes", difficulty: "easy" }]),
      json([]), // keeper
      msg("Draft."),
      json([]), // attack#0: clean
      json({ draftDelta: "Legacy-keyed full plan." }), // synth echoing the pre-rename key
    ]);
    const result = await runCouncilRound(
      sessionFor("goal"),
      "A substantive turn requiring real deliberation here",
      makeOpts({ spawn: spawnWith({}) }),
    );
    expect(result.draft).toBe("Legacy-keyed full plan.");
  });

  test("roundBudgetUsd soft-caps researcher launches once realized spend crosses it", async () => {
    reg.setResponses([
      json([
        { focus: "a", boundaries: "read only", output_format: "notes", difficulty: "easy" },
        { focus: "b", boundaries: "read only", output_format: "notes", difficulty: "easy" },
      ]),
      json([]), // keeper
      msg("Plan."),
      json([]), // attack#0: clean
      json({ plan: "Done." }), // synth
    ]);
    const launched: string[] = [];
    const spawn: SpawnFn = async (d: Delegation): Promise<ChildResult> => {
      launched.push(d.step_id);
      return {
        step_id: d.step_id,
        childId: `${d.step_id}-child`,
        text: "finding",
        costUsd: 0.02,
        quality: null,
        outcome: "success",
        workdir: null,
      };
    };
    await runCouncilRound(
      sessionFor("goal"),
      "A substantive turn requiring real deliberation here",
      makeOpts({ spawn, roundBudgetUsd: 0.01, concurrency: 1, maxCriticPasses: 1 }),
    );
    // The first child's 0.02 realized spend crossed the 0.01 cap: the second never launches.
    expect(launched).toEqual(["research-1"]);
  });

  test("synth resolves a trivial question as a decision but surfaces a genuine one", async () => {
    reg.setResponses([
      json([{ focus: "x", boundaries: "read only", output_format: "notes", difficulty: "easy" }]),
      json([]), // keeper
      msg("Plan."),
      json([]), // attack#0: clean immediately
      json({
        plan: "Plan finalized.",
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
    expect(result.draft).toBe("");
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

describe("answerOpenQuestions", () => {
  test("accepts each question's recommended (first) option as assumed-true, with NO model call", async () => {
    const store = new PlanSessionStore("build a thing");
    store.addSurfacedQuestions(
      [
        {
          question: "Which store?",
          header: "h",
          why: "affects deps",
          options: [
            { label: "SQLite (Recommended)", description: "embedded" },
            { label: "Postgres", description: "server" },
          ],
        },
      ],
      1,
    );
    const resolved = await answerOpenQuestions(store.session, { metaModel: META_MODEL });
    expect(resolved).toEqual([
      {
        question: "Which store?",
        answer: "SQLite (Recommended)",
        rationale: "assumed accepted (recommended option) at finalize",
      },
    ]);
    // The recommended option is taken verbatim — the model is never consulted.
    expect(reg.state.callCount).toBe(0);
  });

  test("mixes recommended-option acceptance with a model call only for option-less questions", async () => {
    reg.setResponses([json([{ answer: "Ship without auth", rationale: "internal tool" }])]);
    const store = new PlanSessionStore("build a thing");
    store.addSurfacedQuestions(
      [
        { question: "Which store?", header: "h", why: "", options: [{ label: "SQLite" }] },
        { question: "Auth?", header: "h", why: "security", options: [] },
      ],
      1,
    );
    const resolved = await answerOpenQuestions(store.session, { metaModel: META_MODEL });
    // Order is preserved; option-bearing question accepted verbatim, option-less answered by model.
    expect(resolved[0]!.answer).toBe("SQLite");
    expect(resolved[1]!.answer).toBe("Ship without auth");
    // Exactly ONE model call — only the option-less question needed it.
    expect(reg.state.callCount).toBe(1);
  });

  test("resolves each option-less question positionally with the model's answer + rationale", async () => {
    reg.setResponses([
      json([
        { answer: "Use the embedded SQLite store", rationale: "already a dependency" },
        { answer: "Ship without auth for now", rationale: "internal tool" },
      ]),
    ]);
    const store = new PlanSessionStore("build a thing");
    store.addSurfacedQuestions(
      [
        { question: "Which store?", header: "h", options: [], why: "affects deps" },
        { question: "Auth?", header: "h", options: [], why: "security" },
      ],
      1,
    );
    const resolved = await answerOpenQuestions(store.session, { metaModel: META_MODEL });
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual({
      question: "Which store?",
      answer: "Use the embedded SQLite store",
      rationale: "already a dependency",
    });
    expect(resolved[1]!.answer).toBe("Ship without auth for now");
    expect(reg.state.callCount).toBe(1);
  });

  test("returns [] and makes NO model call when nothing is open", async () => {
    const store = new PlanSessionStore("g");
    const resolved = await answerOpenQuestions(store.session, { metaModel: META_MODEL });
    expect(resolved).toHaveLength(0);
    expect(reg.state.callCount).toBe(0);
  });

  test("falls back to a reasonable default when the model under-answers", async () => {
    reg.setResponses([json([])]); // model returned nothing usable
    const store = new PlanSessionStore("g");
    store.addSurfacedQuestions([{ question: "Q1?", header: "h", options: [], why: "" }], 1);
    const resolved = await answerOpenQuestions(store.session, { metaModel: META_MODEL });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.question).toBe("Q1?");
    expect(resolved[0]!.answer.length).toBeGreaterThan(0);
    expect(resolved[0]!.rationale).toBe("assumed accepted at finalize");
  });
});

describe("synthesizeGroundTruth", () => {
  test("distils the conversation into a rich structured ground truth", async () => {
    reg.setResponses([
      json({
        title: "Binary search in Python",
        goal: "Implement binary search over sorted lists in Python.",
        overview: "A small dependency-free module with tests.",
        requirements: ["Return index or -1"],
        constraints: ["Python 3", "no third-party deps"],
        decisions: [{ topic: "Language", decision: "Python 3", rationale: "user asked" }],
        approach: ["Write binary_search.py", "Add pytest cases"],
        risks: ["off-by-one on midpoint"],
        successCriteria: ["pytest passes"],
        openItems: [],
      }),
    ]);
    const store = new PlanSessionStore("lets build binary searches");
    const result = await synthesizeGroundTruth(
      store.session,
      "User: lets build binary searches\n\nPlanner: which language?\n\nUser: python",
      { metaModel: META_MODEL },
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Binary search in Python");
    expect(result!.constraints).toContain("Python 3");
    expect(result!.approach).toEqual(["Write binary_search.py", "Add pytest cases"]);
    expect(reg.state.callCount).toBe(1);
  });

  test("returns null on an essentially-empty model reply so finalize falls back", async () => {
    reg.setResponses([json({})]);
    const store = new PlanSessionStore("g");
    const result = await synthesizeGroundTruth(store.session, "User: hi", { metaModel: META_MODEL });
    expect(result).toBeNull();
  });

  test("returns null (never throws) when the model errors", async () => {
    reg.setResponses([msg("not json at all — total garbage")]);
    const store = new PlanSessionStore("g");
    const result = await synthesizeGroundTruth(store.session, "User: hi", { metaModel: META_MODEL });
    expect(result).toBeNull();
  });
});
