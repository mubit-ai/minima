import { describe, expect, test } from "bun:test";
import type { UserPromptRow } from "../src/db/minima_db.ts";
import { STEP_CAP_WRAP_PREFIX } from "../src/minima/anti_spiral.ts";
import { rate } from "../src/minima/classifier_eval.ts";
import {
  type CachedVote,
  type ModelReplay,
  type ReferenceVerdict,
  type ScoredEntry,
  accuracyOf,
  buildReplayScoreReport,
  bySegment,
  catchAllOf,
  compareModels,
  deriveFloor,
  floorCandidates,
  formatSupportedCompact,
  reliabilityCurve,
  renderReplayScoreReport,
  resolveReferenceVerdicts,
  scoreReplay,
  segmentCorpus,
  supported,
  taskTypeBreakdown,
} from "../src/minima/classifier_eval_score.ts";
import { CLASSIFY_CONFIDENCE_FLOOR } from "../src/minima/classify.ts";
import type { TaskType } from "../src/minima/schemas.ts";

// MUB-218 — the classifier replay's pure scoring half. Nothing here opens a database, calls a
// model or spends: the reference labels arrive as vote rows and the consensus rule arrives as an
// injected function, exactly as they will when MUB-216's cache lands.

/** A user-prompt row. Lead agent, run `r1`, unless overridden. */
function ev(ts: number, text: string | null, over: Partial<UserPromptRow> = {}): UserPromptRow {
  return { id: `e${ts}`, run_id: "r1", ts, agent_id: null, text, ...over };
}

/** A richer vote than the module reads, to pin that the generic accepts MUB-216's real row. */
interface TestVote extends CachedVote {
  readonly modelId: string;
  readonly taskType: TaskType;
}

const CORPUS_REV = 3;

function vote(promptHash: string, modelId: string, taskType: TaskType, rev = CORPUS_REV): TestVote {
  return { promptHash, corpusRev: rev, modelId, taskType };
}

/** Readable stand-in for sha256 — the real one is injected, so this only has to be a function. */
const hashOf = (text: string): string => `h:${text}`;

/** The regime boundary every fixture here is segmented at. */
const BOUNDARY = 100;

function verdict(taskType: TaskType, votesFor: number, votesTotal: number): ReferenceVerdict {
  return { taskType, votesFor, votesTotal };
}

/**
 * A stub consensus: a LOOKUP keyed on the hash, deliberately NOT a quorum rule. MUB-216 owns the
 * one read-time consensus function (ADR 0001), and a plausible-looking stand-in here — even in a
 * test — is precisely the second quorum rule that ADR exists to prevent.
 */
function lookupConsensus(
  table: Readonly<Record<string, ReferenceVerdict | null>>,
): (votes: readonly TestVote[]) => ReferenceVerdict | null {
  return (votes) => (votes.length === 0 ? null : (table[votes[0]?.promptHash ?? ""] ?? null));
}

describe("resolveReferenceVerdicts — the cache join", () => {
  const entries = ["alpha", "beta"];

  test("joins an entry to its votes by hash and hands the whole panel to the consensus function", () => {
    // The seam takes votes, never a stored verdict: a unanimous panel and a 2-1 split must still
    // be distinguishable downstream, which is only true if every vote reaches the rule.
    let seen: readonly TestVote[] = [];
    const votes = [
      vote("h:alpha", "m1", "code"),
      vote("h:alpha", "m2", "code"),
      vote("h:alpha", "m3", "qa"),
    ];
    const res = resolveReferenceVerdicts(["alpha"], votes, {
      corpusRev: CORPUS_REV,
      hashOf,
      consensus: (v) => {
        seen = v;
        return verdict("code", 2, 3);
      },
    });
    expect(seen.map((v) => v.modelId)).toEqual(["m1", "m2", "m3"]);
    expect(res.verdicts.get("alpha")).toEqual(verdict("code", 2, 3));
    expect(res.entriesResolved).toBe(1);
  });

  test("treats votes at another corpus_rev as ABSENT, not as stale-but-usable", () => {
    // ADR 0001: a corpus redefinition is a cache miss. A vote from rev 2 describes a corpus this
    // one is not, so admitting it would attribute a label to a prompt set that no longer exists.
    const votes = [vote("h:alpha", "m1", "code", 2), vote("h:beta", "m1", "qa", CORPUS_REV)];
    const res = resolveReferenceVerdicts(entries, votes, {
      corpusRev: CORPUS_REV,
      hashOf,
      consensus: lookupConsensus({ "h:beta": verdict("qa", 3, 3) }),
    });
    expect(res.verdicts.has("alpha")).toBe(false);
    expect(res.votesAtOtherRev).toBe(1);
    expect(res.entriesUnvoted).toBe(1);
    expect(res.entriesResolved).toBe(1);
  });

  test("counts votes whose prompt has left the corpus, and never resurrects text from them", () => {
    // The hash is one-way, so a label whose prompt is gone is unreadable — countable, not usable.
    const res = resolveReferenceVerdicts(["alpha"], [vote("h:departed", "m1", "code")], {
      corpusRev: CORPUS_REV,
      hashOf,
      consensus: lookupConsensus({ "h:departed": verdict("code", 3, 3) }),
    });
    expect(res.votesWithoutCorpusEntry).toBe(1);
    expect(res.verdicts.size).toBe(0);
    expect(res.entriesUnvoted).toBe(1);
  });

  test("separates a panel that could not agree from a prompt the panel never saw", () => {
    // "No verdict" and "no votes" are different claims: one is a panel that deadlocked, the other
    // is a gap in the cache. Adding them up would report an unlabelled corpus as a split panel.
    const votes = [vote("h:alpha", "m1", "code"), vote("h:alpha", "m2", "qa")];
    const res = resolveReferenceVerdicts(entries, votes, {
      corpusRev: CORPUS_REV,
      hashOf,
      consensus: lookupConsensus({ "h:alpha": null }),
    });
    expect(res.entriesUnresolved).toBe(1);
    expect(res.entriesUnvoted).toBe(1);
    expect(res.entriesResolved).toBe(0);
  });

  test("every entry lands in exactly one of resolved, unvoted and unresolved", () => {
    const votes = [vote("h:alpha", "m1", "code"), vote("h:beta", "m1", "qa")];
    const res = resolveReferenceVerdicts(["alpha", "beta", "gamma"], votes, {
      corpusRev: CORPUS_REV,
      hashOf,
      consensus: lookupConsensus({ "h:alpha": verdict("code", 3, 3), "h:beta": null }),
    });
    expect(res.entriesResolved + res.entriesUnvoted + res.entriesUnresolved).toBe(3);
    expect([res.entriesResolved, res.entriesUnvoted, res.entriesUnresolved]).toEqual([1, 1, 1]);
  });
});

