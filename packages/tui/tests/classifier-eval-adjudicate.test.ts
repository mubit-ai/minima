import { describe, expect, test } from "bun:test";
import {
  type AdjudicationConfig,
  type ConsensusFn,
  type EntryDecision,
  MIN_REPORTABLE_SUPPORT,
  type OverrideCandidate,
  type ReferenceVote,
  type ScoredRow,
  type ThresholdPoint,
  breakdownByServiceLabel,
  buildAdjudicationReport,
  deriveFloor,
  outcomeOf,
  renderAdjudicationReport,
  scoreCandidates,
  sweepThresholds,
  tabulateOutcomes,
  thresholdCandidates,
} from "../src/minima/classifier_eval_adjudicate.ts";
import type { TaskType } from "../src/minima/schemas.ts";

// MUB-226 — override adjudication. Every test here constructs rows directly: no ledger, no cache
// table, no network, no spend. The consensus rule is INJECTED (ADR 0001), so the stubs below stand
// in for MUB-216's read-time function and this module never owns a quorum rule.
//
// Every asserted figure was computed by hand from the fixture and the arithmetic is written beside
// it. A fixture that omits a required field is how MUB-215 shipped a test comparing NaN to NaN.

// ---------------------------------------------------------------------------
// Consensus stubs. NEITHER is a rule this module ships — both exist to prove the rule is the
// caller's, by adjudicating the SAME vote rows differently (see the paired test at the bottom).
// ---------------------------------------------------------------------------

/**
 * The panel size both stubs quorum against. Stated here because the real rule takes it as an
 * argument (MUB-216 binds it to the shipped panel) and a stub that inferred it from the votes in
 * hand could never report `incomplete` — it would call a two-of-three panel unanimous, which is the
 * exact pseudo-gold this seam exists to prevent.
 */
const PANEL_SIZE = 3;

/** Usable labels only. A null vote is a panelist that answered with nothing, not a label. */
function labelled(votes: readonly ReferenceVote[]): TaskType[] {
  return votes.map((v) => v.taskType).filter((t): t is TaskType => t !== null);
}

/** A verdict only when every panelist voted and they all agree. */
const unanimousOnly: ConsensusFn = (votes) => {
  const labels = labelled(votes);
  if (labels.length < PANEL_SIZE) return { kind: "incomplete" };
  return new Set(labels).size === 1
    ? { kind: "unanimous", label: labels[0] as TaskType }
    : { kind: "split" };
};

/**
 * A verdict when one label holds strictly more than half the cached votes.
 *
 * It reports its answer on the `unanimous` arm because the discriminants belong to MUB-216's type,
 * not to whoever injects a rule — which is the whole point: this stub scores rows the shipped rule
 * refuses, over the same votes, without either module owning a second quorum rule.
 */
const simpleMajority: ConsensusFn = (votes) => {
  const counts = new Map<TaskType, number>();
  for (const t of labelled(votes)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [label, n] of counts) if (n * 2 > votes.length) return { kind: "unanimous", label };
  return labelled(votes).length < PANEL_SIZE ? { kind: "incomplete" } : { kind: "split" };
};

// ---------------------------------------------------------------------------
// Fixtures. Every field is stated: nothing here is defaulted into existence.
// ---------------------------------------------------------------------------

const CFG: AdjudicationConfig = {
  scope: "test",
  regimeBoundaryTs: 100,
  corpusRev: "r-test",
  currentFloor: 0.75,
};

function dec(
  ts: number,
  serviceLabel: TaskType | null,
  corroboration: EntryDecision["corroboration"] = "corroborated",
): EntryDecision {
  return { ts, serviceLabel, corroboration };
}

/** One candidate: a `before`-regime prompt the service called `code` and the replay agreed with. */
function cand(promptHash: string, over: Partial<OverrideCandidate> = {}): OverrideCandidate {
  return {
    promptHash,
    decisions: [dec(10, "code")],
    harnessLabel: "code",
    harnessSelfReport: 0.9,
    ...over,
  };
}

/**
 * `n` cached votes for one prompt, all at the fixture's corpus rev unless told otherwise. A `null`
 * label is a real cached row: the panelist answered, with nothing usable as a label.
 */
