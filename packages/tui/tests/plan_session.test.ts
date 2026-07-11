import { describe, expect, test } from "bun:test";
import {
  type CouncilRoundResult,
  type GroundTruthSynthesis,
  PlanSessionStore,
  buildPlannerSystemPrompt,
} from "../src/minima/plan_session.ts";

const synth = (over: Partial<GroundTruthSynthesis> = {}): GroundTruthSynthesis => ({
  title: "",
  goal: "",
  overview: "",
  requirements: [],
  constraints: [],
  decisions: [],
  approach: [],
  risks: [],
  successCriteria: [],
  openItems: [],
  ...over,
});

const emptyResult = (over: Partial<CouncilRoundResult> = {}): CouncilRoundResult => ({
  draft: "",
  decisions: [],
  findings: [],
  faults: [],
  questions: [],
  facts: [],
  constraints: [],
  costUsd: 0,
  aborted: false,
  ...over,
});

describe("PlanSessionStore.applyCouncilResult", () => {
  test("merges decisions/questions/constraints and bumps rounds + cost", () => {
    const store = new PlanSessionStore("Build a widget");
    store.applyCouncilResult(
      emptyResult({
        draft: "Step 1: sketch the API.",
        decisions: [{ topic: "Storage", decision: "Use SQLite", rationale: "embedded" }],
        constraints: ["No network at build time"],
        questions: [
          { question: "Which runtime?", header: "Runtime", options: [], why: "affects deps" },
        ],
        costUsd: 0.01,
      }),
    );

    const s = store.session;
    expect(s.rounds).toBe(1);
    expect(s.totalCouncilCostUsd).toBeCloseTo(0.01, 6);
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]?.resolvedBy).toBe("council");
    expect(s.constraints).toHaveLength(1);
    expect(s.openQuestions).toHaveLength(1);
    expect(s.draft).toContain("Step 1: sketch the API.");

    store.applyCouncilResult(emptyResult({ costUsd: 0.02 }));
    expect(store.session.rounds).toBe(2);
    expect(store.session.totalCouncilCostUsd).toBeCloseTo(0.03, 6);
  });

  test("dedups the same topic/question/constraint/finding across rounds (case+whitespace insensitive)", () => {
    const store = new PlanSessionStore("g");
    const round = emptyResult({
      decisions: [{ topic: "Storage", decision: "Use SQLite", rationale: "r" }],
      constraints: ["No network"],
      findings: [{ source: "researcher", summary: "SQLite is embedded", severity: "info" }],
      questions: [{ question: "Which runtime?", header: "h", options: [], why: "w" }],
    });
    store.applyCouncilResult(round);
    // Second round repeats the same items with different casing / extra whitespace.
    store.applyCouncilResult(
      emptyResult({
        decisions: [{ topic: "  storage ", decision: "Use SQLite again", rationale: "r2" }],
        constraints: ["no   network"],
        findings: [{ source: "critic", summary: "SQLITE is embedded", severity: "concern" }],
        questions: [{ question: "which runtime?", header: "h", options: [], why: "w2" }],
      }),
    );

    const s = store.session;
    expect(s.decisions).toHaveLength(1);
    expect(s.constraints).toHaveLength(1);
    expect(s.findings).toHaveLength(1);
    expect(s.openQuestions).toHaveLength(1);
    expect(s.rounds).toBe(2);
  });

  test("council-resolved decisions land in decisions; surfaced questions land in openQuestions", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(
      emptyResult({
        decisions: [{ topic: "Auth", decision: "OAuth", rationale: "standard" }],
        questions: [{ question: "MFA required?", header: "MFA", options: [], why: "security" }],
      }),
    );
    const s = store.session;
    expect(s.decisions.map((d) => d.topic)).toEqual(["Auth"]);
    expect(s.decisions[0]?.resolvedBy).toBe("council");
    expect(s.openQuestions.map((q) => q.question)).toEqual(["MFA required?"]);
    expect(s.openQuestions[0]?.status).toBe("open");
  });

  test("folds critic faults into findings tagged as critic", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(
      emptyResult({ faults: [{ summary: "Race condition on write", severity: "blocker" }] }),
    );
    const s = store.session;
    expect(s.findings).toHaveLength(1);
    expect(s.findings[0]?.source).toBe("critic");
    expect(s.findings[0]?.severity).toBe("blocker");
  });

  test("a round's full plan REPLACES the previous draft (no append duplication)", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(emptyResult({ draft: "Plan A: do it the first way." }));
    store.applyCouncilResult(emptyResult({ draft: "Plan B: do it the better way." }));

    expect(store.session.draft).toBe("Plan B: do it the better way.");
    const md = store.toMarkdown();
    expect(md).toContain("Plan B: do it the better way.");
    expect(md).not.toContain("Plan A");
    // exactly once — replace, never append
    expect(md.split("Plan B: do it the better way.")).toHaveLength(2);
  });

  test("an empty plan keeps the previous draft", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(emptyResult({ draft: "Plan A." }));
    store.applyCouncilResult(emptyResult({ draft: "   " }));
    expect(store.session.draft).toBe("Plan A.");
  });

  test("an aborted round never clobbers a non-empty draft, but its findings still merge", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(emptyResult({ draft: "Good full plan." }));
    store.applyCouncilResult(
      emptyResult({
        draft: "Half-revised partial plan",
        aborted: true,
        findings: [{ source: "researcher", summary: "partial research kept", severity: "info" }],
        costUsd: 0.01,
      }),
    );

    const s = store.session;
    expect(s.draft).toBe("Good full plan.");
    expect(s.findings.map((f) => f.summary)).toContain("partial research kept");
    expect(s.rounds).toBe(2);
    expect(s.totalCouncilCostUsd).toBeCloseTo(0.01, 8);
  });

  test("an aborted round MAY seed an empty draft (research is kept)", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(emptyResult({ draft: "Partial plan.", aborted: true }));
    expect(store.session.draft).toBe("Partial plan.");
  });

  test("legacy draftDelta key is still read as the draft (one-release alias)", () => {
    const store = new PlanSessionStore("g");
    const legacy = {
      ...emptyResult(),
      draftDelta: "Legacy-keyed plan.",
    } as unknown as CouncilRoundResult;
    store.applyCouncilResult(legacy);
    expect(store.session.draft).toBe("Legacy-keyed plan.");
    // The new key wins when both are present.
    const both = {
      ...emptyResult({ draft: "New-keyed plan." }),
      draftDelta: "stale",
    } as unknown as CouncilRoundResult;
    store.applyCouncilResult(both);
    expect(store.session.draft).toBe("New-keyed plan.");
  });

  test("is fail-open on a malformed result (never throws, no partial round bump)", () => {
    const store = new PlanSessionStore("g");
    // Malformed: decisions is not an array of objects — iterating/normalizing throws internally.
    const bad = { costUsd: 0.05 } as unknown as CouncilRoundResult;
    bad.decisions = [null as unknown as { topic: string; decision: string; rationale: string }];
    expect(() => store.applyCouncilResult(bad)).not.toThrow();

    // A totally malformed object also must not throw.
    expect(() =>
      store.applyCouncilResult(undefined as unknown as CouncilRoundResult),
    ).not.toThrow();
  });
});

