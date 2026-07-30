/**
 * Where the classifier evaluation's three halves are joined.
 *
 * MUB-216 produces reference labels, MUB-218 scores a replay against them and MUB-226 adjudicates
 * the override. Each was built without importing the others, so each declared its own vote row, its
 * own verdict and its own corpus revision — and until this module existed there was nowhere those
 * declarations met. `scripts/` is outside `tsconfig.json`'s `include`, so a join written there
 * would still not be type-checked: this module is in `src/` for exactly that reason, and the
 * assignability of {@link REFERENCE_CONSENSUS} to both consumers' seams is checked by `bun run
 * check` rather than by a comment.
 *
 * It is the only place in the tree that binds the consensus rule to the panel. ADR 0001 makes
 * consensus a read-time derivation by ONE function; binding it once here is what keeps two
 * consumers from quorumming against different panels over the same cached votes.
 *
 * Impure only in that it takes ledger ROWS. It opens nothing, spends nothing and calls nothing:
 * the reads are the shell's, every count below is a pure core's, and no path here can reach a
 * provider.
 */
import type { RoutingDecisionRow, UserPromptRow } from "../db/minima_db.ts";
import { CORPUS_REV, REGIME_BOUNDARY_TS } from "./classifier_eval.ts";
import {
  type AdjudicationReport,
  type HarnessReplay,
  buildAdjudicationReport,
  buildOverrideCandidates,
} from "./classifier_eval_adjudicate.ts";
import {
  DEFAULT_CONFIDENCE_BOUNDARIES,
  type ModelReplay,
  type ReplayScoreReport,
  type ScoredReplay,
  buildReplayScoreReport,
  resolveReferenceVerdicts,
  scoreReplay,
  segmentCorpus,
} from "./classifier_eval_score.ts";
import { CLASSIFY_CONFIDENCE_FLOOR } from "./classify.ts";
import {
  REFERENCE_PANEL,
  type StoredVote,
  consensusRuleFor,
  promptHash,
  toCachedVotes,
} from "./consensus_panel.ts";

/**
 * THE read-time consensus rule, panel bound (ADR 0001).
 *
 * Both consumers take this exact value. Neither adapts it: their verdict types are supertypes of
 * what it returns, so there is no conversion between the rule and either reader — and a conversion
 * is the only place an arm of the verdict could be dropped on the way through.
 */
export const REFERENCE_CONSENSUS = consensusRuleFor(REFERENCE_PANEL);

/**
 * The model id a readout carries when no classifier replay has been run.
 *
 * A run with no replay scores every corpus entry as `unreplayed` rather than reporting an empty
 * corpus: "the classifier was never asked" is a fact about this run's coverage, and an empty table
 * would read as a fact about the classifier. The replay itself is a paid pass over the corpus and
 * nothing in the ledger caches one, so this is the state every invocation is in today.
 */
export const UNREPLAYED_MODEL_ID = "(no classifier replay recorded)";

/** The ledger rows an evaluation reads. Read by the shell, interpreted only by pure cores. */
export interface EvalReads {
  readonly prompts: readonly UserPromptRow[];
  readonly decisions: readonly RoutingDecisionRow[];
  readonly votes: readonly StoredVote[];
}

/**
 * Score a replay against the panel's cached labels (MUB-218).
 *
 * `targetCorrectness` is the caller's, never defaulted: the non-arbitrary bar is what the service's
 * own label scores on this same corpus, which is MUB-226's adjudication and not this readout's, so
 * stating it is the caller's act and printing it beside the answer is what keeps that honest.
 */
export function buildScoreReport(
  reads: EvalReads,
  opts: { readonly scope: string; readonly targetCorrectness: number },
  replays: readonly ModelReplay[] = [],
): ReplayScoreReport {
  const corpus = segmentCorpus(reads.prompts, REGIME_BOUNDARY_TS);
  const reference = resolveReferenceVerdicts(
    corpus.map((e) => e.text),
    toCachedVotes(reads.votes),
    { corpusRev: CORPUS_REV, hashOf: promptHash, consensus: REFERENCE_CONSENSUS },
  );
  const passes = replays.length ? replays : [{ modelId: UNREPLAYED_MODEL_ID, labels: [] }];
  const scored: ScoredReplay[] = passes.map((r) => ({
    modelId: r.modelId,
    entries: scoreReplay(r, corpus, reference.verdicts),
  }));
  return buildReplayScoreReport(scored, reference, {
    scope: opts.scope,
    regimeBoundaryTs: REGIME_BOUNDARY_TS,
    confidenceBoundaries: DEFAULT_CONFIDENCE_BOUNDARIES,
    floor: {
      targetCorrectness: opts.targetCorrectness,
      thresholds: DEFAULT_CONFIDENCE_BOUNDARIES,
      baseline: CLASSIFY_CONFIDENCE_FLOOR,
    },
  });
}

/**
 * Adjudicate what overriding the service's label would have done (MUB-226).
 *
 * `CLASSIFY_CONFIDENCE_FLOOR` is imported from the classifier that ships it, not restated: it is
 * both the baseline a derived floor is argued against and the gate a caller-supplied label had to
 * clear to have overridden at all, and those are the same number because they are the same rule.
 */
export function buildOverrideReport(
  reads: EvalReads,
  opts: { readonly scope: string },
  replay: ReadonlyMap<string, HarnessReplay> = new Map(),
): AdjudicationReport {
  const candidates = buildOverrideCandidates({
    decisions: reads.decisions,
    prompts: reads.prompts,
    replay,
    hashOf: promptHash,
    overrideFloor: CLASSIFY_CONFIDENCE_FLOOR,
  });
  return buildAdjudicationReport(candidates, toCachedVotes(reads.votes), REFERENCE_CONSENSUS, {
    scope: opts.scope,
    regimeBoundaryTs: REGIME_BOUNDARY_TS,
    corpusRev: CORPUS_REV,
    currentFloor: CLASSIFY_CONFIDENCE_FLOOR,
  });
}
