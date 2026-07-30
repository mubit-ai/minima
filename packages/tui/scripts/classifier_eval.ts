/**
 * Classifier evaluation — corpus extraction and cost-guarded dry run (MUB-215), the prompt↔decision
 * correlation (MUB-225), the provider-diverse reference panel (MUB-216), the replay's score and the
 * routing floor it implies (MUB-218), and the override adjudication (MUB-226).
 *
 * The dry run reports the corpus a full evaluation would use and what that run would cost, and is
 * READ-ONLY. `--correlate` reports which prompt caused each recorded routing decision — an inferred
 * link, with its corroboration rate measured rather than assumed. `--score` and `--adjudicate` read
 * the panel's cached labels and report against them. All four read only.
 *
 * `--spend --max-usd=<ceiling>` is the ONE path that bills. It runs the reference panel over the
 * prompts it does not already have labels for, at the current corpus revision, writing each vote to
 * the ledger as it lands. A rerun with everything cached spends nothing and prints the same report,
 * which is what makes MUB-218 and MUB-226 re-runnable without re-invoking the panel.
 *
 *   bun packages/tui/scripts/classifier_eval.ts
 *   bun packages/tui/scripts/classifier_eval.ts --project=minima --limit=5000
 *   bun packages/tui/scripts/classifier_eval.ts --correlate
 *   bun packages/tui/scripts/classifier_eval.ts --score --target-correctness=0.85
 *   bun packages/tui/scripts/classifier_eval.ts --adjudicate
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
  REPLAY_CALL_SPECS,
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
  REFERENCE_PANEL,
  buildPanelReport,
  checkPanelDiversity,
  makePanelCaller,
  makeSpendGuard,
  panelCallSpecs,
  planPanelRun,
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
  "panel (MUB-216), replay score and routing floor (MUB-218), override adjudication (MUB-226).",
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

const { project, dbPath, rowCap } = invocation;

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
    };
    if (invocation.kind === "score") {
      const report = buildScoreReport(reads, {
        scope,
        targetCorrectness: invocation.targetCorrectness,
      });
      console.log(renderReplayScoreReport(report));
      // DERIVED, not asserted: the report itself says whether a replay reached it. A fixed line of
      // prose here would keep claiming "no replay" on the first run that has one.
      if (report.models.every((m) => m.modelId === UNREPLAYED_MODEL_ID)) {
        console.error(
          [
            "",
            "note: no classifier replay is recorded, so every corpus entry reads `unreplayed` and",
            "  no floor can be derived. The reference-label block above is real — it is what the",
            "  panel's cached votes resolve to.",
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
        console.error(
          [
            "",
            `note: no classifier replay is recorded, so ${noReplay} of ${report.candidates}`,
            "  candidates were set aside as `replay gave no usable label`; the rest were set aside",
            "  for the reasons listed above. The candidate and exclusion counts are real —",
            "  they are what the correlation and the cache resolve to.",
          ].join("\n"),
        );
      }
    }
  } else {
    const rows = db.listUserPrompts(project, rowCap);
    const report = buildDryRunReport(rows, {
      scope,
      lengthBoundaries: DEFAULT_LENGTH_BOUNDARIES,
      // The panel's legs come from the panel itself, so the projection and the calls that get
      // billed cannot disagree about which models they mean. The replay leg is MUB-218's and
      // nothing here executes it.
      specs: [...panelCallSpecs(REFERENCE_PANEL), ...REPLAY_CALL_SPECS],
      rowCap,
    });
    // The projection is free, so every invocation gets it — including a refused one. A ceiling can
    // only be chosen against a number, and this is the number.
    console.log(renderDryRunReport(report));
    console.log(
      [
        "  · The panel legs above are MUB-216's chosen reference panel, priced at each model's",
        "    own output allowance (a panelist that reasons server-side bills those hidden tokens",
        "    as output). The replay leg is PROVISIONAL — MUB-218's, and nothing here executes it.",
      ].join("\n"),
    );

    // The panel works over the SAME corpus the report just counted — one definition, called once.
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

    // The ceiling answers what THIS run would spend, not what the whole arc would: a rerun over
    // cached labels costs nothing, and a ceiling chosen against the full-corpus figure would be
    // answering a question the run is not asking.
    const projected = work.cost.totalUsd;
    const suggested = suggestCeilingUsd(projected).toFixed(2);

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
              `  The outstanding panel work projects $${projected.toFixed(4)} — an estimate, on the`,
              "  heuristic above; actuals can exceed it.",
              `  Re-run with a ceiling you accept paying:  --spend --max-usd=${suggested}`,
            ].join("\n")
          : [
              "",
              "--max-usd: refusing — a ceiling must be a positive number of US dollars.",
              `  For this run's $${projected.toFixed(4)} projection, --max-usd=${suggested} would do.`,
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
        const unrunnable = REFERENCE_PANEL.filter((p) => !providerKeyPresent(p.model.provider));
        if (unrunnable.length) {
          // Preflight rather than discover it per call: without this, a missing key means paying
          // for two thirds of a panel that can never be unanimous.
          console.error(
            [
              "",
              "--spend: refusing — a panelist has no provider key, so the panel could never be",
              "  complete and every prompt would be excluded as incomplete.",
              ...unrunnable.map(
                (p) =>
                  `  ${p.model.id} (${p.model.provider}) — set ${envVarsForProvider(p.model.provider)[0] ?? "its API key"}`,
              ),
            ].join("\n"),
          );
          exitCode = 2;
        } else if (work.cost.totalCalls === 0) {
          console.error(
            [
              "",
              `--spend --max-usd=${invocation.maxUsd}: nothing to pay for. Every panelist already has`,
              `  a vote on every corpus prompt at ${CORPUS_REV}. Nothing was spent.`,
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
                `--spend --max-usd=${invocation.maxUsd}: accepted. Running the reference panel over`,
                `  ${work.cost.totalCalls} outstanding calls, projected $${projected.toFixed(4)}.`,
                "  Votes are written as they land, so an interrupted run keeps what it paid for.",
              ].join("\n"),
            );
            const guard = makeSpendGuard(invocation.maxUsd);
            let lastReported = 0;
            const result = await runPanel({
              plans,
              corpusRev: CORPUS_REV,
              call: makePanelCaller(),
              // Counts and a hash — the prompt text never reaches the ledger or this output.
              record: (v) => db.upsertConsensusVote(v),
              guard,
              onProgress: (done, total, spentUsd) => {
                if (done - lastReported < 25 && done !== total) return;
                lastReported = done;
                console.error(`  … ${done}/${total} calls · $${spentUsd.toFixed(4)} realized`);
              },
            });
            console.error(`\n${renderPanelRunResult(result, projected)}`);
            if (result.ledgerFailed) {
              // Persistence is the product: the run stopped rather than keep buying labels the
              // ledger would not store.
              console.error(
                [
                  "",
                  "--spend: STOPPED — the ledger rejected a vote write.",
                  `  ${result.skippedForLedger} calls were never dispatched. Votes written before the`,
                  "  failure are kept; fix the ledger and re-run to finish.",
                ].join("\n"),
              );
              exitCode = 2;
            }
            if (result.ceilingHit) {
              console.error(
                [
                  "",
                  "--spend: STOPPED by the live cap — realized spend reached your ceiling.",
                  `  ${result.skippedForCeiling} calls were never dispatched. The ${result.labelled + result.unusable} votes`,
                  "  already paid for are in the ledger; re-run with a higher ceiling to finish.",
                ].join("\n"),
              );
              exitCode = 2;
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
