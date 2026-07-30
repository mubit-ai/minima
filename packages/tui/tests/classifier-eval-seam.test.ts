import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { CORPUS_REV } from "../src/minima/classifier_eval.ts";
import {
  MIN_REPORTABLE_SUPPORT as ADJUDICATE_MIN_SUPPORT,
  type AdjudicationConfig,
  type ConsensusFn,
  type OverrideCandidate,
  buildAdjudicationReport,
  deriveFloor as deriveFloorFromSweep,
  scoreCandidates,
} from "../src/minima/classifier_eval_adjudicate.ts";
import {
  type ReferenceLookup,
  MIN_REPORTABLE_SUPPORT as SCORE_MIN_SUPPORT,
  deriveFloor as deriveFloorFromCurve,
  resolveReferenceVerdicts,
} from "../src/minima/classifier_eval_score.ts";
import { buildOverrideCandidates } from "../src/minima/classifier_eval_wiring.ts";
import {
  type CachedPanelVote,
  REFERENCE_PANEL,
  consensusRuleFor,
  promptHash,
  toCachedVotes,
} from "../src/minima/consensus_panel.ts";
import type { TaskType } from "../src/minima/schemas.ts";

// The seam MUB-216, MUB-218 and MUB-226 meet on. No lane could write this test: each was forbidden
// from importing the others' files, so three modules independently declared vote rows, verdicts and
// corpus revisions that had never been type-checked against each other.
//
// What is pinned here is the ONE thing a unit test inside any single module cannot pin: that the
// rule MUB-216 ships is directly assignable to both consumers' seams — no adapter, no mapping, no
// `as`. A mapping is the only place an arm of the verdict can be dropped, and dropping `incomplete`
// into `split` reports a panel's coverage gap as a disagreement rate.
//
// Nothing here spends. Votes are written to an in-memory ledger by hand.

const PANEL_IDS = REFERENCE_PANEL.map((p) => p.model.id);

/** The shipped rule, panel bound. Both consumers below take THIS value, not a stand-in. */
const RULE = consensusRuleFor(REFERENCE_PANEL);

/** A ledger-shaped vote row, as `listConsensusVotes` returns it. */
function stored(hash: string, modelId: string, taskType: string | null, rev = CORPUS_REV) {
  return { prompt_hash: hash, model_id: modelId, corpus_rev: rev, task_type: taskType };
}

/** One prompt's worth of ledger rows: one per panelist, in panel order. */
function panelRows(hash: string, labels: readonly (string | null)[]) {
  return labels.map((label, i) => stored(hash, PANEL_IDS[i] as string, label));
}

