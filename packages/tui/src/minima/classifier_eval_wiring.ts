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
  type ReplayModel,
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
 * A corpus entry with no answer from the SHIPPED classifier still becomes a candidate, carrying
 * nulls. `sources.replay` holds that one model's labels and nothing else — see
 * {@link OVERRIDE_REPLAY_MODELS} — so three different states arrive here as the same non-answer:
 * no stored row, a stored abstention, and a row whose taxonomy no longer re-admits. None of them is
 * ever filled from the other replayed model, because a label from a model production does not run
 * would adjudicate an override channel that was never open. The exclusion is `scoreCandidates`'s to
 * name — dropping the entry here would shrink the candidate denominator without saying so, and
 * `candidates` is what every exclusion count is read against.
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
   * Optional because the field postdates this shape's first consumers — NOT because a consumer
   * ignores it. Both readouts built from these reads join it now, over different model sets:
   * `buildScoreReport` over every replayed model, `buildOverrideReport` over the shipped classifier
   * alone ({@link OVERRIDE_REPLAY_MODELS}). Absent or empty is the state every invocation was in
   * before the replay existed, and it still resolves to a readout rather than an error — see
   * {@link UNREPLAYED_MODEL_ID}: `--score` reads every corpus entry as `unreplayed`, and the
   * adjudication sets every candidate aside as `no-replayed-label`.
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
 * The replay models an ADJUDICATION may read: the shipped classifier, and nothing else.
 *
 * MUB-218 replays two models and only the first is the classifier the override channel would
 * actually open. `cli/main.ts` builds the production `TaskClassifier` from `config.classifyModel ??
 * CHEAP_FALLBACK_MODELS[0]`, `config.ts` defaults `classifyModel` to null, and
 * `tests/classifier-replay.test.ts` pins `REPLAY_MODELS[0].model.id` to `CHEAP_FALLBACK_MODELS[0]`
 * — so the first entry IS the shipped classifier, checked rather than asserted.
 *
 * The second model is in {@link REPLAY_MODELS} to PRICE the model switch — read its docstring: it
 * is there because its API can return token probabilities, which is a capability a later confidence
 * ticket would need, not because production runs it. Merging both models' labels, or falling back
 * to the second where the first has no row, would adjudicate an override channel production would
 * never open — and every symptom of that mistake reads as a legitimate finding: more scored rows,
 * a fuller sweep, a floor argued off traffic the harness never sent.
 *
 * `slice(0, 1)` rather than `[REPLAY_MODELS[0]!]` because `noUncheckedIndexedAccess` is on: an
 * emptied `REPLAY_MODELS` degrades to "no model has a usable row", which is the state this module
 * already handles honestly, instead of throwing at module load.
 */
export const OVERRIDE_REPLAY_MODELS: readonly ReplayModel[] = REPLAY_MODELS.slice(0, 1);

/**
 * Join the cached replay labels to the live corpus, for the shipped classifier alone.
 *
 * Built on `toModelReplays` — the same function `--score` reads the cache with — rather than on a
 * lookup of its own. That is the point of it: one corpus-revision filter, one model filter, one
 * re-admission rule and one hash. A hand-rolled join here would be a SECOND join that can silently
 * disagree with the coverage `--score` prints, and the two readouts would describe different cache
 * hits while both looking right.
 *
 * Deliberately NOT pre-filtered with `isReadableReplayLabel`: `toModelReplays` applies the shipped
 * parser itself and COUNTS what it drops as `unreadable`. Filtering first would change no label and
 * zero that diagnostic.
 *
 * Keyed on the corpus TEXT, which is what {@link buildOverrideCandidates} looks up. The stored row
 * is a hash (ADR 0008) and the hash is one-way, so the text can only come back from the live corpus
 * — re-hashed here with the one `promptHash` the panel, the cache and the candidates all use.
 *
 * The corpus is `segmentCorpus`'s, the same one `buildScoreReport` scores over, so an entry cannot
 * be corpus to one readout and non-corpus to the other.
 */
export function resolveOverrideReplay(reads: EvalReads): {
  replay: Map<string, HarnessReplay>;
  coverage: ReplayResolution;
} {
  const coverage = toModelReplays(
    segmentCorpus(reads.prompts, REGIME_BOUNDARY_TS).map((e) => e.text),
    reads.replayLabels ?? [],
    OVERRIDE_REPLAY_MODELS,
    { corpusRev: CORPUS_REV, hashOf: promptHash },
  );
  const replay = new Map<string, HarnessReplay>();
  // One model in the set, so there is no merge rule to get wrong: an entry is written by the
  // shipped classifier's row or by nothing at all. Widening the set would need one — which is a
  // reason not to widen it, not a reason to write one speculatively.
  for (const pass of coverage.replays) {
    for (const label of pass.labels) {
      replay.set(label.text, {
        // A stored abstention arrives as a PRESENT entry with both fields null (`toModelReplays`
        // keeps that distinct from a missing row), and `scoreCandidates` sets both aside under the
        // same reason. Present-and-declined is never filled from the other model either.
        taskType: label.classification?.taskType ?? null,
        // The RAW self-report, exactly as ADR 0008 stored it. Nothing here re-gates it on the
        // floor: the floor's only role downstream is as a sweep coordinate — see
        // {@link buildOverrideReport} — and a replay filtered on it would delete the evidence in
        // the very region the sweep exists to argue about.
        confidence: label.classification?.confidence ?? null,
      });
    }
  }
  return { replay, coverage };
}

/**
 * Name the classifier this adjudication actually read, for the readout's header.
 *
 * Derived from the RESOLUTION, not from {@link OVERRIDE_REPLAY_MODELS}: the model set says which
 * model is eligible, and only the join says which one had a usable row. A header naming the
 * eligible model would claim a replay the numbers beneath it may not rest on — and "which
 * classifier was adjudicated" is exactly the question this suffix exists to answer.
 */
function overrideReplayScope(coverage: ReplayResolution): string {
  const read = coverage.replays.map((r) => r.modelId);
  return read.length > 0 ? read.join(" + ") : UNREPLAYED_MODEL_ID;
}

/**
 * Adjudicate what overriding the service's label would have done (MUB-226).
 *
 * The replay is resolved HERE from the same reads, never handed in: an injected map is a second
 * join by another name, and a defaulted empty one silently scored nothing at all for as long as it
 * existed. There is no parameter left to default, so the empty case is now reachable only from an
 * empty cache.
 *
 * `CLASSIFY_CONFIDENCE_FLOOR` is imported from the classifier that ships it, not restated: it is
 * both the baseline a derived floor is argued against and the gate a caller-supplied label had to
 * clear to have overridden at all, and those are the same number because they are the same rule.
 * It is applied ZERO times as a filter here. As `overrideFloor` it decides only
 * `serviceLabelOverridden` — a statement about what the LEDGER recorded, not about the replay — and
 * as `currentFloor` it re-enters as one coordinate of the threshold sweep plus the "shipped floor"
 * marker. No row is dropped for sitting below it, which is what lets the sweep say what a lower
 * floor would have bought.
 */
export function buildOverrideReport(
  reads: EvalReads,
  opts: { readonly scope: string },
): AdjudicationReport {
  const { replay, coverage } = resolveOverrideReplay(reads);
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
      scope: `${opts.scope} · classifier ${overrideReplayScope(coverage)}`,
      regimeBoundaryTs: REGIME_BOUNDARY_TS,
      corpusRev: CORPUS_REV,
      currentFloor: CLASSIFY_CONFIDENCE_FLOOR,
    },
  );
}