describe("PlanSessionStore.answerQuestion", () => {
  test("marks the matching open question answered and records a user decision", () => {
    const store = new PlanSessionStore("g");
    store.addSurfacedQuestions(
      [{ question: "Which runtime?", header: "h", options: [], why: "w" }],
      1,
    );
    store.answerQuestion("which runtime?", "Bun");

    const s = store.session;
    const q = s.openQuestions[0];
    expect(q?.status).toBe("answered");
    expect(q?.answer).toBe("Bun");

    const decision = s.decisions.find((d) => d.resolvedBy === "user");
    expect(decision).toBeDefined();
    expect(decision?.topic).toBe("which runtime?");
    expect(decision?.decision).toBe("Bun");
  });
});

describe("PlanSessionStore.recordUserTurn", () => {
  test("appends a fact, ignoring blank turns", () => {
    const store = new PlanSessionStore("g");
    store.recordUserTurn("  ");
    expect(store.session.facts).toHaveLength(0);
    store.recordUserTurn("prefer minimal deps");
    expect(store.session.facts).toHaveLength(1);
    expect(store.session.facts[0]?.text).toBe("prefer minimal deps");
  });
});

describe("PlanSessionStore.snapshotBlock", () => {
  test("includes goal, decisions, and open questions", () => {
    const store = new PlanSessionStore("Ship the planner");
    store.applyCouncilResult(
      emptyResult({
        decisions: [{ topic: "Storage", decision: "Use SQLite", rationale: "r" }],
        questions: [{ question: "Which runtime?", header: "h", options: [], why: "w" }],
        draft: "Draft body here.",
      }),
    );
    const snap = store.snapshotBlock();
    expect(snap).toContain("Ship the planner");
    expect(snap).toContain("Storage: Use SQLite");
    expect(snap).toContain("Which runtime?");
    expect(snap).toContain("Draft body here.");
  });

  test("buildPlannerSystemPrompt concatenates base persona + snapshot", () => {
    const store = new PlanSessionStore("g");
    const prompt = buildPlannerSystemPrompt("You are the planner.", store);
    expect(prompt).toContain("You are the planner.");
    expect(prompt).toContain(store.snapshotBlock());
  });

  test("clips a huge draft to ~6k chars (head+tail kept); toMarkdown keeps it whole", () => {
    const store = new PlanSessionStore("g");
    const draft = `HEAD-MARKER ${"x".repeat(50_000)} TAIL-MARKER`;
    store.applyCouncilResult(emptyResult({ draft }));

    const snap = store.snapshotBlock();
    expect(snap).toContain("HEAD-MARKER");
    expect(snap).toContain("TAIL-MARKER");
    expect(snap).toContain("chars truncated");
    // The projection is bounded regardless of draft size.
    expect(snap.length).toBeLessThan(7_000);

    const md = store.toMarkdown();
    expect(md).toContain(draft);
    expect(md).not.toContain("chars truncated");
  });
});