describe("buildOverrideCandidates — the join MUB-225's output makes possible", () => {
  const prompt = (id: string, ts: number, text: string | null, agentId: string | null = null) => ({
    id,
    run_id: "r1",
    ts,
    agent_id: agentId,
    text,
  });
  const decision = (recId: string, ts: number, over: Record<string, unknown> = {}) => ({
    rec_id: recId,
    run_id: "r1",
    ts,
    agent_id: null,
    task_label: "fix the parser",
    routed: "server",
    task_type: "other",
    client_task_type: null,
    client_confidence: null,
    heuristic_task_type: null,
    classify_disagreement: null,
    ...over,
  });
  const hashOf = (text: string) => `h:${text}`;

  test("groups a prompt's whole recovery ladder under one candidate, in rung order", () => {
    // Three rungs of one prompt are ONE observation of the classifier (MUB-225), and the first is
    // the initial route — the label an override would actually have replaced.
    const candidates = buildOverrideCandidates({
      decisions: [
        decision("d1", 20, { task_type: "other" }),
        decision("d2", 21, { task_type: "code" }),
        decision("d3", 22, { task_type: "code" }),
      ],
      prompts: [prompt("e1", 10, "fix the parser")],
      replay: new Map([["fix the parser", { taskType: "code" as TaskType, confidence: 0.9 }]]),
      hashOf,
      overrideFloor: 0.75,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.promptHash).toBe("h:fix the parser");
    expect(candidates[0]?.decisions.map((d) => [d.ts, d.serviceLabel])).toEqual([
      [20, "other"],
      [21, "code"],
      [22, "code"],
    ]);
    expect(candidates[0]).toMatchObject({ harnessLabel: "code", harnessSelfReport: 0.9 });
  });

  test("a decision whose caller override won is marked, using the floor it was gated on", () => {
    // The floor is the COMPARISON, mirrored from `runtime.ts`, not a number copied from it: a
    // client label below the floor never overrode, so the recorded label is still the service's.
    const [entry] = buildOverrideCandidates({
      decisions: [
        decision("d1", 20, { client_task_type: "code", client_confidence: 0.8 }),
        decision("d2", 21, { client_task_type: "code", client_confidence: 0.5 }),
      ],
      prompts: [prompt("e1", 10, "fix the parser")],
      replay: new Map(),
      hashOf,
      overrideFloor: 0.75,
    });
    expect(entry?.decisions.map((d) => d.serviceLabelOverridden)).toEqual([true, false]);
  });

  test("only corpus prompts become candidates — steer text and sub-agent briefs do not", () => {
    // A decision the rule paired to harness steer text is not an observation of the corpus, and
    // folding it in would attribute it to a prompt it did not come from.
    const candidates = buildOverrideCandidates({
      decisions: [decision("d1", 20), decision("d2", 40), decision("d3", 60)],
      prompts: [
        prompt("e1", 10, "⚠ You have used 40 of 50 steps"),
        prompt("e2", 30, "a sub-agent brief", "child-1"),
        prompt("e3", 50, "fix the parser"),
      ],
      replay: new Map(),
      hashOf,
      overrideFloor: 0.75,
    });
    expect(candidates.map((c) => c.promptHash)).toEqual(["h:fix the parser"]);
  });

  test("offline and pinned decisions never became candidates — they never asked the service", () => {
    const candidates = buildOverrideCandidates({
      decisions: [
        decision("d1", 20, { routed: "pinned" }),
        decision("d2", 21, { routed: "offline" }),
      ],
      prompts: [prompt("e1", 10, "fix the parser")],
      replay: new Map(),
      hashOf,
      overrideFloor: 0.75,
    });
    expect(candidates).toEqual([]);
  });

  test("a corpus prompt with no replay entry still becomes a candidate, with a null label", () => {
    // The exclusion belongs to `scoreCandidates`, which names it `no-replayed-label`. Dropping the
    // entry here instead would shrink the candidate denominator without saying so.
    const [entry] = buildOverrideCandidates({
      decisions: [decision("d1", 20)],
      prompts: [prompt("e1", 10, "fix the parser")],
      replay: new Map(),
      hashOf,
      overrideFloor: 0.75,
    });
    expect(entry).toMatchObject({ harnessLabel: null, harnessSelfReport: null });
  });
});

describe("the consensus rule is assignable to both consumers' seams", () => {
  // Three prompts, one per verdict arm. `gamma` is the case the seam existed to keep separate:
  // two panelists agreed and the third produced no usable label.
  const alphaVotes = panelRows("h:alpha", ["code", "code", "code"]);
  const betaVotes = panelRows("h:beta", ["code", "qa", "reasoning"]);
  const gammaVotes = panelRows("h:gamma", ["code", "code", null]);
  const ALL: CachedPanelVote[] = toCachedVotes(
    [...alphaVotes, ...betaVotes, ...gammaVotes],
    REFERENCE_PANEL,
  );

  test("MUB-218 takes it as its ReferenceLookup, with no adapter in between", () => {
    // The annotation states the claim; `src/minima/classifier_eval_wiring.ts` is what ENFORCES it,
    // because `tsconfig.json` includes only `src/**` and this file is never type-checked. Kept as
    // the readable statement of the seam, with the runtime assertions below as its real teeth.
    const lookup: ReferenceLookup<CachedPanelVote> = {
      corpusRev: CORPUS_REV,
      hashOf: (text) => `h:${text}`,
      consensus: RULE,
    };
    const res = resolveReferenceVerdicts(["alpha", "beta", "gamma", "delta"], ALL, lookup);

    expect(res.entriesResolved).toBe(1);
    expect(res.verdicts.get("alpha")).toEqual({ taskType: "code", votesFor: 3, votesTotal: 3 });
    expect(res.entriesPanelSplit).toBe(1);
    expect(res.entriesPanelIncomplete).toBe(1);
    expect(res.entriesUnvoted).toBe(1);
  });

  test("MUB-226 takes the same value as its ConsensusFn, with no adapter in between", () => {
    const rule: ConsensusFn = RULE;
    const cfg: AdjudicationConfig = {
      scope: "seam",
      regimeBoundaryTs: 100,
      corpusRev: CORPUS_REV,
      currentFloor: 0.75,
    };
    const candidate = (hash: string): OverrideCandidate => ({
      promptHash: hash,
      decisions: [
        {
          ts: 10,
          serviceLabel: "other",
          corroboration: "corroborated",
          serviceLabelOverridden: false,
        },
      ],
      harnessLabel: "code",
      harnessSelfReport: 0.9,
    });
    const { rows, excluded } = scoreCandidates(
      ["h:alpha", "h:beta", "h:gamma", "h:delta"].map(candidate),
      ALL,
      rule,
      cfg,
    );

    expect(rows.map((r) => r.promptHash)).toEqual(["h:alpha"]);
    expect(rows[0]).toMatchObject({
      referenceLabel: "code",
      panelVotes: 3,
      panelDistinctLabels: 1,
    });
    expect(excluded).toEqual([
      { promptHash: "h:beta", reason: "panel-split" },
      { promptHash: "h:gamma", reason: "panel-incomplete" },
      { promptHash: "h:delta", reason: "no-cached-label" },
    ]);
  });

  test("a two-of-three panel is never scored as an agreement on either side", () => {
    // The failure this seam was reconciled to prevent. Dropping the null vote to satisfy a
    // non-nullable row type leaves two agreeing votes, and both consumers would have called that
    // a reference label — pseudo-gold out of a panelist that never voted.
    const dropped = ALL.filter((v) => v.promptHash === "h:gamma" && v.taskType !== null);
    expect(dropped).toHaveLength(2);
    expect(RULE(dropped)).toEqual({ kind: "incomplete", votes: 2, panelSize: 3 });
  });
});

describe("a retired panelist's votes never complete a panel that no longer has it", () => {
  test("toCachedVotes drops a vote from a model that is not on the panel", () => {
    // Changing a panelist is a NEW model_id and deliberately NOT a revision bump, so the retired
    // panelist's paid rows stay in the ledger at the CURRENT rev. Two current panelists plus one
    // retired one is three votes agreeing on a label — and the quorum rule counts votes, not
    // membership, so it would call that unanimous. `buildPanelReport` filters membership in
    // `indexVotes`; every consumer path has to filter it in the same place or score a wider panel
    // than the one it names.
    const rows = [
      stored("h:alpha", PANEL_IDS[0] as string, "code"),
      stored("h:alpha", PANEL_IDS[1] as string, "code"),
      stored("h:alpha", "retired-model-4o", "code"),
    ];
    const votes = toCachedVotes(rows, REFERENCE_PANEL);
    expect(votes.map((v) => v.modelId)).toEqual([PANEL_IDS[0], PANEL_IDS[1]]);
    expect(RULE(votes)).toEqual({ kind: "incomplete", votes: 2, panelSize: 3 });
  });

  test("both consumers see the retired vote as incomplete, not as a reference label", () => {
    const votes = toCachedVotes(
      [
        stored("h:alpha", PANEL_IDS[0] as string, "code"),
        stored("h:alpha", PANEL_IDS[1] as string, "code"),
        stored("h:alpha", "retired-model-4o", "code"),
      ],
      REFERENCE_PANEL,
    );
    const res = resolveReferenceVerdicts(["alpha"], votes, {
      corpusRev: CORPUS_REV,
      hashOf: (text) => `h:${text}`,
      consensus: RULE,
    });
    expect(res.entriesResolved).toBe(0);
    expect(res.entriesPanelIncomplete).toBe(1);

    const { rows, excluded } = scoreCandidates(
      [
        {
          promptHash: "h:alpha",
          decisions: [
            {
              ts: 10,
              serviceLabel: "other",
              corroboration: "corroborated",
              serviceLabelOverridden: false,
            },
          ],
          harnessLabel: "code",
          harnessSelfReport: 0.9,
        },
      ],
      votes,
      RULE,
      { scope: "seam", regimeBoundaryTs: 100, corpusRev: CORPUS_REV, currentFloor: 0.75 },
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([{ promptHash: "h:alpha", reason: "panel-incomplete" }]);
  });
});

describe("the names both consumers export, which mean different things", () => {
  test("the two deriveFloors are different functions and must not be merged", () => {
    // MUB-218 derives a floor from the reliability curve's TAIL over scored entries, against a
    // stated target correctness. MUB-226 reads one off a self-report SWEEP, where the bar is
    // corrections exceeding harms. Same name, different input, different question, different
    // answer — a single import of `deriveFloor` would silently pick one of them.
    expect(deriveFloorFromCurve).not.toBe(deriveFloorFromSweep);
    expect(deriveFloorFromSweep([])).toEqual({ floor: null, lowestNetPositive: null });
    expect(
      deriveFloorFromCurve([], { targetCorrectness: 0.85, thresholds: [0.75], baseline: 0.75 }),
    ).toMatchObject({ kind: "underdetermined", reason: "no-observations" });
  });

  test("the two support bars are separate constants that happen to agree", () => {
    // Equal today and read off the same reasoning — ten is the first two-digit denominator — but
    // each governs its own readout. Asserting they agree is not the same as sharing one, and
    // sharing one would make a change to either an unannounced change to the other.
    expect(SCORE_MIN_SUPPORT).toBe(10);
    expect(ADJUDICATE_MIN_SUPPORT).toBe(10);
  });
});

describe("the ledger's own rows travel the seam", () => {
  test("votes written and read back through MinimaDb resolve through the shipped rule", () => {
    // The whole chain, on a real ledger: a string corpus revision (both consumers typed it `number`
    // until this pass), snake_case columns, a NULL task_type, and the shipped panel's model ids.
    const db = new MinimaDb(":memory:");
    try {
      const hash = promptHash("run the tests");
      const cast: readonly (TaskType | null)[] = ["code", "code", null];
      for (const [i, taskType] of cast.entries()) {
        db.upsertConsensusVote({
          promptHash: hash,
          modelId: PANEL_IDS[i] as string,
          corpusRev: CORPUS_REV,
          taskType,
          difficulty: null,
          confidence: null,
        });
      }
      const votes = toCachedVotes(db.listConsensusVotes(CORPUS_REV), REFERENCE_PANEL);
      expect(votes).toHaveLength(3);
      expect(votes.filter((v) => v.taskType === null)).toHaveLength(1);

      const res = resolveReferenceVerdicts(["run the tests"], votes, {
        corpusRev: CORPUS_REV,
        hashOf: promptHash,
        consensus: RULE,
      });
      expect(res.entriesPanelIncomplete).toBe(1);
      expect(res.entriesResolved).toBe(0);
      expect(res.votesAtOtherRev).toBe(0);
      expect(res.votesWithoutCorpusEntry).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a vote at another corpus revision is a miss on both consumers, not a stale hit", () => {
    const db = new MinimaDb(":memory:");
    try {
      const hash = promptHash("ship it");
      for (const id of PANEL_IDS) {
        db.upsertConsensusVote({
          promptHash: hash,
          modelId: id,
          corpusRev: "r1-superseded",
          taskType: "code",
          difficulty: null,
          confidence: null,
        });
      }
      expect(db.listConsensusVotes(CORPUS_REV)).toHaveLength(0);

      const votes = toCachedVotes(db.listConsensusVotes("r1-superseded"), REFERENCE_PANEL);
      const res = resolveReferenceVerdicts(["ship it"], votes, {
        corpusRev: CORPUS_REV,
        hashOf: promptHash,
        consensus: RULE,
      });
      expect(res.votesAtOtherRev).toBe(3);
      expect(res.entriesUnvoted).toBe(1);

      const report = buildAdjudicationReport(
        [
          {
            promptHash: hash,
            decisions: [
              {
                ts: 10,
                serviceLabel: "other",
                corroboration: "corroborated",
                serviceLabelOverridden: false,
              },
            ],
            harnessLabel: "code",
            harnessSelfReport: 0.9,
          },
        ],
        votes,
        RULE,
        { scope: "seam", regimeBoundaryTs: 100, corpusRev: CORPUS_REV, currentFloor: 0.75 },
      );
      expect(report.scored).toBe(0);
      expect(report.excluded.find((e) => e.reason === "no-cached-label")?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
