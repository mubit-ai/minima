import { describe, expect, test } from "bun:test";
import {
  type CouncilRoundResult,
  PlanSessionStore,
  buildPlannerSystemPrompt,
} from "../src/minima/plan_session.ts";

const emptyResult = (over: Partial<CouncilRoundResult> = {}): CouncilRoundResult => ({
  draftDelta: "",
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
        draftDelta: "Step 1: sketch the API.",
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
        draftDelta: "Draft body here.",
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
});

describe("PlanSessionStore.toMarkdown", () => {
  test("emits every required section and flags unresolved open questions", () => {
    const store = new PlanSessionStore("Build a widget");
    store.applyCouncilResult(
      emptyResult({
        draftDelta: "Build the widget in three phases.",
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
    withDraft.applyCouncilResult(emptyResult({ draftDelta: "some plan" }));
    expect(withDraft.hasSubstance()).toBe(true);

    const withDecision = new PlanSessionStore("g");
    withDecision.applyCouncilResult(
      emptyResult({ decisions: [{ topic: "t", decision: "d", rationale: "r" }] }),
    );
    expect(withDecision.hasSubstance()).toBe(true);
  });
});