describe("segmentCorpus — the regime boundary", () => {
  test("assigns an entry asked only before the boundary to the earlier regime", () => {
    const [entry] = segmentCorpus([ev(10, "early"), ev(20, "early")], BOUNDARY);
    expect(entry?.segment).toBe("before");
    expect(entry?.occurrences).toBe(2);
    expect(entry?.firstTs).toBe(10);
    expect(entry?.lastTs).toBe(20);
  });

  test("puts a prompt asked exactly at the boundary in the later regime", () => {
    // The boundary is the instant the new regime began, so it belongs to what it began.
    const [entry] = segmentCorpus([ev(BOUNDARY, "on the line")], BOUNDARY);
    expect(entry?.segment).toBe("after");
  });

  test("marks a prompt asked on both sides as spanning, rather than picking an era for it", () => {
    // Distinctness is on exact text, so one entry really can straddle the boundary. Attributing it
    // to either era would credit one regime with traffic from both.
    const [entry] = segmentCorpus([ev(10, "recurring"), ev(200, "recurring")], BOUNDARY);
    expect(entry?.segment).toBe("spanning");
    expect(entry?.occurrences).toBe(2);
  });

  test("the three segments partition the corpus", () => {
    const rows = [ev(10, "a"), ev(150, "b"), ev(20, "c"), ev(160, "c"), ev(30, "a")];
    const entries = segmentCorpus(rows, BOUNDARY);
    expect(entries).toHaveLength(3);
    const counts = { before: 0, after: 0, spanning: 0 };
    for (const e of entries) counts[e.segment] += 1;
    expect(counts).toEqual({ before: 1, after: 1, spanning: 1 });
  });

  test("delegates exclusion to the shared partitions — steer text and sub-agent rows are not corpus", () => {
    const rows = [
      ev(10, "a real ask"),
      ev(20, `${STEP_CAP_WRAP_PREFIX} 40 of 50 steps`, { id: "steer" }),
      ev(30, "a sub-agent brief", { agent_id: "sub-1" }),
      ev(40, "   "),
    ];
    expect(segmentCorpus(rows, BOUNDARY).map((e) => e.text)).toEqual(["a real ask"]);
  });
});

// ---------------------------------------------------------------------------
// The scored fixture. Every aggregation below reads THIS, produced by the real `scoreReplay` over
// a corpus, a replay and verdicts — never by hand-written outcomes, which would let an aggregation
// agree with a fixture that agrees with nothing. The expected counts are worked out once here:
//
//   #   segment   emitted  conf   reference  unanimous   outcome
//   p1  before    code     0.95   code       yes         correct
//   p2  before    code     0.90   code       yes         correct
//   p3  before    qa       0.85   qa         no (2/3)    correct
//   p4  before    other    0.80   code       yes         incorrect
//   p5  before    code     0.70   qa         yes         incorrect
//   p6  before    —        —      code       yes         abstained
//   p13 spanning  code     0.95   code       yes         correct
//   p7  after     code     0.95   code       yes         correct
//   p8  after     other    0.90   other      yes         correct
//   p9  after     other    0.85   other      no (2/3)    correct
//   p10 after     other    0.60   qa         yes         incorrect
//   p11 after     qa       0.55   qa         yes         correct
//   p12 after     code     0.50   —          —           unassessable
//   p14 after     (never replayed)  code     yes         unreplayed
//
//   scored (correct+incorrect) = 11 · correct = 8 · incorrect = 3
//   before 3/5 · after 4/5 · spanning 1/1 · whole 8/11
// ---------------------------------------------------------------------------

