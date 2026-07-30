/**
 * Classifier evaluation — corpus extraction and cost-guarded dry run (MUB-215), the prompt↔decision
 * correlation (MUB-225), the provider-diverse reference panel (MUB-216), the replay's score and the
 * routing floor it implies (MUB-218), and the override adjudication (MUB-226).
 *
 * The dry run reports the corpus a full evaluation would use and what that run would cost, and is
 * READ-ONLY. `--correlate` reports which prompt caused each recorded routing decision — an inferred
 * link, with its corroboration rate measured rather than assumed. `--score` and `--adjudicate` read
 * the panel's cached labels and report against them. `--self-consistency` (MUB-217) reads the
 * sampling lane's cached draws and asks whether the classifier's self-reported number is honest
 * about its OWN uncertainty, using no reference labels at all. All five read only.
 *
 * `--spend --max-usd=<ceiling>` is the ONE path that bills. It runs the reference panel, the
 * classifier replay and the self-consistency sampling over the work they do not already have at the
 * current corpus revision, writing each row to the ledger as it lands. A rerun with everything
 * cached spends nothing and prints the same report, which is what makes MUB-218, MUB-226 and
 * MUB-217's readouts re-runnable without re-invoking anything. `--pilot` is a MODIFIER on that
 * path, narrowing the sampling lane to its deterministic 10-entry pilot; it is not a verb and adds
 * no route to a billable call.
 *
 *   bun packages/tui/scripts/classifier_eval.ts
 *   bun packages/tui/scripts/classifier_eval.ts --project=minima --limit=5000
 *   bun packages/tui/scripts/classifier_eval.ts --correlate
 *   bun packages/tui/scripts/classifier_eval.ts --score --target-correctness=0.85
 *   bun packages/tui/scripts/classifier_eval.ts --adjudicate
 *   bun packages/tui/scripts/classifier_eval.ts --self-consistency --samples=10
 *   bun packages/tui/scripts/classifier_eval.ts --spend --max-usd=0.10 --pilot
 *   bun packages/tui/scripts/classifier_eval.ts --spend --max-usd=4.00
 *
 * This is the SHELL, and it is a dispatcher only: argv interpretation, the cost guard, the panel,
 * all counting and all rendering live in the pure cores, which are unit-tested with no ledger and
 * no network. What is left here is opening a ledger, the reads, the writes, and printing — nothing
 * a reported number depends on.
 *
 * The three-way JOIN between MUB-216, MUB-218 and MUB-226 is deliberately NOT here either:
 * `scripts/` is outside `tsconfig.json`'s `include`, so a join written in this file would not be
 * type-checked, and three modules that were never type-checked against each other is exactly how
 * their seams drifted. It lives in `src/minima/classifier_eval_wiring.ts` instead.
 *
 * It lives under `scripts/` deliberately: `bun test` matches only `*.test.ts`, so nothing here is
 * reachable from the hermetic suite, and the paid path cannot be entered by running the suite.
 */

import { existsSync } from "node:fs";
import { envVarsForProvider, providerKeyPresent } from "../src/ai/provider_catalog.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  CORPUS_REV,
  DEFAULT_LENGTH_BOUNDARIES,
  buildDryRunReport,
  checkSpendCeiling,
  corpusPrompts,
  decideInvocation,
  renderDryRunReport,
  suggestCeilingUsd,
} from "../src/minima/classifier_eval.ts";
import { renderAdjudicationReport } from "../src/minima/classifier_eval_adjudicate.ts";
import {
  buildCorrelationReport,
  renderCorrelationReport,
} from "../src/minima/classifier_eval_correlate.ts";
import { renderReplayScoreReport } from "../src/minima/classifier_eval_score.ts";
import {
  UNREPLAYED_MODEL_ID,
  buildOverrideReport,
  buildScoreReport,
} from "../src/minima/classifier_eval_wiring.ts";
import {
  REPLAY_MODELS,
  isReadableReplayLabel,
  makeReplayCaller,
  planReplayRun,
  renderReplayCoverage,
  renderReplayOutstanding,
  renderReplayRunResult,
  replayCallSpecs,
  runReplay,
  summarizeReplayOutstanding,
} from "../src/minima/classifier_replay.ts";
import {
  SAMPLED_MODEL,
  isReadableSample,
  pilotEntries,
  planSampling,
  renderSamplingOutstanding,
  renderSamplingRunResult,
  runSampling,
  sampleKey,
  selfConsistencyCallSpecs,
  summarizeSamplingOutstanding,
} from "../src/minima/classifier_self_consistency.ts";
import {
  buildSelfConsistencyReport,
  renderSelfConsistencyReport,
} from "../src/minima/classifier_self_consistency_report.ts";
import {
  REFERENCE_PANEL,
  buildPanelReport,
  checkPanelDiversity,
  makePanelCaller,
  makeSpendGuard,
  panelCallSpecs,
  planPanelRun,
  promptHash,
  renderOutstandingWork,
  renderPanelReport,
  renderPanelRunResult,
  runPanel,
  summarizeOutstanding,
  voteKey,
} from "../src/minima/consensus_panel.ts";
import { hydrateEnv } from "../src/tui/config_store.ts";

