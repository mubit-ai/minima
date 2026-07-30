/**
 * Classifier evaluation — corpus extraction and cost-guarded dry run (MUB-215).
 *
 * Reports the corpus a full evaluation would use and what that run would cost, and spends
 * nothing doing it. This is the tracer bullet for the measurement arc: it proves the
 * ledger → corpus → report path end to end before any money is committed.
 *
 *   bun packages/tui/scripts/classifier_eval.ts
 *   bun packages/tui/scripts/classifier_eval.ts --project=minima --limit=5000
 *
 * This is the SHELL, and it is a dispatcher only: argv interpretation, the cost guard, all
 * counting and all rendering live in the pure core (`src/minima/classifier_eval.ts`), which is
 * unit-tested with no ledger and no network. What is left here is opening a ledger, one read, and
 * printing — nothing a reported number depends on.
 *
 * It lives under `scripts/` deliberately: `bun test` matches only `*.test.ts`, so nothing here is
 * reachable from the hermetic suite. The full evaluation will make real network calls by design,
 * which is why the only path to spending is an explicit `--spend`.
 */

import { existsSync } from "node:fs";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  DEFAULT_CALL_SPECS,
  DEFAULT_LENGTH_BOUNDARIES,
  buildDryRunReport,
  decideInvocation,
  renderDryRunReport,
} from "../src/minima/classifier_eval.ts";

const HELP = [
  "Classifier eval — dry run (MUB-215).",
  "",
  "  --project=<key>   scope the corpus to one project's runs (default: whole ledger)",
  "  --limit=<n>       cap rows read, most recent first (default 20000)",
  "  --db=<path>       read a specific ledger (default: the harness's own)",
  "  --spend           opt in to a billable run (not implemented yet — see MUB-216 onward)",
  "  --help            this message",
].join("\n");

const invocation = decideInvocation(process.argv.slice(2));

if (invocation.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

// The cost guard. `decideInvocation` refuses --spend ahead of every other flag, and today there is
// no billable path at all: the panel and replay legs land in MUB-216 onward.
if (invocation.kind === "refuse-spend") {
  console.error(
    [
      "--spend: refusing — the spending path is not implemented yet.",
      "The reference panel (MUB-216) and the replay (MUB-218) are not built, so there is nothing",
      "to spend on. Run without --spend for the corpus and the projected cost.",
    ].join("\n"),
  );
  process.exit(2);
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
try {
  const rows = db.listUserPrompts(project, rowCap);
  const report = buildDryRunReport(rows, {
    scope: project ? `project ${project} · ${db.path}` : `whole ledger · ${db.path}`,
    lengthBoundaries: DEFAULT_LENGTH_BOUNDARIES,
    specs: DEFAULT_CALL_SPECS,
    rowCap,
  });
  console.log(renderDryRunReport(report));
  // Specific to the legs THIS shell chose, so it belongs here rather than in the report.
  console.log(
    [
      "  · The call legs above are PROVISIONAL — MUB-216 chooses the reference panel. Their",
      "    prices were copied from the harness's model registry and nothing keeps them in sync,",
      "    which is why each leg prints the prices it was costed at.",
    ].join("\n"),
  );
} finally {
  db.close();
}