const ROWS: UserPromptRow[] = [
  ev(10, "p1"),
  ev(11, "p2"),
  ev(12, "p3"),
  ev(13, "p4"),
  ev(14, "p5"),
  ev(15, "p6"),
  ev(20, "p13"),
  ev(110, "p7"),
  ev(111, "p8"),
  ev(112, "p9"),
  ev(113, "p10"),
  ev(114, "p11"),
  ev(115, "p12"),
  ev(116, "p14"),
  ev(120, "p13"),
];

const CORPUS = segmentCorpus(ROWS, BOUNDARY);

/** text → [reference type, votesFor, votesTotal]. p12 has no verdict at all. */
const VERDICTS = new Map<string, ReferenceVerdict>([
  ["p1", verdict("code", 3, 3)],
  ["p2", verdict("code", 3, 3)],
  ["p3", verdict("qa", 2, 3)],
  ["p4", verdict("code", 3, 3)],
  ["p5", verdict("qa", 3, 3)],
  ["p6", verdict("code", 3, 3)],
  ["p7", verdict("code", 3, 3)],
  ["p8", verdict("other", 3, 3)],
  ["p9", verdict("other", 2, 3)],
  ["p10", verdict("qa", 3, 3)],
  ["p11", verdict("qa", 3, 3)],
  ["p13", verdict("code", 3, 3)],
  ["p14", verdict("code", 3, 3)],
]);

function label(text: string, taskType: TaskType, confidence: number) {
  return { text, classification: { taskType, difficulty: "medium" as const, confidence } };
}

const REPLAY: ModelReplay = {
  modelId: "default",
  labels: [
    label("p1", "code", 0.95),
    label("p2", "code", 0.9),
    label("p3", "qa", 0.85),
    label("p4", "other", 0.8),
    label("p5", "code", 0.7),
    { text: "p6", classification: null },
    label("p13", "code", 0.95),
    label("p7", "code", 0.95),
    label("p8", "other", 0.9),
    label("p9", "other", 0.85),
    label("p10", "other", 0.6),
    label("p11", "qa", 0.55),
    label("p12", "code", 0.5),
  ],
};

const SCORED = scoreReplay(REPLAY, CORPUS, VERDICTS);

function outcomeOf(entries: readonly ScoredEntry[], text: string): string | undefined {
  return entries.find((e) => e.text === text)?.outcome;
}

describe("scoreReplay", () => {
  test("scores an agreement as correct and a disagreement as incorrect", () => {
    expect(outcomeOf(SCORED, "p1")).toBe("correct");
    expect(outcomeOf(SCORED, "p5")).toBe("incorrect");
  });

  test("a classifier that declined is an abstention, never a miss", () => {
    // classify() fails open — an unparseable reply, a timeout or a thrown provider error all mean
    // no label. Scoring that as a wrong answer would charge the classifier for not answering.
    expect(outcomeOf(SCORED, "p6")).toBe("abstained");
  });

  test("an entry with no reference verdict is unassessable, not incorrect", () => {
    // Same distinction MUB-225 draws for corroboration: nothing to compare is not a failed
    // comparison. It belongs in neither the numerator nor the denominator of accuracy.
    expect(outcomeOf(SCORED, "p12")).toBe("unassessable");
  });

  test("a corpus entry the replay never covered is unreplayed, not an abstention", () => {
    // An incomplete run and a fail-open classifier are different facts. Folding the first into the
    // second would let a truncated replay report itself as a high abstention rate.
    expect(outcomeOf(SCORED, "p14")).toBe("unreplayed");
  });

  test("is driven by the corpus, so every entry is accounted for exactly once", () => {
    expect(SCORED).toHaveLength(CORPUS.length);
    expect(SCORED).toHaveLength(14);
  });

  test("carries the segment, the self-reported confidence and the panel's agreement through", () => {
    const p9 = SCORED.find((e) => e.text === "p9");
    expect(p9?.segment).toBe("after");
    expect(p9?.confidence).toBe(0.85);
    expect(p9?.referenceUnanimous).toBe(false);
    expect(SCORED.find((e) => e.text === "p1")?.referenceUnanimous).toBe(true);
  });

  test("ignores a replay label for a prompt outside the corpus", () => {
    const stray: ModelReplay = { modelId: "m", labels: [label("not in corpus", "code", 0.9)] };
    expect(scoreReplay(stray, CORPUS, VERDICTS)).toHaveLength(14);
  });
});

