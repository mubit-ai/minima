/**
 * plan_seed — canned CouncilRoundResults for the /plan-seed demo command (MP16), the
 * hermetic evidence path for the D3b draft view (precedent: /gt-seed for the GT overview).
 * Two rounds so a capture can show turn-over-turn convergence: round 1 = a first draft with
 * an open question; round 2 = a richer revision with a second decision and the question
 * count growing. Pure data — no I/O, no model calls.
 */
import type { CouncilRoundResult } from "./plan_session.ts";

export const SEED_ROUND_1: CouncilRoundResult = {
  title: "Demo Widget Wiring",
  refinedGoal: "Ship the demo widget through the existing footer registry seam.",
  draft: [
    "## Demo widget plan",
    "",
    "1. Scaffold `demo_widget.ts` with the render entry point.",
    "2. Wire the widget into the footer registry.",
    "3. Add a regression test that pins the rendered rows.",
  ].join("\n"),
  decisions: [
    {
      topic: "registry seam",
      decision: "reuse the existing factory registry",
      rationale: "no new plumbing",
    },
  ],
  findings: [
    { source: "researcher", summary: "footer registry exposes a factory seam", severity: "info" },
    { source: "critic", summary: "row pin must cover the 60-col floor", severity: "concern" },
  ],
  faults: [],
  questions: [
    {
      question: "Should the widget register eagerly or lazily?",
      header: "registration",
      options: [
        { label: "eager", description: "simple, tiny startup cost", recommended: true },
        { label: "lazy", description: "defers work, more moving parts" },
      ],
      why: "affects startup ordering",
    },
  ],
  facts: ["the footer registry lives in the TUI layer"],
  constraints: ["no new dependencies"],
  costUsd: 0,
  aborted: false,
};

export const SEED_ROUND_2: CouncilRoundResult = {
  draft: [
    "## Demo widget plan (revised)",
    "",
    "1. Scaffold `demo_widget.ts` with the render entry point.",
    "2. Register eagerly through the factory registry at footer mount.",
    "3. Pin the rendered rows at 120 AND 60 cols in one regression test.",
    "4. Document the registry ordering contract beside the seam.",
  ].join("\n"),
  decisions: [
    {
      topic: "row pinning",
      decision: "pin at 120 and 60 cols in the same test",
      rationale: "the 60-col floor is where pins break",
    },
  ],
  findings: [
    {
      source: "researcher",
      summary: "registry ordering is load-bearing at mount",
      severity: "concern",
    },
  ],
  faults: [],
  questions: [
    {
      question: "Does the ordering contract need a runtime assert or a doc note?",
      header: "ordering",
      options: [
        { label: "doc note", description: "cheap, matches current style", recommended: true },
        { label: "runtime assert", description: "louder, costs a check per mount" },
      ],
      why: "silent misordering is invisible until a regression",
    },
  ],
  facts: [],
  constraints: [],
  costUsd: 0,
  aborted: false,
};
