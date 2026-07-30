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
 *
 * One consequence worth stating where it is caused: `ReferenceResolution.votesAtOtherRev` is
 * structurally 0 on this path. `listConsensusVotes` takes the revision as a required argument and
 * filters in SQL — ADR 0001 leaves no unscoped read — so an off-revision vote never reaches
 * `resolveReferenceVerdicts` to be counted. The diagnostic is live for a caller that assembles
 * votes some other way; through the ledger it is a zero by construction, not a measurement.
 */
import type { RoutingDecisionRow, UserPromptRow } from "../db/minima_db.ts";
import { CORPUS_REV, REGIME_BOUNDARY_TS } from "./classifier_eval.ts";
import {
  type AdjudicationReport,
  type EntryDecision,
  type OverrideCandidate,
  buildAdjudicationReport,
} from "./classifier_eval_adjudicate.ts";
import {
  correlateDecisions,
  groupByCorpusEntry,
  partitionServiceRouted,
} from "./classifier_eval_correlate.ts";
import {
  DEFAULT_CONFIDENCE_BOUNDARIES,
  type ReplayScoreReport,
  type ScoredReplay,
  buildReplayScoreReport,
  resolveReferenceVerdicts,
  scoreReplay,
  segmentCorpus,
} from "./classifier_eval_score.ts";
import {
  REPLAY_MODELS,
  type ReplayResolution,
  type StoredReplayLabel,
  toModelReplays,
} from "./classifier_replay.ts";
import { CLASSIFY_CONFIDENCE_FLOOR } from "./classify.ts";
import {
  REFERENCE_PANEL,
  type StoredVote,
  consensusRuleFor,
  promptHash,
  toCachedVotes,
} from "./consensus_panel.ts";
import type { TaskType } from "./schemas.ts";

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

/** What the replay made of one corpus entry. Null on either field = the classifier declined. */
export interface HarnessReplay {
  readonly taskType: TaskType | null;
  readonly confidence: number | null;
}

/** What {@link buildOverrideCandidates} needs to turn ledger rows into candidates. */
export interface CandidateSources {
  readonly decisions: readonly RoutingDecisionRow[];
  readonly prompts: readonly UserPromptRow[];
  /** The replay's answer per corpus entry, keyed on the EXACT recorded text. */
  readonly replay: ReadonlyMap<string, HarnessReplay>;
  /** MUB-216's key producer, injected so there is exactly one hash in play. */
  readonly hashOf: (text: string) => string;
  /**
   * The floor a caller-supplied task type has to clear to override the service's own. Mirrored as
   * the COMPARISON `runtime.ts` makes (`confidence >= floor`), never as a second copy of the number.
   */
  readonly overrideFloor: number;
}

/**
 * Turn ledger rows into adjudication candidates, via MUB-225's correlation.
 *
 * Every step is delegated rather than restated, so a row cannot be corpus to the correlation and
 * non-corpus here: `partitionServiceRouted` drops the decisions that never asked the service,
 * `correlateDecisions` applies the run-and-timestamp rule, and `groupByCorpusEntry` collapses a
 * prompt's whole recovery ladder onto ONE candidate. Re-deriving any of them would be a second
 * chance to disagree with the correlation report printed beside this one.
 *
 * A corpus entry with no replay answer still becomes a candidate, carrying nulls. The exclusion is
 * `scoreCandidates`'s to name — dropping the entry here would shrink the candidate denominator
 * without saying so, and `candidates` is what every exclusion count is read against.
 */
export function buildOverrideCandidates(sources: CandidateSources): OverrideCandidate[] {
  const { serviceRouted } = partitionServiceRouted(sources.decisions);
  const { pairings } = correlateDecisions(serviceRouted, sources.prompts);
  const byRecId = new Map(serviceRouted.map((d) => [d.rec_id, d]));
  const corroborationByRecId = new Map(pairings.map((p) => [p.recId, p.corroboration]));

  return groupByCorpusEntry(pairings).map((entry) => {
    const decisions: EntryDecision[] = [];
    for (const recId of entry.recIds) {
      const row = byRecId.get(recId);
      if (row === undefined) continue;
      decisions.push({
        ts: row.ts,
        serviceLabel: (row.task_type as TaskType | null) ?? null,
        corroboration: corroborationByRecId.get(recId) ?? "unassessable",
        // The client's label overrode only when it cleared the floor. A recorded client label below
        // it never won, so the service's own label is what the row carries.
        serviceLabelOverridden:
          row.client_task_type !== null &&
          row.client_confidence !== null &&
          row.client_confidence >= sources.overrideFloor,
      });
    }
    const replayed = sources.replay.get(entry.text);
    return {
      promptHash: sources.hashOf(entry.text),
      decisions,
      harnessLabel: replayed?.taskType ?? null,
      harnessSelfReport: replayed?.confidence ?? null,
    };
  });
}