const HELP = [
  "Classifier eval — dry run (MUB-215), prompt↔decision correlation (MUB-225), reference",
  "panel (MUB-216), replay score and routing floor (MUB-218), override adjudication (MUB-226),",
  "self-consistency sampling (MUB-217).",
  "",
  "  --correlate       report which prompt caused each recorded decision, and how much to",
  "                    trust that claim (a heuristic, not a join). Reads only.",
  "  --score           score the classifier replay against the reference panel and derive the",
  "                    routing floor it implies. REQUIRES --target-correctness. Reads only.",
  "  --target-correctness=<f>",
  "                    the correctness an admitted override must reach, in (0,1]. No default:",
  "                    the non-arbitrary bar is what the SERVICE's own label scores on this",
  "                    corpus, and defaulting it would make a chosen number look derived",
  "  --adjudicate      would overriding the service's task label have helped? Four-way outcome",
  "                    and a net-benefit floor sweep. Reads only.",
  "  --self-consistency",
  "                    is the classifier's self-reported number honest about its OWN uncertainty?",
  "                    Compares the self-report against the empirical frequency of its modal label",
  "                    over repeated draws. Uses NO reference labels. Reads only.",
  "  --samples=<n>     draws per prompt for the sampling lane (default 10, floored at 2 — at n=1",
  "                    the modal frequency is 1.0 by construction). Parsed forgivingly: it cannot",
  "                    spend on its own and --max-usd still binds. The effective n is printed",
  "  --pilot           MODIFIER on --spend: buy only the sampling lane's 10-entry pilot, which is",
  "                    what authorizes the full lane. Not a verb — on its own it spends nothing",
  "  --project=<key>   scope the corpus to one project's runs (default: whole ledger)",
  "  --limit=<n>       cap rows read, most recent first (default 20000)",
  "  --db=<path>       read a specific ledger (default: the harness's own)",
  "  --spend           opt in to a billable run of the reference panel — REQUIRES --max-usd;",
  "                    refused on its own. Only prompts with no cached vote at the current",
  "                    corpus revision are paid for",
  "  --max-usd=<usd>   the ceiling you accept paying. The run refuses if the projection",
  "                    exceeds it, and stops dispatching if realized spend reaches it. No",
  "                    default: a defaulted spending limit could cost money",
  "  --help            this message",
  "",
  "Exit codes: 0 ok · 2 refused, or stopped by the cost guard mid-run (votes already paid",
  "for are kept — rerun to finish).",
].join("\n");

const invocation = decideInvocation(process.argv.slice(2));

