/**
 * Observer tripwires (PR-E, E2) — deterministic, pure predicates over the observer's
 * per-turn trajectory digest. Each returns a verdict or null; the drain loop (observer.ts)
 * decides what a verdict becomes (steer / DB row / audit gate). Nothing here touches the
 * DB, the agent, or the network — pure functions so every wire is trivially testable.
 *
 * Severity policy: `warn` verdicts earn a recId:null audit gate (anti-spiral pattern);
 * `info` verdicts are store-only. The anti-stub heuristic is `info` on purpose — it is a
 * regex approximation and must never look like hard evidence.
 */

/** One finished turn as the observer saw it — the tripwires' entire input surface. */
export interface ObserverTurn {
  turn: number;
  /** Done-claim snippets matched in the assistant text (empty = no completion claim). */
  claims: string[];
  /** Tool names called this turn. */
  tools: string[];
  /** Paths passed to write/edit/apply_patch this turn. */
  filesTouched: string[];
  /** New content written this turn (write.content / edit.new_string / apply_patch.patch). */
  writes: { path: string; content: string }[];
  /** Gate verdicts that landed under this turn's rec_id (read-only poll). */
  gateVerdicts: { outcome: string | null; confidence: string | null }[];
  /** How many off_plan file_changes rows landed during this turn. */
  offPlanChanges: number;
  /** The assistant's final text, truncated at capture time. UNTRUSTED actor output. */
  assistantText: string;
}

/** A plan step's status as the tripwires need it (subset of PlanStepRow). */
export interface ObserverPlanStep {
  content: string | null;
  status: string | null;
}

export interface TripwireVerdict {
  kind: string;
  claim: string;
  evidenceRef: string;
  severity: "info" | "warn";
}

export interface TripwireInput {
  turn: ObserverTurn;
  planSteps: ObserverPlanStep[];
}

export type Tripwire = (input: TripwireInput) => TripwireVerdict | null;

/** Claims of completion in actor text — deliberately broad; tripwires only ADVISE. */
export const DONE_CLAIM_RE = /\b(?:done|complete[d]?|finished|fixed|all tests pass(?:ing)?)\b/i;

/** Paths that smell like tests or verification machinery. */
export const TEST_PATH_RE = /test|spec|\.test\.|verify/i;

/** Off-plan file changes in one turn at/above this count = a burst. */
export const OFF_PLAN_BURST_MIN = 3;

/** T1: the actor edited a test/spec/verify file while a plan step is in progress —
 * exactly when weakening a check would go unnoticed by the step's own gate. */
export function testEditTripwire(input: TripwireInput): TripwireVerdict | null {
  if (!input.planSteps.some((s) => s.status === "in_progress")) return null;
  const hits = input.turn.filesTouched.filter((p) => TEST_PATH_RE.test(p));
  if (hits.length === 0) return null;
  return {
    kind: "test_edit",
    claim: "edited a test/verify file while a plan step is in progress",
    evidenceRef: hits.slice(0, 5).join(", "),
    severity: "warn",
  };
}

/** T2: the actor claims completion while plan steps sit unchecked or failing. */
export function doneClaimTripwire(input: TripwireInput): TripwireVerdict | null {
  if (input.turn.claims.length === 0 || input.planSteps.length === 0) return null;
  const open = input.planSteps.filter((s) => s.status !== "completed");
  if (open.length === 0) return null;
  return {
    kind: "done_claim",
    claim: `claimed "${input.turn.claims[0]}" with ${open.length} plan step(s) not completed`,
    evidenceRef: open
      .slice(0, 3)
      .map((s) => `${s.status ?? "?"}: ${(s.content ?? "").slice(0, 60)}`)
      .join(" | "),
    severity: "warn",
  };
}

/** T3: an off-plan burst — several file changes in one turn none of which attribute to a
 * plan step (origin='off_plan'). Drift, or work the plan never sanctioned. */
export function offPlanBurstTripwire(input: TripwireInput): TripwireVerdict | null {
  if (input.turn.offPlanChanges < OFF_PLAN_BURST_MIN) return null;
  return {
    kind: "off_plan_burst",
    claim: `${input.turn.offPlanChanges} off-plan file changes in one turn`,
    evidenceRef: `turn ${input.turn.turn}`,
    severity: "warn",
  };
}

/** Minimum leading-comment length for the stub heuristic. */
export const STUB_COMMENT_MIN_CHARS = 200;
/** Maximum trivial-body length after the comment block for the stub heuristic. */
export const STUB_BODY_MAX_CHARS = 80;

/**
 * Regex approximation of a stub: a file whose content is a LARGE leading comment block
 * (>= STUB_COMMENT_MIN_CHARS of contiguous line comments or one block comment — the
 * "explanation instead of implementation" shape) followed by a trivial body
 * (<= STUB_BODY_MAX_CHARS of actual code, e.g. `return null` / `pass` / `{}`). Documented
 * limitation: purely lexical — it cannot see semantics, so it stays severity `info`.
 */
export function isStubContent(content: string): boolean {
  const m = /^\s*((?:(?:\/\/|#)[^\n]*\n\s*)+|\/\*[\s\S]*?\*\/)\s*([\s\S]*)$/.exec(content);
  if (!m) return false;
  const comment = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  return comment.length >= STUB_COMMENT_MIN_CHARS && body.length <= STUB_BODY_MAX_CHARS;
}

/** T4: a write/edit this turn looks like a stub — big comment, no real body. */
export function antiStubTripwire(input: TripwireInput): TripwireVerdict | null {
  const stub = input.turn.writes.find((w) => isStubContent(w.content));
  if (!stub) return null;
  return {
    kind: "stub_write",
    claim: `wrote what looks like a stub (large comment block, trivial body) to ${stub.path}`,
    evidenceRef: stub.path,
    severity: "info",
  };
}

export const TRIPWIRES: readonly Tripwire[] = [
  testEditTripwire,
  doneClaimTripwire,
  offPlanBurstTripwire,
  antiStubTripwire,
];

/** Run every tripwire over one finished turn; a throwing tripwire is skipped (advisory
 * machinery must never take down the drain). */
export function runTripwires(input: TripwireInput): TripwireVerdict[] {
  const out: TripwireVerdict[] = [];
  for (const t of TRIPWIRES) {
    try {
      const v = t(input);
      if (v) out.push(v);
    } catch {
      // a broken heuristic is dropped, never propagated
    }
  }
  return out;
}