describe("supported — single-digit denominators are not percentages", () => {
  test("suppresses a rate whose denominator is single-digit", () => {
    const s = supported(rate(7, 9));
    expect(s.reportable).toBe(false);
    expect(s.rate.pct).toBe(77.8);
  });

  test("reports at ten, the first two-digit denominator", () => {
    expect(supported(rate(7, 10)).reportable).toBe(true);
  });

  test("an empty denominator is never reportable", () => {
    expect(supported(rate(0, 0)).reportable).toBe(false);
  });
});

describe("accuracyOf", () => {
  test("scores over agreements and disagreements only", () => {
    // 8 correct of 11 scored — the abstention, the unassessable entry and the unreplayed one are
    // all outside the denominator, and each is reported over the whole corpus instead.
    const a = accuracyOf(SCORED);
    expect(a.correct.rate).toEqual({ n: 8, d: 11, pct: 72.7 });
    expect(a.correct.reportable).toBe(true);
    expect(a.entries).toBe(14);
    expect(a.abstained.rate).toEqual({ n: 1, d: 14, pct: 7.1 });
    expect(a.unassessable.rate).toEqual({ n: 1, d: 14, pct: 7.1 });
    expect(a.unreplayed.rate).toEqual({ n: 1, d: 14, pct: 7.1 });
  });

  test("reports the unanimous-panel subset separately, and suppresses it on thin support", () => {
    // Disagreeing with a unanimous panel is stronger evidence of a mistake than disagreeing with a
    // 2-1 split. p3 and p9 had split panels, so 9 of the 11 scored entries survive — single digit.
    const a = accuracyOf(SCORED);
    expect(a.correctUnanimousOnly.rate).toEqual({ n: 6, d: 9, pct: 66.7 });
    expect(a.correctUnanimousOnly.reportable).toBe(false);
  });
});

