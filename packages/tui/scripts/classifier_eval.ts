/**
 * Classifier evaluation — corpus extraction and cost-guarded dry run (MUB-215), plus the
 * prompt↔decision correlation (MUB-225). Both modes read only, and nothing here spends yet: the
 * spend affirmative is wired to the cost guard, but no billable leg exists (MUB-216 onward).
 *
 * The dry run reports the corpus a full evaluation would use and what that run would cost. It is
 * the tracer bullet for the measurement arc: it proves the ledger → corpus → report path end to
 * end before any money is committed. `--correlate` reports which prompt caused each recorded
 * routing decision — an inferred link, with its corroboration rate measured rather than assumed.
 *
 *   bun packages/tui/scripts/classifier_eval.ts
 *   bun packages/tui/scripts/classifier_eval.ts --project=minima --limit=5000
 *   bun packages/tui/scripts/classifier_eval.ts --correlate
 *
 * This is the SHELL, and it is a dispatcher only: argv interpretation, the cost guard, all
 * counting and all rendering live in the pure cores (`src/minima/classifier_eval.ts` and
 * `src/minima/classifier_eval_correlate.ts`), which are unit-tested with no ledger and no network.
 * What is left here is opening a ledger, the reads, and printing — nothing a reported number
 * depends on.
 *
 * It lives under `scripts/` deliberately: `bun test` matches only `*.test.ts`, so nothing here is
 * reachable from the hermetic suite. The full evaluation will make real network calls by design,
 * which is why the only path to spending is `--spend` with an explicit `--max-usd` ceiling.
 */

import { existsSync } from "node:fs";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  DEFAULT_CALL_SPECS,
  DEFAULT_LENGTH_BOUNDARIES,
  buildDryRunReport,
  checkSpendCeiling,
  decideInvocation,
  renderDryRunReport,
  suggestCeilingUsd,
} from "../src/minima/classifier_eval.ts";
import {
  buildCorrelationReport,
  renderCorrelationReport,
} from "../src/minima/classifier_eval_correlate.ts";

const HELP = [
  "Classifier eval — dry run (MUB-215) and prompt↔decision correlation (MUB-225).",
  "",
  "  --correlate       report which prompt caused each recorded decision, and how much to",
  "                    trust that claim (a heuristic, not a join). Reads only.",
  "  --project=<key>   scope the corpus to one project's runs (default: whole ledger)",
  "  --limit=<n>       cap rows read, most recent first (default 20000)",
  "  --db=<path>       read a specific ledger (default: the harness's own)",
  "  --spend           opt in to a billable run — REQUIRES --max-usd; refused on its own",
  "  --max-usd=<usd>   the ceiling you accept paying. The run refuses if the projection",
  "                    exceeds it. No default: a defaulted spending limit could cost money",
  "  --help            this message",
  "",
  "Exit codes: 0 ok · 2 refused (the cost guard) · 3 asked for a path that is not built yet.",
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
  } else {
    const rows = db.listUserPrompts(project, rowCap);
    const report = buildDryRunReport(rows, {
      scope,
      lengthBoundaries: DEFAULT_LENGTH_BOUNDARIES,
      specs: DEFAULT_CALL_SPECS,
      rowCap,
    });
    // The projection is free, so every invocation gets it — including a refused one. A ceiling can
    // only be chosen against a number, and this is the number.
    console.log(renderDryRunReport(report));
    // Specific to the legs THIS shell chose, so it belongs here rather than in the report.
    console.log(
      [
        "  · The call legs above are PROVISIONAL — MUB-216 chooses the reference panel. Their",
        "    prices were copied from the harness's model registry and nothing keeps them in sync,",
        "    which is why each leg prints the prices it was costed at.",
      ].join("\n"),
    );

    const projected = report.cost.totalUsd;
    const suggested = suggestCeilingUsd(projected).toFixed(2);

    if (invocation.kind === "refuse-spend") {
      // The cost guard. `decideInvocation` reached this without a usable ceiling, so no billable
      // path was ever entered — the wording only explains which half of the affirmative was missing.
      console.error(
        invocation.reason === "missing-ceiling"
          ? [
              "",
              "--spend: refusing — no ceiling stated. A bare --spend is an intention, not permission.",
              `  A full run over this corpus projects $${projected.toFixed(4)} — an estimate, on the`,
              "  heuristic above; actuals can exceed it.",
              `  Re-run with a ceiling you accept paying:  --spend --max-usd=${suggested}`,
            ].join("\n")
          : [
              "",
              "--max-usd: refusing — a ceiling must be a positive number of US dollars.",
              `  For this corpus's $${projected.toFixed(4)} projection, --max-usd=${suggested} would do.`,
              "  There is no default: a defaulted spending limit is the one default that could cost",
              "  money.",
            ].join("\n"),
      );
      exitCode = 2;
    } else if (invocation.kind === "spend") {
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
        // Accepted, and there is still nothing to bill: this shell owns the guard, not the legs.
        // MUB-216 onward add the paid execution here — the decision above does not change for them.
        console.error(
          [
            "",
            `--spend --max-usd=${invocation.maxUsd}: accepted — and there is nothing to spend it on yet.`,
            "  The projection is within your ceiling, but the reference panel (MUB-216) and the replay",
            "  (MUB-218) are not built, so no billable leg exists. Nothing was spent.",
          ].join("\n"),
        );
        exitCode = 3;
      }
    }
  }
} finally {
  db.close();
}
process.exit(exitCode);