describe("PlanSessionStore.toMarkdown", () => {
  test("emits every required section and flags unresolved open questions", () => {
    const store = new PlanSessionStore("Build a widget");
    store.applyCouncilResult(
      emptyResult({
        draft: "Build the widget in three phases.",
        decisions: [{ topic: "Storage", decision: "Use SQLite", rationale: "embedded" }],
        constraints: ["No network at build time"],
        findings: [{ source: "researcher", summary: "SQLite ships with Bun", severity: "info" }],
        facts: ["User prefers TypeScript"],
        questions: [{ question: "Which runtime?", header: "h", options: [], why: "affects deps" }],
        costUsd: 0.02,
      }),
    );
    const md = store.toMarkdown();

    expect(md).toContain("# Ground Truth: Build a widget");
    expect(md).toContain("## Goal");
    expect(md).toContain("## Constraints");
    expect(md).toContain("- No network at build time");
    expect(md).toContain("## Key Decisions");
    expect(md).toContain("### Storage");
    expect(md).toContain("**Decision:** Use SQLite");
    expect(md).toContain("**Rationale:** embedded");
    expect(md).toContain("resolved by council, round 1");
    expect(md).toContain("## Plan");
    expect(md).toContain("Build the widget in three phases.");
    expect(md).toContain("## Open Questions");
    // Unresolved open question is flagged with an unchecked checkbox.
    expect(md).toContain("- [ ] Which runtime?");
    expect(md).toContain("## Context & Findings");
    expect(md).toContain("SQLite ships with Bun");
    expect(md).toContain("User prefers TypeScript");
  });

  test("renders the council's own-words title and goal restatement over the raw input", () => {
    const store = new PlanSessionStore("hello plan me somehing useless (i need to test you)");
    store.applyCouncilResult(
      emptyResult({
        title: "Throwaway test plan",
        refinedGoal: "Produce a minimal, low-effort plan to exercise the planning council.",
        draft: "Do a trivial thing.",
      }),
    );
    const md = store.toMarkdown();

    expect(md).toContain("# Ground Truth: Throwaway test plan");
    expect(md).toContain(
      "## Goal\n\nProduce a minimal, low-effort plan to exercise the planning council.",
    );
    // The raw user input is NOT echoed as the title/goal.
    expect(md).not.toContain("somehing useless");
  });

  test("first council round's title/goal wins and stays stable across later rounds", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(emptyResult({ title: "First title", refinedGoal: "First goal." }));
    store.applyCouncilResult(emptyResult({ title: "Second title", refinedGoal: "Second goal." }));
    expect(store.session.title).toBe("First title");
    expect(store.session.refinedGoal).toBe("First goal.");
  });

  test("falls back to the raw goal when the council supplies no title/goal", () => {
    const store = new PlanSessionStore("Add rate limiting");
    store.applyCouncilResult(emptyResult({ draft: "some plan" }));
    const md = store.toMarkdown();
    expect(md).toContain("# Ground Truth: Add rate limiting");
    expect(md).toContain("## Goal\n\nAdd rate limiting");
  });

  test("answered questions drop out of the Open Questions section", () => {
    const store = new PlanSessionStore("g");
    store.addSurfacedQuestions(
      [{ question: "Which runtime?", header: "h", options: [], why: "w" }],
      1,
    );
    store.answerQuestion("Which runtime?", "Bun");
    const md = store.toMarkdown();
    expect(md).not.toContain("- [ ] Which runtime?");
  });
});