function votes(
  promptHash: string,
  labels: readonly (TaskType | null)[],
  corpusRev = CFG.corpusRev,
): ReferenceVote[] {
  return labels.map((taskType, i) => ({ promptHash, modelId: `m${i}`, taskType, corpusRev }));
}

/** A scored row, so the tabulation can be tested without going through the assembly at all. */
function row(over: Partial<ScoredRow> = {}): ScoredRow {
  return {
    promptHash: "h",
    serviceLabel: "code",
    harnessLabel: "code",
    selfReport: 0.9,
    referenceLabel: "code",
    regime: "before",
    corroboration: "corroborated",
    serviceLabelVaried: false,
    panelVotes: 3,
    panelDistinctLabels: 1,
    ...over,
  };
}

describe("outcomeOf — the four-way cell", () => {
  test("both right is a no-op: agreeing with a correct label changes nothing", () => {
    expect(
      outcomeOf(row({ serviceLabel: "code", harnessLabel: "code", referenceLabel: "code" })),
    ).toBe("no-op");
  });

  test("service right and harness wrong is harm — the cell the floor exists to suppress", () => {
    expect(
      outcomeOf(row({ serviceLabel: "code", harnessLabel: "qa", referenceLabel: "code" })),
    ).toBe("harm");
  });

  test("service wrong and harness right is a correction — the whole point of overriding", () => {
    expect(
      outcomeOf(row({ serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" })),
    ).toBe("correction");
  });

  test("both wrong, even when they are wrong in different ways", () => {
    expect(
      outcomeOf(row({ serviceLabel: "qa", harnessLabel: "rag", referenceLabel: "code" })),
    ).toBe("both-wrong");
  });
});

describe("tabulateOutcomes", () => {
  test("every cell carries the same denominator, and net is corrections minus breakages", () => {
    // 2 corrections, 1 harm, 1 no-op — 4 rows. net = 2 - 1 = 1.
    const t = tabulateOutcomes([
      row({ serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }),
      row({ serviceLabel: "qa", harnessLabel: "code", referenceLabel: "code" }),
      row({ serviceLabel: "code", harnessLabel: "qa", referenceLabel: "code" }),
      row(),
    ]);
    expect(t.rows).toBe(4);
    expect(t.correctionShare).toEqual({ n: 2, d: 4, pct: 50 });
    expect(t.harmShare).toEqual({ n: 1, d: 4, pct: 25 });
    expect(t.noOpShare).toEqual({ n: 1, d: 4, pct: 25 });
    expect(t.bothWrongShare).toEqual({ n: 0, d: 4, pct: 0 });
    expect(t.net).toBe(1);
    // The counts and their shares are the same numbers, from one count of the cells.
    expect([t.corrections, t.harms, t.noOps, t.bothWrong]).toEqual([2, 1, 1, 0]);
  });

  test("an empty population yields a null percentage rather than NaN", () => {
    const t = tabulateOutcomes([]);
    expect(t.rows).toBe(0);
    expect(t.correctionShare.pct).toBeNull();
    expect(t.net).toBe(0);
  });
});

describe("sweepThresholds", () => {
  // Six rows, self-reports chosen so the net crosses zero twice — the reason the ticket asks for
  // counts at every candidate rather than one recommended number.
  const SWEEP_ROWS: ScoredRow[] = [
    row({ selfReport: 0.5, serviceLabel: "qa", harnessLabel: "rag", referenceLabel: "code" }), // both wrong
    row({ selfReport: 0.6, serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }), // correction
    row({ selfReport: 0.8, serviceLabel: "code", harnessLabel: "qa", referenceLabel: "code" }), // harm
    row({ selfReport: 0.9, serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }), // correction
    row({ selfReport: 0.95 }), // no-op
    row({ selfReport: 0.99, serviceLabel: "code", harnessLabel: "other", referenceLabel: "code" }), // harm
  ];

  const CANDIDATE_FLOORS = thresholdCandidates(SWEEP_ROWS, 0.75);

  test("candidates are the observed self-reports plus the shipped floor, ascending", () => {
    // Observed: 0.5 0.6 0.8 0.9 0.95 0.99. The floor 0.75 is spliced in so the readout can be
    // argued against the shipped baseline even though no row sits exactly on it.
    expect(CANDIDATE_FLOORS).toEqual([0.5, 0.6, 0.75, 0.8, 0.9, 0.95, 0.99]);
  });

  test("a row is overridden at or above the threshold — the shipped gate's own comparison", () => {
    const at = (t: number) =>
      sweepThresholds(SWEEP_ROWS, CANDIDATE_FLOORS).find((p) => p.threshold === t);
    // 0.8: the 0.5 and 0.6 rows drop out, the 0.8 row stays (>=, not >). 4 overridden.
    // corrections = the 0.9 row alone = 1; harms = 0.8 and 0.99 = 2; net = -1.
    expect(at(0.8)).toEqual({ threshold: 0.8, overridden: 4, corrections: 1, harms: 2, net: -1 });
    // 0.5: everything is overridden. corrections 2, harms 2, net 0.
    expect(at(0.5)).toEqual({ threshold: 0.5, overridden: 6, corrections: 2, harms: 2, net: 0 });
    // 0.9: the 0.9/0.95/0.99 rows. corrections 1, harms 1, net 0.
    expect(at(0.9)).toEqual({ threshold: 0.9, overridden: 3, corrections: 1, harms: 1, net: 0 });
  });

  test("a population with no rows sweeps to nothing but the stated floor", () => {
    expect(thresholdCandidates([], 0.75)).toEqual([0.75]);
    expect(sweepThresholds([], [0.75])[0]).toEqual({
      threshold: 0.75,
      overridden: 0,
      corrections: 0,
      harms: 0,
      net: 0,
    });
  });
});

describe("deriveFloor", () => {
  const point = (threshold: number, net: number): ThresholdPoint => ({
    threshold,
    overridden: 0,
    corrections: net > 0 ? net : 0,
    harms: net < 0 ? -net : 0,
    net,
  });

  test("the floor is where the net goes positive AND stays positive", () => {
    expect(deriveFloor([point(0.5, -1), point(0.6, 0), point(0.7, 1), point(0.8, 2)])).toEqual({
      floor: 0.7,
      lowestNetPositive: 0.7,
    });
  });

  test("a crossing the net falls back from is NOT a floor — the two figures diverge", () => {
    // The trap the ticket's 'counts at each candidate, not one number' rule exists for: quoting
    // 0.5 alone would name a threshold above which the property does not hold.
    expect(deriveFloor([point(0.5, 1), point(0.75, 0), point(0.9, 1)])).toEqual({
      floor: 0.9,
      lowestNetPositive: 0.5,
    });
  });

  test("a sweep that never nets positive has no floor and no crossing", () => {
    expect(deriveFloor([point(0.5, 0), point(0.9, -2)])).toEqual({
      floor: null,
      lowestNetPositive: null,
    });
  });

  test("an empty sweep is total, not a crash", () => {
    expect(deriveFloor([])).toEqual({ floor: null, lowestNetPositive: null });
  });
});

describe("breakdownByServiceLabel", () => {
  test("single-digit support withholds the share rather than printing a percentage", () => {
    const rows = [
      row({ serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }),
      row({ serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }),
      row({ serviceLabel: "code", harnessLabel: "qa", referenceLabel: "code" }),
    ];
    const b = breakdownByServiceLabel(rows);
    // TASK_TYPES order, filtered to the labels actually observed: code before other.
    expect(b.map((x) => x.taskType)).toEqual(["code", "other"]);
    const other = b.find((x) => x.taskType === "other");
    expect(other).toMatchObject({ support: 2, corrections: 2, harms: 0, net: 2 });
    expect(other?.correctionShare).toBeNull();
    expect(other?.harmShare).toBeNull();
  });

  test("support at the reportable floor earns a share with its denominator", () => {
    // 10 rows under one service label: 7 corrections, 3 harms. 10 is the first reportable support.
    const rows = [
      ...Array.from({ length: 7 }, () =>
        row({ serviceLabel: "other", harnessLabel: "code", referenceLabel: "code" }),
      ),
      ...Array.from({ length: 3 }, () =>
        row({ serviceLabel: "other", harnessLabel: "qa", referenceLabel: "other" }),
      ),
    ];
    expect(MIN_REPORTABLE_SUPPORT).toBe(10);
    const other = breakdownByServiceLabel(rows).find((x) => x.taskType === "other");
    expect(other).toMatchObject({ support: 10, corrections: 7, harms: 3, net: 4 });
    expect(other?.correctionShare).toEqual({ n: 7, d: 10, pct: 70 });
    expect(other?.harmShare).toEqual({ n: 3, d: 10, pct: 30 });
  });
});

describe("scoreCandidates — assembly, and what it refuses to score", () => {
  test("scores a candidate from the cached votes the injected rule agreed on", () => {
    const { rows, excluded } = scoreCandidates(
      [cand("h1", { decisions: [dec(10, "other")], harnessLabel: "code", harnessSelfReport: 0.9 })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(excluded).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptHash: "h1",
      serviceLabel: "other",
      harnessLabel: "code",
      selfReport: 0.9,
      referenceLabel: "code",
      regime: "before",
      panelVotes: 3,
      panelDistinctLabels: 1,
    });
  });

  test("votes at another corpus rev are ABSENT, not stale-but-usable", () => {
    // ADR 0001: a corpus redefinition is a cache MISS. A rev-2 vote must not label a rev-1 run.
    const { rows, excluded } = scoreCandidates(
      [cand("h1")],
      votes("h1", ["code", "code", "code"], "r-old"),
      unanimousOnly,
      CFG,
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([{ promptHash: "h1", reason: "no-cached-label" }]);
  });

  test("a panel that labelled and disagreed is counted as its own exclusion, never dropped", () => {
    const { rows, excluded } = scoreCandidates(
      [cand("h1")],
      votes("h1", ["code", "qa", "other"]),
      unanimousOnly,
      CFG,
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([{ promptHash: "h1", reason: "panel-split" }]);
  });

  test("a panel that never finished is a DIFFERENT exclusion from one that disagreed", () => {
    // Two panelists agreeing and a third that produced no usable label is a coverage gap, not a
    // disagreement. One reason for both would put a missing panelist into the rate that describes
    // how hard the corpus is — and 226's own exclusion list is what a reader checks that against.
    const { rows, excluded } = scoreCandidates(
      [cand("h1")],
      votes("h1", ["code", "code", null]),
      unanimousOnly,
      CFG,
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([{ promptHash: "h1", reason: "panel-incomplete" }]);
  });

  test("a replay that declined cannot be adjudicated — no override would have happened", () => {
    const { excluded } = scoreCandidates(
      [cand("h1", { harnessLabel: null, harnessSelfReport: null })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(excluded).toEqual([{ promptHash: "h1", reason: "no-replayed-label" }]);
  });

  test("a label with no self-report is the same non-answer: it cannot sit on a sweep", () => {
    const { excluded } = scoreCandidates(
      [cand("h1", { harnessLabel: "code", harnessSelfReport: null })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(excluded).toEqual([{ promptHash: "h1", reason: "no-replayed-label" }]);
  });

  test("an initial route carrying no task type has no service label to adjudicate", () => {
    const { excluded } = scoreCandidates(
      [cand("h1", { decisions: [dec(10, null)] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(excluded).toEqual([{ promptHash: "h1", reason: "no-service-label" }]);
  });

  test("decisions on both sides of the boundary have two label authors — excluded, not blended", () => {
    const { rows, excluded } = scoreCandidates(
      [cand("h1", { decisions: [dec(90, "code"), dec(110, "code")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([{ promptHash: "h1", reason: "spans-regime-boundary" }]);
  });

  test("the ladder's rungs are one observation: the row is the initial route, variation counted", () => {
    // Three rungs of one prompt. The service relabelled on the way down; the override would have
    // replaced the FIRST route, so that is the row, and the disagreement is carried not discarded.
    const { rows } = scoreCandidates(
      [cand("h1", { decisions: [dec(10, "other"), dec(11, "code"), dec(12, "code")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceLabel).toBe("other");
    expect(rows[0]?.serviceLabelVaried).toBe(true);
  });

  test("rungs that agree are not flagged as varied", () => {
    const { rows } = scoreCandidates(
      [cand("h1", { decisions: [dec(10, "code"), dec(11, "code")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(rows[0]?.serviceLabelVaried).toBe(false);
  });

  test("a decision at the boundary instant is `after` — the boundary is lower-inclusive", () => {
    const { rows } = scoreCandidates(
      [cand("h1", { decisions: [dec(100, "code")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    );
    expect(rows[0]?.regime).toBe("after");
  });

  test("one failed pairing makes the entry uncorroborated; nothing to compare is neither", () => {
    const [both] = scoreCandidates(
      [cand("h1", { decisions: [dec(10, "code"), dec(11, "code", "uncorroborated")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    ).rows;
    expect(both?.corroboration).toBe("uncorroborated");

    const [none] = scoreCandidates(
      [cand("h1", { decisions: [dec(10, "code", "unassessable")] })],
      votes("h1", ["code", "code", "code"]),
      unanimousOnly,
      CFG,
    ).rows;
    expect(none?.corroboration).toBe("unassessable");
  });
});

// ---------------------------------------------------------------------------
// The whole readout, over one hand-computed corpus.
// ---------------------------------------------------------------------------

/**
 * Seven scorable candidates and five unscorable ones.
 *
 *   h1  before  service other · harness code @0.90 · ref code   -> correction
 *   h2  before  service code  · harness qa   @0.80 · ref code   -> harm          (uncorroborated)
 *   h3  before  service code  · harness code @0.95 · ref code   -> no-op
 *   h4  before  service qa    · harness rag  @0.50 · ref code   -> both-wrong    (unassessable)
 *   h5  after   service other · harness code @0.60 · ref code   -> correction
 *   h6  after   service other · harness code @0.99 · ref code   -> correction
 *   h7  after   service code  · harness other@0.99 · ref code   -> harm          (2-1 split panel)
 *   h8  no cached label at rev 1 · h9 panel 1-1-1 · h10 replay declined
 *   h11 spans the boundary       · h12 no service label
 */
const CANDIDATES: OverrideCandidate[] = [
  cand("h1", { decisions: [dec(10, "other")], harnessLabel: "code", harnessSelfReport: 0.9 }),
  cand("h2", {
    decisions: [dec(20, "code", "uncorroborated")],
    harnessLabel: "qa",
    harnessSelfReport: 0.8,
  }),
  cand("h3", { decisions: [dec(30, "code")], harnessLabel: "code", harnessSelfReport: 0.95 }),
  cand("h4", {
    decisions: [dec(40, "qa", "unassessable")],
    harnessLabel: "rag",
    harnessSelfReport: 0.5,
  }),
  cand("h5", { decisions: [dec(150, "other")], harnessLabel: "code", harnessSelfReport: 0.6 }),
  cand("h6", { decisions: [dec(160, "other")], harnessLabel: "code", harnessSelfReport: 0.99 }),
  cand("h7", { decisions: [dec(170, "code")], harnessLabel: "other", harnessSelfReport: 0.99 }),
  cand("h8", { decisions: [dec(50, "code")] }),
  cand("h9", { decisions: [dec(60, "code")] }),
  cand("h10", { decisions: [dec(70, "code")], harnessLabel: null, harnessSelfReport: null }),
  cand("h11", { decisions: [dec(90, "code"), dec(110, "code")] }),
  cand("h12", { decisions: [dec(80, null)] }),
];

const VOTES: ReferenceVote[] = [
  ...votes("h1", ["code", "code", "code"]),
  ...votes("h2", ["code", "code", "code"]),
  ...votes("h3", ["code", "code", "code"]),
  ...votes("h4", ["code", "code", "code"]),
  ...votes("h5", ["code", "code", "code"]),
  ...votes("h6", ["code", "code", "code"]),
  ...votes("h7", ["code", "code", "qa"]), // 2-1: a majority, not a unanimous panel
  ...votes("h8", ["code", "code", "code"], "r-old"), // a different corpus rev
  ...votes("h9", ["code", "qa", "other"]), // no majority under either rule
  ...votes("h10", ["code", "code", "code"]),
  ...votes("h11", ["code", "code", "code"]),
  ...votes("h12", ["code", "code", "code"]),
];

describe("buildAdjudicationReport", () => {
  const r = buildAdjudicationReport(CANDIDATES, VOTES, simpleMajority, CFG);

  test("the aggregate is 7 scored rows: 3 corrections, 2 harms, 1 no-op, 1 both-wrong", () => {
    expect(r.candidates).toBe(12);
    expect(r.scored).toBe(7);
    expect(r.aggregate.outcomes.correctionShare).toEqual({ n: 3, d: 7, pct: 42.9 });
    expect(r.aggregate.outcomes.harmShare).toEqual({ n: 2, d: 7, pct: 28.6 });
    expect(r.aggregate.outcomes.noOpShare).toEqual({ n: 1, d: 7, pct: 14.3 });
    expect(r.aggregate.outcomes.bothWrongShare).toEqual({ n: 1, d: 7, pct: 14.3 });
    expect(r.aggregate.outcomes.net).toBe(1); // 3 - 2
  });

  test("the segments sum exactly to the scored total — nothing is blended into the aggregate", () => {
    // before: h1 correction, h2 harm, h3 no-op, h4 both-wrong. after: h5 h6 corrections, h7 harm.
    expect(r.before.outcomes.rows).toBe(4);
    expect(r.after.outcomes.rows).toBe(3);
    expect(r.before.outcomes.rows + r.after.outcomes.rows).toBe(r.scored);
    expect(r.before.outcomes.net).toBe(0); // 1 - 1
    expect(r.after.outcomes.net).toBe(1); // 2 - 1
  });

  test("every unscorable candidate is counted under exactly one stated reason", () => {
    expect(r.excluded).toEqual([
      { reason: "no-service-label", count: 1 },
      { reason: "spans-regime-boundary", count: 1 },
      { reason: "no-replayed-label", count: 1 },
      { reason: "no-cached-label", count: 1 },
      { reason: "panel-split", count: 1 },
      { reason: "panel-incomplete", count: 0 },
    ]);
    expect(r.excludedTotal).toBe(5);
    expect(r.scored + r.excludedTotal).toBe(r.candidates);
  });

  test("all three sweeps print the same thresholds, so the eras can be read across", () => {
    // A segment sweep over only its own observed self-reports would omit rows the aggregate has —
    // 0.60 is observed only after the boundary, 0.50 only before it.
    const thresholds = r.aggregate.sweep.map((p) => p.threshold);
    expect(thresholds).toEqual([0.5, 0.6, 0.75, 0.8, 0.9, 0.95, 0.99]);
    expect(r.before.sweep.map((p) => p.threshold)).toEqual(thresholds);
    expect(r.after.sweep.map((p) => p.threshold)).toEqual(thresholds);
    // And at any threshold the two eras account for the aggregate exactly.
    for (const [i, p] of r.aggregate.sweep.entries()) {
      expect((r.before.sweep[i]?.overridden ?? 0) + (r.after.sweep[i]?.overridden ?? 0)).toBe(
        p.overridden,
      );
    }
  });

  test("no stable floor exists here: the net crosses positive at 0.50 and falls back", () => {
    // net by threshold: 0.5 -> +1, 0.6 -> +1, 0.75 -> 0, 0.8 -> 0, 0.9 -> +1, 0.95 -> 0, 0.99 -> 0.
    // No candidate has every stricter threshold positive, so there is no floor to quote — only a
    // crossing, which is a different claim.
    expect(r.aggregate.floor).toBeNull();
    expect(r.aggregate.lowestNetPositive).toBe(0.5);
    const atShippedFloor = r.aggregate.sweep.find((p) => p.threshold === 0.75);
    expect(atShippedFloor).toEqual({
      threshold: 0.75,
      overridden: 5,
      corrections: 2,
      harms: 2,
      net: 0,
    });
  });

  test("the correlation's influence is visible: corroborated-only moves the net", () => {
    // h2 (a harm) failed corroboration and h4 (both-wrong) had nothing to compare.
    expect(r.corroborated).toEqual({ n: 5, d: 6, pct: 83.3 });
    expect(r.uncorroborated).toBe(1);
    expect(r.corroborationUnassessable).toBe(1);
    expect(r.corroboratedOnly.aggregate.rows).toBe(5);
    expect(r.corroboratedOnly.aggregate.net).toBe(2); // 3 corrections - 1 harm
  });

  test("the sensitivity views are segmented too — a blended net never stands alone", () => {
    // corroborated: h1 h3 before (correction, no-op) · h5 h6 h7 after (correction, correction, harm)
    expect([r.corroboratedOnly.before.rows, r.corroboratedOnly.after.rows]).toEqual([2, 3]);
    expect([r.corroboratedOnly.before.net, r.corroboratedOnly.after.net]).toEqual([1, 1]);
    // unanimous: h1..h4 before · h5 h6 after (h7's panel split 2-1)
    expect([r.unanimousPanelOnly.before.rows, r.unanimousPanelOnly.after.rows]).toEqual([4, 2]);
    expect([r.unanimousPanelOnly.before.net, r.unanimousPanelOnly.after.net]).toEqual([0, 2]);
  });

  test("the panel's influence is visible: one harm rests on a 2-1 split, not a unanimous panel", () => {
    expect(r.panelUnanimous).toEqual({ n: 6, d: 7, pct: 85.7 });
    expect(r.unanimousPanelOnly.aggregate.rows).toBe(6);
    expect(r.unanimousPanelOnly.aggregate.harmShare).toEqual({ n: 1, d: 6, pct: 16.7 });
    expect(r.unanimousPanelOnly.aggregate.net).toBe(2); // 3 corrections - 1 harm
    // Every panel here had three votes, so none of that unanimity is the vacuous kind.
    expect(r.singleVoteRows).toBe(0);
  });

  test("one cached vote is an INCOMPLETE panel, never a vacuously unanimous one", () => {
    // A single model's opinion is not a panel that agreed. Under a rule that quorums against the
    // panel's size it cannot reach a verdict at all, so `singleVoteRows` reads 0 — the guard is
    // structural rather than a number someone remembers to check.
    const thin = [...votes("s1", ["code"]), ...votes("s2", ["code", "code", "code"])];
    const strict = buildAdjudicationReport([cand("s1"), cand("s2")], thin, unanimousOnly, CFG);
    expect(strict.scored).toBe(1);
    expect(strict.excluded.find((e) => e.reason === "panel-incomplete")?.count).toBe(1);
    expect(strict.singleVoteRows).toBe(0);

    // And the guard still counts when a LOOSER injected rule admits that one vote: the row is
    // scored, vacuously unanimous, and said so rather than folded into the agreement figure.
    const loose = buildAdjudicationReport([cand("s1"), cand("s2")], thin, simpleMajority, CFG);
    expect(loose.scored).toBe(2);
    expect(loose.panelUnanimous).toEqual({ n: 2, d: 2, pct: 100 });
    expect(loose.singleVoteRows).toBe(1);
  });

  test("the same cached votes adjudicate differently under a different consensus rule", () => {
    // This is why ADR 0001 stores votes and derives consensus at read time — and why this module
    // takes the rule as a parameter instead of owning one.
    const strict = buildAdjudicationReport(CANDIDATES, VOTES, unanimousOnly, CFG);
    expect(strict.scored).toBe(6); // h7's 2-1 panel no longer reaches a verdict
    expect(strict.excluded.find((e) => e.reason === "panel-split")?.count).toBe(2);
    expect(strict.aggregate.outcomes.harmShare).toEqual({ n: 1, d: 6, pct: 16.7 });
    expect(strict.aggregate.outcomes.net).toBe(2);
  });

  test("per-service-label support is single-digit throughout, so no share is quoted", () => {
    const byLabel = r.aggregate.byServiceLabel;
    expect(byLabel.map((b) => b.taskType)).toEqual(["code", "qa", "other"]);
    expect(byLabel.find((b) => b.taskType === "other")).toMatchObject({
      support: 3,
      corrections: 3,
      harms: 0,
      correctionShare: null,
    });
    expect(byLabel.find((b) => b.taskType === "code")).toMatchObject({
      support: 3,
      corrections: 0,
      harms: 2,
      net: -2,
    });
  });
});

describe("renderAdjudicationReport", () => {
  const text = renderAdjudicationReport(
    buildAdjudicationReport(CANDIDATES, VOTES, simpleMajority, CFG),
  );

  test("prints both segments beside the aggregate — a blended figure never stands alone", () => {
    expect(text).toContain("aggregate");
    expect(text).toContain("before the boundary");
    expect(text).toContain("after the boundary");
  });

  test("carries the correlation's error rate with the numbers, not alongside them", () => {
    expect(text).toContain("HEURISTIC");
    expect(text).toContain("corroborat");
  });

  test("states that reference labels were read from cache, so no panel was re-invoked", () => {
    expect(text.toLowerCase()).toContain("cache");
  });

  test("marks single-digit support unreportable instead of printing a percentage", () => {
    expect(text).toContain("unreportable");
  });

  test("never prints a prompt hash — counts and denominators only", () => {
    for (const c of CANDIDATES) expect(text).not.toContain(c.promptHash);
  });
});