/** The ledger rows an evaluation reads. Read by the shell, interpreted only by pure cores. */
export interface EvalReads {
  readonly prompts: readonly UserPromptRow[];
  readonly decisions: readonly RoutingDecisionRow[];
  readonly votes: readonly StoredVote[];
  /**
   * MUB-218's cached replay labels, as `listReplayLabels` returns them.
   *
   * Optional because `buildOverrideReport` takes the same reads and does not consume them. Absent
   * or empty is the state every invocation was in before the replay existed, and it still resolves
   * to a readout rather than an error — see {@link UNREPLAYED_MODEL_ID}.
   */
  readonly replayLabels?: readonly StoredReplayLabel[];
}

/**
 * A `--score` readout: the report, and the coverage of the replay that produced it.
 *
 * Both halves come back from ONE call because both derive from one resolution of the cache. A shell
 * that resolved it twice — once to score, once to report coverage — could print a coverage figure
 * that describes a different join than the numbers above it.
 */
export interface ReplayScoreReadout {
  readonly report: ReplayScoreReport;
  readonly coverage: ReplayResolution;
}

/**
 * Score the classifier replay against the panel's cached labels (MUB-218).
 *
 * The replay's labels come from the LEDGER and are re-joined to the live corpus here, rather than
 * being handed in: the stored row is a hash (ADR 0008), so the only way back to a corpus entry is
 * to re-hash the live text with the same `promptHash` the panel and the cache both use. Injecting
 * that one hash — never a second implementation — is what keeps a cache hit a cache hit.
 *
 * `targetCorrectness` is the caller's, never defaulted: the non-arbitrary bar is what the service's
 * own label scores on this same corpus, which is MUB-226's adjudication and not this readout's, so
 * stating it is the caller's act and printing it beside the answer is what keeps that honest.
 */
export function buildScoreReport(
  reads: EvalReads,
  opts: { readonly scope: string; readonly targetCorrectness: number },
): ReplayScoreReadout {
  const corpus = segmentCorpus(reads.prompts, REGIME_BOUNDARY_TS);
  const reference = resolveReferenceVerdicts(
    corpus.map((e) => e.text),
    toCachedVotes(reads.votes, REFERENCE_PANEL),
    { corpusRev: CORPUS_REV, hashOf: promptHash, consensus: REFERENCE_CONSENSUS },
  );
  const coverage = toModelReplays(
    corpus.map((e) => e.text),
    reads.replayLabels ?? [],
    REPLAY_MODELS,
    { corpusRev: CORPUS_REV, hashOf: promptHash },
  );
  const passes = coverage.replays.length
    ? coverage.replays
    : [{ modelId: UNREPLAYED_MODEL_ID, labels: [] }];
  const scored: ScoredReplay[] = passes.map((r) => ({
    modelId: r.modelId,
    entries: scoreReplay(r, corpus, reference.verdicts),
  }));
  const report = buildReplayScoreReport(scored, reference, {
    scope: opts.scope,
    regimeBoundaryTs: REGIME_BOUNDARY_TS,
    confidenceBoundaries: DEFAULT_CONFIDENCE_BOUNDARIES,
    floor: {
      targetCorrectness: opts.targetCorrectness,
      thresholds: DEFAULT_CONFIDENCE_BOUNDARIES,
      baseline: CLASSIFY_CONFIDENCE_FLOOR,
    },
  });
  return { report, coverage };
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
  return buildAdjudicationReport(
    candidates,
    toCachedVotes(reads.votes, REFERENCE_PANEL),
    REFERENCE_CONSENSUS,
    {
      scope: opts.scope,
      regimeBoundaryTs: REGIME_BOUNDARY_TS,
      corpusRev: CORPUS_REV,
      currentFloor: CLASSIFY_CONFIDENCE_FLOOR,
    },
  );
}
