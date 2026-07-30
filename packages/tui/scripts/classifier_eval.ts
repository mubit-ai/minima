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
 * This is the SHELL. It reads the ledger, prints, and holds no logic that any reported number
 * depends on — all filtering, grouping, stratification and counting lives in the pure core
 * (`src/minima/classifier_eval.ts`), which is unit-tested with no ledger and no network.
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
  renderDryRunReport,
} from "../src/minima/classifier_eval.ts";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (flag("help")) {
  console.log(
    [
      "Classifier eval — dry run (MUB-215).",
      "",
      "  --project=<key>   scope the corpus to one project's runs (default: whole ledger)",
      "  --limit=<n>       cap rows read (default 20000)",
      "  --db=<path>       read a specific ledger (default: the harness's own)",
      "  --spend           opt in to a billable run (not implemented yet — see MUB-216 onward)",
      "  --help            this message",
    ].join("\n"),
  );
  process.exit(0);
}

// The cost guard. There is no path to a billable call that does not pass through this flag, and
// today there is no billable path at all: the panel and replay legs land in MUB-216 onward.
if (flag("spend")) {
  console.error(
    [
      "--spend: refusing — the spending path is not implemented yet.",
      "The reference panel (MUB-216) and the replay (MUB-218) are not built, so there is nothing",
      "to spend on. Run without --spend for the corpus and the projected cost.",
    ].join("\n"),
  );
  process.exit(2);
}

const dbPath = option("db");
// Opening a ledger creates it when absent, so a typo'd --db would silently report a zero corpus
// as though it were a finding. Refuse instead. (Opening an EXISTING ledger runs the harness's
// normal append-only migrations, exactly as a harness launch would.)
if (dbPath !== null && !existsSync(dbPath)) {
  console.error(
    `--db=${dbPath}: no such ledger. Refusing to create one and report an empty corpus.`,
  );
  process.exit(2);
}

const project = option("project");
const rawLimit = Number(option("limit") ?? 20000);
const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20000;

const db = dbPath ? new MinimaDb(dbPath) : new MinimaDb();
try {
  const rows = db.listUserPrompts(project, limit);
  const report = buildDryRunReport(rows, {
    scope: project ? `project ${project} · ${db.path}` : `whole ledger · ${db.path}`,
    lengthBoundaries: DEFAULT_LENGTH_BOUNDARIES,
    specs: DEFAULT_CALL_SPECS,
  });
  console.log(renderDryRunReport(report));
  console.log(
    [
      "",
      "Caveats, which travel with every figure above:",
      "  · The call legs are PROVISIONAL — MUB-216 chooses the reference panel. Prices shown are",
      "    the harness's own registered per-Mtok figures for those models.",
      "  · This corpus is one developer's traffic, a few hundred prompts. Aggregate figures mean",
      "    something; per-task-type figures mostly will not.",
      `  · Rows read were capped at ${limit}. Raise --limit if the count above equals that cap.`,
    ].join("\n"),
  );
} finally {
  db.close();
}