describe("PlanSessionStore.adoptGoalIfEmpty", () => {
  test("sets the goal on a session that started with no goal", () => {
    const store = new PlanSessionStore("");
    store.adoptGoalIfEmpty("Implement an iterative binary search over a sorted int array");
    expect(store.session.goal).toBe("Implement an iterative binary search over a sorted int array");
  });

  test("is a no-op when a goal already exists (explicit /plan start not clobbered)", () => {
    const store = new PlanSessionStore("Build a widget");
    store.adoptGoalIfEmpty("something else entirely");
    expect(store.session.goal).toBe("Build a widget");
  });

  test("ignores empty / whitespace-only input", () => {
    const store = new PlanSessionStore("");
    store.adoptGoalIfEmpty("   \n  ");
    expect(store.session.goal).toBe("");
  });

  test("caps multi-line / over-long input to a single-line title", () => {
    const store = new PlanSessionStore("");
    const long = `${"x".repeat(200)}\nsecond line`;
    store.adoptGoalIfEmpty(long);
    const goal = store.session.goal;
    expect(goal).not.toContain("\n");
    expect(goal).not.toContain("second line");
    expect(goal.length).toBeLessThanOrEqual(100);
    expect(goal.endsWith("…")).toBe(true);
  });

  test("populates the ground-truth doc header and Goal section", () => {
    const store = new PlanSessionStore("");
    store.adoptGoalIfEmpty("Add rate limiting to the public API");
    const md = store.toMarkdown();
    expect(md).toContain("# Ground Truth: Add rate limiting to the public API");
    expect(md).toContain("## Goal\n\nAdd rate limiting to the public API");
    expect(md).not.toContain("Untitled Plan");
    expect(md).not.toContain("_No goal recorded._");
  });
});

describe("PlanSessionStore.hasSubstance", () => {
  test("false on a fresh store, true after a decision or a draft", () => {
    const store = new PlanSessionStore("g");
    expect(store.hasSubstance()).toBe(false);

    const withDraft = new PlanSessionStore("g");
    withDraft.applyCouncilResult(emptyResult({ draft: "some plan" }));
    expect(withDraft.hasSubstance()).toBe(true);

    const withDecision = new PlanSessionStore("g");
    withDecision.applyCouncilResult(
      emptyResult({ decisions: [{ topic: "t", decision: "d", rationale: "r" }] }),
    );
    expect(withDecision.hasSubstance()).toBe(true);
  });
});

describe("PlanSessionStore.toGroundTruth", () => {
  test("renders a rich, detailed doc from an LLM synthesis (even with zero council rounds)", () => {
    const store = new PlanSessionStore("lets build binary searches");
    const md = store.toGroundTruth(
      synth({
        title: "Binary search library in Python",
        goal: "Implement iterative and recursive binary search over sorted lists in Python.",
        overview: "A small, dependency-free Python module with a clean public API and tests.",
        requirements: ["Return the index of the target or -1", "Support any comparable element type"],
        constraints: ["Language: Python 3", "No third-party dependencies"],
        decisions: [
          { topic: "Language", decision: "Python 3", rationale: "user asked for Python" },
        ],
        approach: ["Create binary_search.py", "Implement bisect-style search", "Add pytest cases"],
        risks: ["Off-by-one on the midpoint", "Unsorted input is undefined behavior"],
        successCriteria: ["All pytest cases pass"],
        openItems: [],
      }),
    );

    expect(md).toContain("# Ground Truth: Binary search library in Python");
    // Zero rounds → the header does NOT claim rounds/cost.
    expect(md).toContain("from the planning conversation");
    expect(md).not.toContain("0 rounds");
    expect(md).toContain("## Goal\n\nImplement iterative and recursive binary search");
    expect(md).toContain("## Overview");
    expect(md).toContain("## Requirements");
    expect(md).toContain("- Return the index of the target or -1");
    expect(md).toContain("## Constraints");
    expect(md).toContain("- Language: Python 3");
    expect(md).toContain("### Language");
    expect(md).toContain("**Decision:** Python 3");
    expect(md).toContain("## Implementation Plan");
    // Ordered, numbered steps.
    expect(md).toContain("1. Create binary_search.py");
    expect(md).toContain("3. Add pytest cases");
    expect(md).toContain("## Risks & Edge Cases");
    expect(md).toContain("## Success Criteria");
    // Empty sections are omitted, not rendered as "_None_".
    expect(md).not.toContain("Deferred / Open Items");
    expect(md).not.toContain("_None recorded._");
  });

  test("uses council-accumulated constraints/decisions as a floor when the synthesis omits them", () => {
    const store = new PlanSessionStore("g");
    store.applyCouncilResult(
      emptyResult({
        constraints: ["must stay offline"],
        decisions: [{ topic: "Store", decision: "SQLite", rationale: "embedded" }],
      }),
    );
    // Synthesis provides prose but no constraints/decisions → fall back to session state.
    const md = store.toGroundTruth(synth({ title: "T", goal: "do the thing", approach: ["step"] }));
    expect(md).toContain("- must stay offline");
    expect(md).toContain("### Store");
    expect(md).toContain("**Decision:** SQLite");
  });

  test("falls back to deterministic toMarkdown() when there is no synthesis", () => {
    const store = new PlanSessionStore("Build a widget");
    store.applyCouncilResult(emptyResult({ draft: "Do the widget." }));
    expect(store.toGroundTruth(null)).toBe(store.toMarkdown());
  });
});