if (invocation.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

const { project, dbPath, rowCap, samples } = invocation;

// Opening a ledger creates it when absent, so a typo'd --db would silently report a zero corpus
// as though it were a finding. Refuse instead. (Opening an EXISTING ledger runs the harness's
// normal append-only migrations, exactly as a harness launch would.)
if (dbPath !== null && !existsSync(dbPath)) {
  console.error(
    `--db=${dbPath}: no such ledger. Refusing to create one and report an empty corpus.`,
  );
  process.exit(2);
}

const db = dbPath ? new MinimaDb(dbPath) : new MinimaDb();
const scope = project ? `project ${project} · ${db.path}` : `whole ledger · ${db.path}`;
// Set inside, exited after the ledger closes: process.exit() skips `finally`. Every mode reports
// through this one exit, so a mode cannot acquire its own close-and-exit discipline.
let exitCode = 0;
try {
  if (invocation.kind === "correlate") {
    // MUB-225. Both reads take the SAME cap, so --limit cannot pair a wide decision read against a
    // narrow prompt read; when it still bites, the report separates that artifact from a real gap.
    const report = buildCorrelationReport(
      db.listRoutingDecisions(project, rowCap),
      db.listUserPrompts(project, rowCap),
      { scope, rowCap },
    );
    // Reads only, so there is no cost guard to answer and nothing to exit non-zero about.
    console.log(renderCorrelationReport(report));
  } else if (invocation.kind === "refuse-score") {
    // Not a cost guard — nothing here could have spent. It refuses because the bar an admitted
    // override must clear is the caller's to state, and a default would look derived.
    console.error(
      invocation.reason === "missing-target"
        ? [
            "--score: refusing — no target correctness stated.",
            "  The bar an admitted override has to clear is yours to choose. There is no default:",
            "  the non-arbitrary target is what the SERVICE's own label scores on this same corpus,",
            "  which is what --adjudicate measures, and a number defaulted here would read as",
            "  derived from the data rather than chosen.",
            "  Re-run with one:  --score --target-correctness=0.85",
          ].join("\n")
        : [
            "--target-correctness: refusing — a correctness is a fraction in (0, 1].",
            "  0.85 means 'an admitted override must be right 85% of the time'.",
          ].join("\n"),
    );
    exitCode = 2;
  } else if (invocation.kind === "score" || invocation.kind === "adjudicate") {
    // Both readouts run over the SAME three reads at the same cap, so a --limit cannot pair a wide
    // decision read against a narrow prompt read, and both see the same cached votes.
    const reads = {
      prompts: db.listUserPrompts(project, rowCap),
      decisions: db.listRoutingDecisions(project, rowCap),
      votes: db.listConsensusVotes(CORPUS_REV),
      replayLabels: db.listReplayLabels(CORPUS_REV),
    };
    if (invocation.kind === "score") {
      const { report, coverage } = buildScoreReport(reads, {
        scope,
        targetCorrectness: invocation.targetCorrectness,
      });
      console.log(renderReplayScoreReport(report));
      console.log("");
      console.log(renderReplayCoverage(coverage));
      // DERIVED, not asserted: the report itself says whether a replay reached it. A fixed line of
      // prose here would keep claiming "no replay" on the first run that has one.
      if (report.models.every((m) => m.modelId === UNREPLAYED_MODEL_ID)) {
        console.error(
          [
            "",
            "note: no classifier replay is recorded, so every corpus entry reads `unreplayed` and",
            "  no floor can be derived. The reference-label block above is real — it is what the",
            "  panel's cached votes resolve to.",
            "  Run one with:  --spend --max-usd=<ceiling>",
          ].join("\n"),
        );
      }
    } else {
      const report = buildOverrideReport(reads, { scope });
      console.log(renderAdjudicationReport(report));
      const noReplay = report.excluded.find((e) => e.reason === "no-replayed-label")?.count ?? 0;
      // Nothing scored AND the replay accounted for some of it. Not `noReplay === candidates`:
      // other exclusions are legitimately non-zero (an entry spanning the boundary is set aside
      // whatever the replay did), and requiring equality would silence the note on a real run.
      if (report.scored === 0 && noReplay > 0) {
        // WHY there is no replayed label is now two different states of the world, and naming the
        // wrong one is a false statement about the ledger. DERIVED from the ledger rather than
        // asserted, so this note cannot go stale the way the last one did the moment a replay
        // landed — and the second branch no longer names a ticket as the reason, because whose
        // wiring that is has moved once already and a note that tracks it would be wrong again.
        const cached = reads.replayLabels.length;
        console.error(
          [
            "",
            ...(cached === 0
              ? ["note: no classifier replay is recorded, so"]
              : [
                  `note: ${cached} replay labels ARE cached, but the shipped replay model has no`,
                  "  usable label for these entries. So",
                ]),
            `  ${noReplay} of ${report.candidates} candidates were set aside as "replay gave no`,
            '  usable label"; the rest were set aside for the reasons listed above. The candidate',
            "  and exclusion counts are real — they are what the correlation and the cache",
            "  resolve to.",
          ].join("\n"),
        );
      }
    }
  } else if (invocation.kind === "self-consistency") {
    // MUB-217. Reads TWO things and nothing else: the prompt rows, and the draws. No votes, no
    // replay labels, no routing decisions — AC 4 is "runs with no reference labels", and the read
    // is where that is either true or not.
    console.log(
      renderSelfConsistencyReport(
        buildSelfConsistencyReport(
          {
            corpus: db.listUserPrompts(project, rowCap),
            samples: db.listSelfConsistencySamples(CORPUS_REV),
          },
          {
            scope,
            samples,
            corpusRev: CORPUS_REV,
            // The tree's ONE key producer, injected. A second hash would miss every cached draw
            // and report it as "the classifier has never been sampled on this corpus".
            hashOf: promptHash,
          },
        ),
      ),
    );
  } else {
    const rows = db.listUserPrompts(project, rowCap);
    const report = buildDryRunReport(rows, {
      scope,
      lengthBoundaries: DEFAULT_LENGTH_BOUNDARIES,
      // Each lane's legs come from the lane itself, so the projection and the calls that get
      // billed cannot disagree about which models they mean.
      specs: [
        ...panelCallSpecs(REFERENCE_PANEL),
        ...replayCallSpecs(REPLAY_MODELS),
        ...selfConsistencyCallSpecs(samples),
      ],
      rowCap,
    });
    // The projection is free, so every invocation gets it — including a refused one. A ceiling can
    // only be chosen against a number, and this is the number.
    console.log(renderDryRunReport(report));
    console.log(
      [
        "  · The panel legs above are MUB-216's chosen reference panel, priced at each model's",
        "    own output allowance (a panelist that reasons server-side bills those hidden tokens",
        "    as output). The replay legs are MUB-218's two classifier models, and `--spend` runs",
        "    both lanes under the one ceiling.",
        `  · The self-consistency leg is MUB-217's: the shipped default classifier drawn ${samples}`,
        "    times per prompt at the provider default temperature (unset). It is the deepest leg",
        "    by an order of magnitude — n calls per prompt where the others take one — so its",
        "    output allowance is where an under-count costs the most.",
      ].join("\n"),
    );

    // Both lanes work over the SAME corpus the report just counted — one definition, called once.
    const corpus = corpusPrompts(rows);
    const cachedVotes = db.listConsensusVotes(CORPUS_REV);
    const plans = planPanelRun(
      corpus,
      REFERENCE_PANEL,
      new Set(cachedVotes.map((v) => voteKey(v.prompt_hash, v.model_id))),
    );
    const work = summarizeOutstanding(plans, corpus.length, CORPUS_REV);
    console.log("");
    console.log(renderOutstandingWork(work));

    // MUB-218's replay, planned the same way against its own cache. `promptHash` and `voteKey` are
    // INJECTED rather than re-implemented: they are the tree's one key producer and one key shape,
    // and a second copy of either would produce a total cache miss and report it as "the
    // classifier has not labelled this corpus" — a defect wearing a finding's clothes.
    const cachedReplay = db.listReplayLabels(CORPUS_REV);
    // Only rows the READER can still use count as cached. A row whose taxonomy has moved on is
    // dropped by `toModelReplays` as unreadable, and counting it here would leave the entry
    // permanently unscoreable and permanently un-rebuyable — `--score` telling the caller to spend
    // and `--spend` answering "nothing to pay for". One predicate, so the two cannot disagree.
    const usableReplay = cachedReplay.filter(isReadableReplayLabel);
    const replayPlans = planReplayRun(
      corpus,
      REPLAY_MODELS,
      new Set(usableReplay.map((r) => voteKey(r.prompt_hash, r.model_id))),
      promptHash,
      voteKey,
    );
    const replayWork = summarizeReplayOutstanding(replayPlans, corpus, CORPUS_REV);
    console.log("");
    console.log(renderReplayOutstanding(replayWork));

    // MUB-217's sampling lane, planned against its own cache the same way. The key producer is the
    // same `promptHash`, and the key SHAPE is `voteKey` applied twice so the draw index rides in it
    // — the one thing this lane cannot inherit from the other two, whose keys silently upsert a
    // resample over its predecessor.
    const cachedSamples = db.listSelfConsistencySamples(CORPUS_REV).filter(isReadableSample);
    const cachedSampleKeys = new Set(
      cachedSamples.map((s) => sampleKey(voteKey, s.prompt_hash, s.model_id, s.sample_index)),
    );
    const keyOf = (hash: string, modelId: string, i: number): string =>
      sampleKey(voteKey, hash, modelId, i);
    const samplingPlan = planSampling(
      corpus,
      SAMPLED_MODEL,
      samples,
      cachedSampleKeys,
      promptHash,
      keyOf,
    );
    // The pilot is planned SEPARATELY and always, whatever the flags say, so its projection is
    // printed on every invocation and cannot go stale between the run that quotes it and the run
    // that pays it.
    const pilotPlan = planSampling(
      pilotEntries(corpus),
      SAMPLED_MODEL,
      samples,
      cachedSampleKeys,
      promptHash,
      keyOf,
    );
    const samplingWork = summarizeSamplingOutstanding(samplingPlan, pilotPlan, corpus, CORPUS_REV);
    console.log("");
    console.log(renderSamplingOutstanding(samplingWork));

    // The ceiling answers what THIS run would spend, not what the whole arc would (ADR 0006): a
    // rerun over cached labels costs nothing, and a ceiling chosen against the full-corpus figure
    // would be answering a question the run is not asking. It binds ALL THREE lanes, because one
    // `--spend` buys all three — a per-lane ceiling would let them together exceed the number the
    // caller read.
    //
    // `--pilot` narrows the SAMPLING lane to its 10-entry pilot and nothing else. It is a modifier
    // on an already-authorized spend: the panel and replay lanes are untouched by it (they owe what
    // they owe), and it opens no route to a call that `--spend --max-usd` had not already opened.
    const spendPilot = invocation.kind === "spend" && invocation.pilot;
    const samplingSpendPlan = spendPilot ? pilotPlan : samplingPlan;
    const samplingSpendCost = spendPilot ? samplingWork.pilotOutstanding : samplingWork.outstanding;
    const projected = work.cost.totalUsd + replayWork.cost.totalUsd + samplingSpendCost.totalUsd;
    const outstandingCalls =
      work.cost.totalCalls + replayWork.cost.totalCalls + samplingSpendCost.totalCalls;
    const suggested = suggestCeilingUsd(projected).toFixed(2);
    // What the SAME argv plus `--pilot` would cost, quoted beside the full figure so a caller who
    // only wants to authorize the pilot is not left to choose a ceiling against the wrong number.
    const pilotProjected =
      work.cost.totalUsd + replayWork.cost.totalUsd + samplingWork.pilotOutstanding.totalUsd;
    const pilotSuggested = suggestCeilingUsd(pilotProjected).toFixed(2);

    /** Print whatever labels exist, so the panel's findings are readable without spending. */
    const printPanelReport = (): void => {
      const votes = db.listConsensusVotes(CORPUS_REV);
      if (votes.length === 0) return;
      console.log("");
      console.log(renderPanelReport(buildPanelReport(corpus, REFERENCE_PANEL, votes, CORPUS_REV)));
    };

    if (invocation.kind === "refuse-spend") {
      // The cost guard. `decideInvocation` reached this without a usable ceiling, so no billable
      // path was ever entered — the wording only explains which half of the affirmative was missing.
      printPanelReport();
      console.error(
        invocation.reason === "missing-ceiling"
          ? [
              "",
              "--spend: refusing — no ceiling stated. A bare --spend is an intention, not permission.",
              "  The outstanding work — panel, replay and self-consistency sampling together —",
              `  projects $${projected.toFixed(4)}, an estimate on the heuristic above; actuals can exceed it.`,
              `  Re-run with a ceiling you accept paying:  --spend --max-usd=${suggested}`,
              `  Or authorize only the sampling PILOT first ($${pilotProjected.toFixed(4)}), which is what says`,
              `  whether the draws vary at all:  --spend --max-usd=${pilotSuggested} --pilot`,
            ].join("\n")
          : [
              "",
              "--max-usd: refusing — a ceiling must be a positive number of US dollars.",
              `  For this run's $${projected.toFixed(4)} projection, --max-usd=${suggested} would do.`,
              `  For the sampling pilot alone ($${pilotProjected.toFixed(4)}), --max-usd=${pilotSuggested} --pilot would.`,
              "  There is no default: a defaulted spending limit is the one default that could cost",
              "  money.",
            ].join("\n"),
      );
      exitCode = 2;
    } else if (invocation.kind === "spend") {
      // The acceptance criterion, enforced before a cent is spent: two panelists sharing a training
      // lineage would inflate agreement, and the unanimity rate is what every downstream number
      // rests on. A panel that quietly lost its diversity still produces numbers.
      const diversity = checkPanelDiversity(REFERENCE_PANEL);
      if (!diversity.ok) {
        console.error(
          [
            "",
            "--spend: refusing — the reference panel is not provider-diverse.",
            diversity.repeated.length
              ? `  Repeated training lineage: ${diversity.repeated.join(", ")}. Two models from one`
              : "  Fewer than two panelists — a panel that cannot disagree measures nothing.",
            diversity.repeated.length
              ? "  lineage agreeing is not independent evidence, so unanimity would be inflated."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        exitCode = 2;
      } else {
        // Provider keys are hydrated from the harness's own store (keychain / config.env), the
        // same place the CLI reads them.
        await hydrateEnv();
        // Preflight rather than discover it per call: without this, a missing key means paying for
        // two thirds of a panel that can never be unanimous. Each lane's check is gated on that
        // lane HAVING outstanding work — refusing a replay-only run over a key belonging to a panel
        // that is fully cached would refuse a run that could not have called that provider at all.
        const unrunnablePanel = work.cost.totalCalls
          ? REFERENCE_PANEL.filter((p) => !providerKeyPresent(p.model.provider))
          : [];
        // Per MODEL, not per lane: a model whose labels are all cached owes no call, so its
        // provider key is irrelevant and refusing over it would block a run that never needed it.
        const unrunnableReplay = replayPlans
          .filter((p) => p.todo.length > 0 && !providerKeyPresent(p.model.model.provider))
          .map((p) => p.model);
        const missingKey = (id: string, provider: string): string =>
          `  ${id} (${provider}) — set ${envVarsForProvider(provider)[0] ?? "its API key"}`;
        if (unrunnablePanel.length) {
          console.error(
            [
              "",
              "--spend: refusing — a panelist has no provider key, so the panel could never be",
              "  complete and every prompt would be excluded as incomplete.",
              ...unrunnablePanel.map((p) => missingKey(p.model.id, p.model.provider)),
            ].join("\n"),
          );
          exitCode = 2;
        } else if (unrunnableReplay.length) {
          console.error(
            [
              "",
              "--spend: refusing — a replay model has no provider key. Its whole pass would fail,",
              "  and the readout would report a model that was never asked as one that abstained.",
              ...unrunnableReplay.map((m) => missingKey(m.model.id, m.model.provider)),
            ].join("\n"),
          );
          exitCode = 2;
        } else if (
          samplingSpendPlan.todo.length > 0 &&
          !providerKeyPresent(SAMPLED_MODEL.model.provider)
        ) {
          // Gated on this lane HAVING outstanding draws, like the two above: a fully-cached
          // sampling lane owes no call, so its provider key is irrelevant to this run.
          console.error(
            [
              "",
              "--spend: refusing — the sampled classifier has no provider key. Every draw would",
              "  fail, and a lane with no draws reports 'not sampled', which is indistinguishable",
              "  in the output from a degenerate sampler.",
              missingKey(SAMPLED_MODEL.model.id, SAMPLED_MODEL.model.provider),
            ].join("\n"),
          );
          exitCode = 2;
        } else if (outstandingCalls === 0) {
          console.error(
            [
              "",
              `--spend --max-usd=${invocation.maxUsd}: nothing to pay for. Every panelist already has`,
              `  a vote, every replay model a label, and the sampling lane all ${samples} of its draws,`,
              `  on every corpus prompt at ${CORPUS_REV}.`,
              "  Nothing was spent.",
            ].join("\n"),
          );
          printPanelReport();
        } else {
          const verdict = checkSpendCeiling(projected, invocation.maxUsd);
          if (!verdict.ok) {
            console.error(
              [
                "",
                "--spend: refusing — the projection is over the ceiling you stated.",
                `  projected $${verdict.estimateUsd.toFixed(4)} · your ceiling $${verdict.maxUsd.toFixed(4)}`,
                "  Raise the ceiling deliberately, or narrow the corpus with --project / --limit.",
              ].join("\n"),
            );
            exitCode = 2;
          } else {
            console.error(
              [
                "",
                `--spend --max-usd=${invocation.maxUsd}: accepted. ${outstandingCalls} outstanding calls,`,
                `  projected $${projected.toFixed(4)} — ${work.cost.totalCalls} panel` +
                  ` ($${work.cost.totalUsd.toFixed(4)}) · ${replayWork.cost.totalCalls} replay` +
                  ` ($${replayWork.cost.totalUsd.toFixed(4)}) · ${samplingSpendCost.totalCalls} draws` +
                  ` ($${samplingSpendCost.totalUsd.toFixed(4)}${spendPilot ? ", PILOT only" : ""}).`,
                "  Rows are written as they land, so an interrupted run keeps what it paid for.",
              ].join("\n"),
            );
            // ONE guard across both lanes. The ceiling the caller accepted was quoted against the
            // combined projection, so two guards at that number would together permit twice it.
            const guard = makeSpendGuard(invocation.maxUsd);
            const progress = (label: string) => {
              let lastReported = 0;
              return (done: number, total: number, spentUsd: number): void => {
                if (done - lastReported < 25 && done !== total) return;
                lastReported = done;
                console.error(
                  `  … ${label} ${done}/${total} calls · $${spentUsd.toFixed(4)} realized`,
                );
              };
            };
            /** Both lanes stop for the same two reasons, and both exit 2 for them. */
            const reportStops = (
              lane: string,
              noun: string,
              r: {
                ledgerFailed: boolean;
                skippedForLedger: number;
                ceilingHit: boolean;
                skippedForCeiling: number;
                labelled: number;
                unusable: number;
              },
            ): void => {
              if (r.ledgerFailed) {
                // Persistence is the product: the run stopped rather than keep buying labels the
                // ledger would not store.
                console.error(
                  [
                    "",
                    `--spend: STOPPED — the ledger rejected a ${noun} write (${lane}).`,
                    `  ${r.skippedForLedger} calls were never dispatched. Rows written before the`,
                    "  failure are kept; fix the ledger and re-run to finish.",
                  ].join("\n"),
                );
                exitCode = 2;
              }
              if (r.ceilingHit) {
                console.error(
                  [
                    "",
                    `--spend: STOPPED by the live cap (${lane}) — realized spend reached your ceiling.`,
                    `  ${r.skippedForCeiling} calls were never dispatched. The ${r.labelled + r.unusable} ${noun}s`,
                    "  already paid for are in the ledger; re-run with a higher ceiling to finish.",
                  ].join("\n"),
                );
                exitCode = 2;
              }
            };

            // "Persistence is the product" has to bind ACROSS the lanes, not within each. A panel
            // whose writes are failing is a ledger that will reject the replay's rows too, and a
            // second lane starting anyway dispatches a full concurrency width of billable calls
            // before it rediscovers that for itself — buying labels nothing can store, which is
            // the exact outcome the stop rule exists to prevent.
            let ledgerBroken = false;
            if (work.cost.totalCalls > 0) {
              const result = await runPanel({
                plans,
                corpusRev: CORPUS_REV,
                call: makePanelCaller(),
                // Counts and a hash — the prompt text never reaches the ledger or this output.
                record: (v) => db.upsertConsensusVote(v),
                guard,
                onProgress: progress("panel"),
              });
              console.error(`\n${renderPanelRunResult(result, work.cost.totalUsd)}`);
              reportStops("panel", "vote", result);
              ledgerBroken = result.ledgerFailed;
            }

            // MUB-218's replay runs SECOND and under the same guard, so a panel that consumed the
            // ceiling leaves it nothing rather than overspending past it. Ordering matters only
            // here: the reference labels are what the replay is scored against, and buying the
            // subject under test before the thing that judges it would be the wrong half to keep
            // if the money ran out.
            if (ledgerBroken) {
              console.error(
                [
                  "",
                  `--spend: the replay lane was NOT started — ${replayWork.cost.totalCalls} calls never`,
                  "  dispatched. The ledger just rejected a write, so those labels could not have been",
                  "  stored either. Fix the ledger and re-run; nothing was spent on this lane.",
                ].join("\n"),
              );
            } else if (replayWork.cost.totalCalls > 0) {
              const result = await runReplay({
                plans: replayPlans,
                corpusRev: CORPUS_REV,
                call: makeReplayCaller(),
                // A hash and a label. The prompt text never reaches the ledger or this output.
                record: (l) => db.upsertReplayLabel(l),
                guard,
                onProgress: progress("replay"),
              });
              console.error(`\n${renderReplayRunResult(result, replayWork.cost.totalUsd)}`);
              reportStops("replay", "label", result);
              ledgerBroken = ledgerBroken || result.ledgerFailed;
            }

            // MUB-217's sampling runs THIRD, under the SAME guard, for the same reason the replay
            // runs second: if the money runs out, the halves worth keeping are the reference and
            // the subject under test, and a repeatability measurement over a corpus nothing has
            // labelled is the least useful thing to have bought.
            //
            // `makeReplayCaller()` UNCHANGED — a fresh `TaskClassifier` per call. Reusing one
            // instance would serve nine of every ten draws from its per-session memo, at no cost
            // and with no call, and the lane would report a flawless 1.0 self-consistency having
            // asked the model once. That is the single defect most able to look like a finding here.
            if (ledgerBroken) {
              console.error(
                [
                  "",
                  `--spend: the sampling lane was NOT started — ${samplingSpendCost.totalCalls} draws never`,
                  "  dispatched. The ledger just rejected a write, so those draws could not have been",
                  "  stored either. Fix the ledger and re-run; nothing was spent on this lane.",
                ].join("\n"),
              );
            } else if (samplingSpendCost.totalCalls > 0) {
              const result = await runSampling({
                plan: samplingSpendPlan,
                corpusRev: CORPUS_REV,
                call: makeReplayCaller(),
                // A hash, a draw index and a label. The prompt text reaches neither the ledger nor
                // this output.
                record: (s) => db.upsertSelfConsistencySample(s),
                guard,
                onProgress: progress(spendPilot ? "sampling (pilot)" : "sampling"),
              });
              console.error(`\n${renderSamplingRunResult(result, samplingSpendCost.totalUsd)}`);
              reportStops("sampling", "draw", result);
              if (spendPilot) {
                console.error(
                  [
                    "",
                    "  The pilot is in the ledger. Read its verdict — whether the draws actually",
                    "  varied — before authorizing the full lane:",
                    `    bun packages/tui/scripts/classifier_eval.ts --self-consistency --samples=${samples}`,
                    "  A verdict that is not OK prints an abort banner instead of a headline figure,",
                    "  and the full lane is not authorized.",
                  ].join("\n"),
                );
              }
            }
            printPanelReport();
          }
        }
      }
    } else {
      printPanelReport();
    }
  }
} finally {
  db.close();
}
process.exit(exitCode);