describe("bySegment", () => {
  test("splits every figure at the regime boundary and keeps the whole alongside", () => {
    const seg = bySegment(SCORED, accuracyOf);
    expect(seg.before.correct.rate).toEqual({ n: 3, d: 5, pct: 60 });
    expect(seg.after.correct.rate).toEqual({ n: 4, d: 5, pct: 80 });
    expect(seg.spanning.correct.rate).toEqual({ n: 1, d: 1, pct: 100 });
    expect(seg.whole.correct.rate).toEqual({ n: 8, d: 11, pct: 72.7 });
  });

  test("the segments sum to the whole", () => {
    const seg = bySegment(SCORED, (e) => e.length);
    expect(seg.before + seg.after + seg.spanning).toBe(seg.whole);
    expect(seg.whole).toBe(14);
  });

  test("every per-segment accuracy here is unreportable, which is the corpus's own limit", () => {
    const seg = bySegment(SCORED, accuracyOf);
    expect([seg.before, seg.after, seg.spanning].map((a) => a.correct.reportable)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("catchAllOf", () => {
  test("reports the classifier's catch-all emission beside the panel's own", () => {
    // The emission rate alone says nothing: if the panel itself calls a third of the corpus
    // uncategorisable, a classifier that does the same is right, not lazy.
    const c = catchAllOf(SCORED);
    expect(c.emission.rate).toEqual({ n: 4, d: 11, pct: 36.4 });
    expect(c.panelEmission.rate).toEqual({ n: 2, d: 11, pct: 18.2 });
  });

  test("reports how often the panel agreed catch-all was the right answer", () => {
    const c = catchAllOf(SCORED);
    expect(c.panelAgrees.rate).toEqual({ n: 2, d: 4, pct: 50 });
    expect(c.panelAgrees.reportable).toBe(false);
  });
});

describe("taskTypeBreakdown", () => {
  test("reports recall and precision per type, over the type's own denominator", () => {
    const rows = taskTypeBreakdown(SCORED);
    const byType = new Map(rows.map((r) => [r.taskType, r]));
    expect(byType.get("code")?.recall.rate).toEqual({ n: 4, d: 5, pct: 80 });
    expect(byType.get("code")?.precision.rate).toEqual({ n: 4, d: 5, pct: 80 });
    expect(byType.get("qa")?.recall.rate).toEqual({ n: 2, d: 4, pct: 50 });
    expect(byType.get("qa")?.precision.rate).toEqual({ n: 2, d: 2, pct: 100 });
    expect(byType.get("other")?.recall.rate).toEqual({ n: 2, d: 2, pct: 100 });
    expect(byType.get("other")?.precision.rate).toEqual({ n: 2, d: 4, pct: 50 });
  });

  test("flags every single-digit type as unreportable rather than showing a percentage", () => {
    // On a few hundred prompts of one developer's traffic this is the expected reading for most
    // types, and it is the finding — not a formatting detail.
    const rows = taskTypeBreakdown(SCORED);
    expect(rows.every((r) => !r.recall.reportable && !r.precision.reportable)).toBe(true);
  });

  test("omits types no one used, and keeps the schema's order", () => {
    expect(taskTypeBreakdown(SCORED).map((r) => r.taskType)).toEqual(["code", "qa", "other"]);
  });
});

// ---------------------------------------------------------------------------
// The reliability curve and the floor. Worked out by hand from SCORED's eleven scored entries,
// which carry these confidences (C = correct, I = incorrect):
//
//   0.55 C · 0.60 I · 0.70 I · 0.80 I · 0.85 C · 0.85 C · 0.90 C · 0.90 C · 0.95 C · 0.95 C · 0.95 C
//
//   bins  [0.6,0.7,0.75,0.8,0.9]:  <0.60 1/1 · 0.60 0/1 · 0.70 0/1 · 0.75 0/0 · 0.80 2/3 · 0.90 5/5
//   tails                          >=0.60 7/10 · >=0.70 7/9 · >=0.75 7/8 · >=0.80 7/8 · >=0.90 5/5
// ---------------------------------------------------------------------------

const BINS = [0.6, 0.7, 0.75, 0.8, 0.9];

describe("reliabilityCurve", () => {
  test("relates the self-reported number to observed correctness, bin by bin", () => {
    const curve = reliabilityCurve(SCORED, BINS);
    expect(curve.map((b) => `${b.label} ${b.correct.rate.n}/${b.correct.rate.d}`)).toEqual([
      "<0.60 1/1",
      "0.60-<0.70 0/1",
      "0.70-<0.75 0/1",
      "0.75-<0.80 0/0",
      "0.80-<0.90 2/3",
      ">=0.90 5/5",
    ]);
  });

  test("the bins partition the scored entries", () => {
    const curve = reliabilityCurve(SCORED, BINS);
    expect(curve.reduce((n, b) => n + b.correct.rate.d, 0)).toBe(11);
    expect(curve.reduce((n, b) => n + b.correct.rate.n, 0)).toBe(8);
  });

  test("cuts a bin at the floor in force, so the baseline is an edge and never splits a bin", () => {
    expect(reliabilityCurve(SCORED, BINS).map((b) => b.minConfidence)).toContain(
      CLASSIFY_CONFIDENCE_FLOOR,
    );
  });

  test("every bin here is unreportable — a per-bin percentage is what this corpus cannot support", () => {
    expect(reliabilityCurve(SCORED, BINS).every((b) => !b.correct.reportable)).toBe(true);
  });
});

describe("floorCandidates — the tail, which is what a floor actually selects on", () => {
  test("reports correctness of everything at or above each threshold, with its coverage", () => {
    // A per-bin rate answers "how good are labels near 0.8"; a floor asks "how good is everything
    // I would let through at 0.8". Only the second is the question, so only the second is derived on.
    const tails = floorCandidates(SCORED, BINS);
    expect(tails.map((c) => `${c.threshold} ${c.correct.rate.n}/${c.correct.rate.d}`)).toEqual([
      "0.6 7/10",
      "0.7 7/9",
      "0.75 7/8",
      "0.8 7/8",
      "0.9 5/5",
    ]);
    expect(tails[0]?.coverage.rate).toEqual({ n: 10, d: 11, pct: 90.9 });
    expect(tails[4]?.coverage.rate).toEqual({ n: 5, d: 11, pct: 45.5 });
  });
});

describe("deriveFloor", () => {
  const base = { thresholds: BINS, baseline: CLASSIFY_CONFIDENCE_FLOOR };

  test("takes the LOWEST threshold that clears the target — coverage is a cost, not a free win", () => {
    // >=0.70 is the first tail at or above 75%. Anything higher discards overrides that were right.
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.75, minSupport: 5 });
    expect(d.kind).toBe("derived");
    if (d.kind !== "derived") return;
    expect(d.chosen.threshold).toBe(0.7);
    expect(d.argument.direction).toBe("lower");
  });

  test("argues against the baseline in both directions, and the counts are symmetric", () => {
    // Lowering to 0.70 admits the [0.70, 0.75) band the baseline drops: one entry, and it is wrong.
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.75, minSupport: 5 });
    if (d.kind !== "derived") throw new Error("expected a derived floor");
    expect(d.argument).toEqual({
      direction: "lower",
      admittedCorrect: 0,
      admittedIncorrect: 1,
      droppedCorrect: 0,
      droppedIncorrect: 0,
    });
  });

  test("names what a higher floor costs, not only what it buys", () => {
    // Raising to 0.90 drops the [0.75, 0.90) band: two right answers thrown away to avoid one wrong
    // one. A floor quoted without that trade reads as free.
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.95, minSupport: 5 });
    if (d.kind !== "derived") throw new Error("expected a derived floor");
    expect(d.chosen.threshold).toBe(0.9);
    expect(d.argument).toEqual({
      direction: "higher",
      admittedCorrect: 0,
      admittedIncorrect: 0,
      droppedCorrect: 2,
      droppedIncorrect: 1,
    });
  });

  test("reports an unchanged floor as a result, not as a failure to find one", () => {
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.85, minSupport: 5 });
    if (d.kind !== "derived") throw new Error("expected a derived floor");
    expect(d.chosen.threshold).toBe(CLASSIFY_CONFIDENCE_FLOOR);
    expect(d.argument.direction).toBe("unchanged");
  });

  test("refuses when no supported tail reaches the target, instead of manufacturing the top one", () => {
    // At the real support bar only >=0.60 has a two-digit denominator, and it sits at 70%. The
    // honest answer is that this corpus cannot justify a floor — NOT that the floor is 0.90.
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.85 });
    expect(d.kind).toBe("underdetermined");
    if (d.kind !== "underdetermined") return;
    expect(d.reason).toBe("target-unreachable");
  });

  test("separates a corpus too thin to quote from one that answers the question and says no", () => {
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.5, minSupport: 20 });
    if (d.kind !== "underdetermined") throw new Error("expected a refusal");
    expect(d.reason).toBe("insufficient-support");
  });

  test("refuses on an empty population without dividing by zero", () => {
    const d = deriveFloor([], { ...base, targetCorrectness: 0.5, minSupport: 1 });
    if (d.kind !== "underdetermined") throw new Error("expected a refusal");
    expect(d.reason).toBe("no-observations");
  });

  test("carries the baseline's own tail whichever way it goes, so 0.75 is always argued against", () => {
    const derived = deriveFloor(SCORED, { ...base, targetCorrectness: 0.75, minSupport: 5 });
    const refused = deriveFloor(SCORED, { ...base, targetCorrectness: 0.85 });
    expect(derived.baseline.threshold).toBe(0.75);
    expect(derived.baseline.correct.rate).toEqual({ n: 7, d: 8, pct: 87.5 });
    expect(refused.baseline.correct.rate).toEqual({ n: 7, d: 8, pct: 87.5 });
  });

  test("selects on the exact ratio, never on the rounded percentage", () => {
    // 7/9 rounds to 77.8%, which would clear a 0.778 target read off the printed figure. The exact
    // ratio is 0.7777…, which does not. Selecting on the rounded number would admit a tail that
    // misses the target by a hair and call it derived.
    const d = deriveFloor(SCORED, { ...base, targetCorrectness: 0.778, minSupport: 5 });
    if (d.kind !== "derived") throw new Error("expected a derived floor");
    expect(d.chosen.threshold).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// The second classifier model. Differs from A on p1 (wrong where A is right), p5 (right where A is
// wrong), p6 (answers where A abstained), p10 (abstains where A answered) and p14 (replayed at all).
//
//   paired = 10 · both correct 7 · only A 1 · only B 1 · both wrong 1
//   A 8/10 and B 8/10 — an identical rate over ten entries they disagree on twice.
// ---------------------------------------------------------------------------

const REPLAY_B: ModelReplay = {
  modelId: "cheap",
  labels: [
    label("p1", "qa", 0.9),
    label("p2", "code", 0.9),
    label("p3", "qa", 0.85),
    label("p4", "other", 0.8),
    label("p5", "qa", 0.7),
    label("p6", "code", 0.8),
    label("p13", "code", 0.95),
    label("p7", "code", 0.95),
    label("p8", "other", 0.9),
    label("p9", "other", 0.85),
    { text: "p10", classification: null },
    label("p11", "qa", 0.55),
    label("p12", "code", 0.5),
    label("p14", "code", 0.9),
  ],
};

const SCORED_B = scoreReplay(REPLAY_B, CORPUS, VERDICTS);

describe("compareModels — the model-switch cost", () => {
  const A = { modelId: "default", entries: SCORED } as const;
  const B = { modelId: "cheap", entries: SCORED_B } as const;

  test("compares only entries BOTH models scored", () => {
    // A scored 11 and B scored 12, but on different sets. Subtracting two rates over two different
    // denominators would report a difference that is partly just a difference in coverage.
    const c = compareModels(A, B);
    expect(c.paired).toBe(10);
    expect(c.correctA.rate).toEqual({ n: 8, d: 10, pct: 80 });
    expect(c.correctB.rate).toEqual({ n: 8, d: 10, pct: 80 });
  });

  test("reports the disagreement matrix, because an identical rate is not identical behaviour", () => {
    // Both models are 80% and they disagree on two of ten. A delta of zero would say they are
    // interchangeable; the 2x2 says they are not.
    const c = compareModels(A, B);
    expect(c.deltaPoints).toBe(0);
    expect([c.bothCorrect, c.onlyACorrect, c.onlyBCorrect, c.bothIncorrect]).toEqual([7, 1, 1, 1]);
  });

  test("counts what the pairing set aside, split by which side lost it", () => {
    const c = compareModels(A, B);
    expect(c.unpairedOnlyA).toBe(1);
    expect(c.unpairedOnlyB).toBe(2);
    expect(c.unpairedNeither).toBe(1);
    expect(c.paired + c.unpairedOnlyA + c.unpairedOnlyB + c.unpairedNeither).toBe(14);
  });

  test("the delta is exactly the asymmetry of the disagreement", () => {
    const c = compareModels(A, B);
    expect(c.deltaPoints).toBe(
      Math.round(((c.onlyACorrect - c.onlyBCorrect) / c.paired) * 1000) / 10,
    );
  });

  test("is null, not zero, when the two models share no scored entry", () => {
    const c = compareModels(A, { modelId: "empty", entries: [] });
    expect(c.paired).toBe(0);
    expect(c.deltaPoints).toBeNull();
    expect(c.correctA.reportable).toBe(false);
  });
});

/** Shared report inputs. Hoisted: three describe blocks used to restate these verbatim. */
const REPORT_CFG = {
  scope: "fixture",
  regimeBoundaryTs: BOUNDARY,
  confidenceBoundaries: BINS,
  floor: { targetCorrectness: 0.85, thresholds: BINS, baseline: CLASSIFY_CONFIDENCE_FLOOR },
};

const REPORT_REFERENCE = {
  verdicts: VERDICTS,
  entriesResolved: 13,
  entriesUnvoted: 1,
  entriesUnresolved: 0,
  votesAtOtherRev: 0,
  votesWithoutCorpusEntry: 0,
};

describe("buildReplayScoreReport", () => {
  const REPORT = buildReplayScoreReport(
    [
      { modelId: "default", entries: SCORED },
      { modelId: "cheap", entries: SCORED_B },
    ],
    REPORT_REFERENCE,
    REPORT_CFG,
  );

  test("segments every model's headline accuracy, and keeps the whole alongside", () => {
    const a = REPORT.models[0]?.accuracy;
    expect(a?.before.correct.rate.n).toBe(3);
    expect(a?.after.correct.rate.n).toBe(4);
    expect(a?.spanning.correct.rate.n).toBe(1);
    expect(a?.whole.correct.rate).toEqual({ n: 8, d: 11, pct: 72.7 });
  });

  test("compares every pair of models exactly once", () => {
    expect(REPORT.comparisons).toHaveLength(1);
    expect(REPORT.comparisons[0]?.whole.paired).toBe(10);
  });

  test("counts the corpus per segment", () => {
    expect(REPORT.corpusEntries).toEqual({ before: 6, after: 7, spanning: 1, whole: 14 });
  });

  test("makes no comparison from a single model, rather than comparing it with itself", () => {
    const solo = buildReplayScoreReport(
      [{ modelId: "only", entries: SCORED }],
      REPORT_REFERENCE,
      REPORT_CFG,
    );
    expect(solo.comparisons).toHaveLength(0);
  });

  test("renders both segments beside every whole-corpus figure", () => {
    const out = renderReplayScoreReport(REPORT);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("spanning");
  });

  test("renders no prompt text — the corpus is one developer's own traffic", () => {
    const rows = [ev(10, "SENTINEL-PROMPT-TEXT"), ev(150, "ANOTHER-SENTINEL")];
    const corpus = segmentCorpus(rows, BOUNDARY);
    const replay: ModelReplay = {
      modelId: "m",
      labels: [label("SENTINEL-PROMPT-TEXT", "code", 1)],
    };
    const out = renderReplayScoreReport(
      buildReplayScoreReport(
        [{ modelId: "m", entries: scoreReplay(replay, corpus, new Map()) }],
        REPORT_REFERENCE,
        REPORT_CFG,
      ),
    );
    expect(out).not.toContain("SENTINEL");
  });

  test("never prints a percentage for a single-digit denominator, anywhere in the readout", () => {
    // Scanned, not spot-checked. The first version of this test asserted against denominator 9
    // alone and passed while the readout printed seventy-two percentages over denominators 1-8:
    // an assertion narrower than its own claim is how a guarantee ends up vouching for nothing.
    const out = renderReplayScoreReport(REPORT);
    const offenders: string[] = [];
    for (const line of out.split("\n")) {
      for (const [, n, d] of line.matchAll(/(\d+)\/(\d+) \(\d/g)) {
        if (Number(d) < 10) offenders.push(`${n}/${d} in: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(out).toContain("†");
  });

  test("states the floor in force, so the derivation is always read against it", () => {
    expect(renderReplayScoreReport(REPORT)).toContain("0.75");
  });
});

describe("renderReplayScoreReport — the readout's own honesty", () => {
  test("keeps a long model id out of the first column instead of running into it", () => {
    // A label that overflows its column produces `…correctbefore 3/5` — a misread number, not just
    // an ugly line. The label is cut to fit; the figure is never the thing that gives way.
    const long = "a-very-long-provider-prefixed-model-identifier";
    const out = renderReplayScoreReport(
      buildReplayScoreReport(
        [
          { modelId: long, entries: SCORED },
          { modelId: "cheap", entries: SCORED_B },
        ],
        REPORT_REFERENCE,
        REPORT_CFG,
      ),
    );
    for (const line of out.split("\n")) {
      if (line.includes("before ")) expect(line).toMatch(/\s+before /);
    }
  });

  test("renders an empty denominator as a dash, never as a zero out of zero", () => {
    // `0/0` reads as "the classifier got none of them right" when it means "there were none".
    expect(formatSupportedCompact(supported(rate(0, 0)))).toBe("—");
    expect(formatSupportedCompact(supported(rate(0, 12)))).toBe("0/12 (0.0%)");
  });

  test("quotes the floor in force even when no floor could be derived", () => {
    // "No floor was derived" is a fact about the search, not about the baseline — which WAS
    // measured, and is the one figure that bears on what production is running today.
    const report = buildReplayScoreReport(
      [{ modelId: "m", entries: SCORED }],
      REPORT_REFERENCE,
      REPORT_CFG,
    );
    const out = renderReplayScoreReport(report);
    expect(report.models[0]?.floor.whole.kind).toBe("underdetermined");
    expect(out).toContain("no floor was derived (target-unreachable); the 0.75 in force admits");
  });
});

describe("edges the report has to survive", () => {
  test("counts a scored entry B has and A's corpus does not", () => {
    // Both replays are corpus-driven so this should be impossible, which is exactly why it is
    // counted rather than assumed: a hand-built pair of replays would otherwise lose the entry
    // silently, and the pairing would report a smaller corpus than it was given.
    const a = { modelId: "a", entries: SCORED };
    const b = {
      modelId: "b",
      entries: [
        ...SCORED_B,
        {
          text: "not in A's corpus",
          segment: "after" as const,
          outcome: "correct" as const,
          emitted: "code" as const,
          confidence: 0.9,
          reference: "code" as const,
          referenceUnanimous: true,
        },
      ],
    };
    expect(compareModels(a, b).unpairedOnlyB).toBe(3);
    expect(compareModels(a, b).paired).toBe(10);
  });

  test("builds and renders a report with no replays at all", () => {
    const empty = buildReplayScoreReport(
      [],
      {
        verdicts: new Map(),
        entriesResolved: 0,
        entriesUnvoted: 0,
        entriesUnresolved: 0,
        votesAtOtherRev: 0,
        votesWithoutCorpusEntry: 0,
      },
      {
        scope: "empty",
        regimeBoundaryTs: BOUNDARY,
        confidenceBoundaries: BINS,
        floor: { targetCorrectness: 0.85, thresholds: BINS, baseline: CLASSIFY_CONFIDENCE_FLOOR },
      },
    );
    expect(empty.corpusEntries).toEqual({ before: 0, after: 0, spanning: 0, whole: 0 });
    expect(empty.comparisons).toHaveLength(0);
    expect(renderReplayScoreReport(empty)).toContain("scope: empty");
  });

  test("scores an empty corpus without dividing by zero anywhere", () => {
    const a = accuracyOf([]);
    expect(a.correct.rate).toEqual({ n: 0, d: 0, pct: null });
    expect(a.abstained.rate.pct).toBeNull();
    expect(catchAllOf([]).emission.rate.pct).toBeNull();
    expect(taskTypeBreakdown([])).toHaveLength(0);
  });
});

describe("the floor argument is segmented too", () => {
  test("renders the derived floor's trade against the baseline per segment, not only whole-corpus", () => {
    // "Argued explicitly against the current 0.75" and "a whole-corpus figure never stands alone"
    // are the same requirement here: a floor that improves on the whole corpus while regressing
    // inside one regime is exactly the reading a whole-corpus-only argument would hide.
    const out = renderReplayScoreReport(
      buildReplayScoreReport([{ modelId: "m", entries: SCORED }], REPORT_REFERENCE, {
        ...REPORT_CFG,
        floor: { targetCorrectness: 0.75, thresholds: BINS, baseline: 0.9, minSupport: 5 },
      }),
    );
    const row = out.split("\n").find((l) => l.includes("vs the floor in force"));
    expect(row).toBeDefined();
    // Derived 0.70 against a 0.9 baseline is LOWER; over the whole corpus the [0.70, 0.90) band
    // holds 0.70(wrong), 0.80(wrong), 0.85(right), 0.85(right) — +2 right, +2 wrong.
    expect(row).toContain("whole lower +2R/+2W");
    expect(row).toContain("before ");
    expect(row).toContain("after ");
  });

  test("shows a dash for a segment where no floor could be derived, not a fabricated trade", () => {
    const out = renderReplayScoreReport(
      buildReplayScoreReport([{ modelId: "m", entries: SCORED }], REPORT_REFERENCE, REPORT_CFG),
    );
    const row = out.split("\n").find((l) => l.includes("vs the floor in force"));
    expect(row).toContain("spanning —");
  });
});
