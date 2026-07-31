/**
 * Does the classifier's own repeatability predict its correctness, where the self-report does not?
 *
 * READ-ONLY and free. It bills nothing and writes nothing — it crosses two readouts the arc built
 * separately and deliberately never joined: `--score`'s correctness (MUB-218, against the panel)
 * and `--self-consistency`'s repeatability (MUB-217, which reads no reference labels at all,
 * because AC 4 required it to run without them).
 *
 * The question is the owner's: a logprob is `P(label token)` off the sampling distribution, this
 * tree has none (`git grep -i logprob` is empty), and the closest observable proxy in the ledger is
 * the modal-label frequency over 10 draws at the provider's default temperature — a Monte-Carlo
 * estimate of exactly that distribution, at n=10.
 *
 * Thresholds are preregistered in docs/classifier-logprob-proxy-test.md, committed BEFORE this file
 * produced a number. This script does not know them and does not evaluate them: it prints the
 * statistics they are stated in and nothing else, so the pass/fail is read off the document rather
 * than asserted by the code that produced the inputs.
 *
 *   bun packages/tui/scripts/logprob_proxy_probe.ts
 *   bun packages/tui/scripts/logprob_proxy_probe.ts --project=minima --limit=5000
 *
 * Every join uses the instrument's own resolvers — `resolveReferenceVerdicts`, `toModelReplays`,
 * `buildSelfConsistencyReport`, with `promptHash` injected. A hand-rolled lookup here would be a
 * second join that can disagree with `--score`, which is the one failure this arc has repeatedly
 * paid to avoid.
 *
 * NAMED `_probe`, NOT `_test`. Bun's default matcher is `*.test.ts` AND `*_test.ts`, so the obvious
 * name pulls this file into `bun test`, where its top-level code runs against the real user ledger
 * inside a suite whose whole guarantee is that it touches neither disk state nor the network. It
 * was caught by the suite printing this script's own output: 184 test files instead of 183, same
 * 2688 tests. `classifier_eval.ts`'s header states the rule and understates it — "matches only
 * `*.test.ts`" is what makes the second pattern easy to walk into.
 */

import { MinimaDb } from "../src/db/minima_db.ts";
import { CORPUS_REV, REGIME_BOUNDARY_TS, rate } from "../src/minima/classifier_eval.ts";
import {
  MIN_REPORTABLE_SUPPORT,
  resolveReferenceVerdicts,
  segmentCorpus,
} from "../src/minima/classifier_eval_score.ts";
import {
  OVERRIDE_REPLAY_MODELS,
  REFERENCE_CONSENSUS,
} from "../src/minima/classifier_eval_wiring.ts";
import { REPLAY_MODELS, toModelReplays } from "../src/minima/classifier_replay.ts";
import { buildSelfConsistencyReport } from "../src/minima/classifier_self_consistency_report.ts";
import { REFERENCE_PANEL, promptHash, toCachedVotes } from "../src/minima/consensus_panel.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const project = flag("project") ?? null;
const rowCap = Number(flag("limit") ?? 20000);
const dbPath = flag("db");

const db = dbPath ? new MinimaDb(dbPath) : new MinimaDb();

const prompts = db.listUserPrompts(project, rowCap);
const votes = db.listConsensusVotes(CORPUS_REV);
const replayLabels = db.listReplayLabels(CORPUS_REV);
const samples = db.listSelfConsistencySamples(CORPUS_REV);

const corpus = segmentCorpus(prompts, REGIME_BOUNDARY_TS);

// --- the three sides of the join, each via the shipped resolver -------------------------------

const reference = resolveReferenceVerdicts(
  corpus.map((e) => e.text),
  toCachedVotes(votes, REFERENCE_PANEL),
  { corpusRev: CORPUS_REV, hashOf: promptHash, consensus: REFERENCE_CONSENSUS },
);

// The SHIPPED classifier alone. `gpt-4o-mini` is in REPLAY_MODELS to price the model switch and is
// never what production calls, so including it would adjudicate a channel that cannot open.
const replayRes = toModelReplays(
  corpus.map((e) => e.text),
  replayLabels,
  OVERRIDE_REPLAY_MODELS,
  { corpusRev: CORPUS_REV, hashOf: promptHash },
);
const replay = replayRes.replays[0];
const replayByText = new Map(replay ? replay.labels.map((l) => [l.text, l.classification]) : []);

// The OTHER replayed model, resolved over the SAME rows. Not part of the proxy test: it is here
// because whether a logprob is obtainable at all turned out to depend on which provider serves the
// classifier, so "what does the model that CAN return one score" became a decision-relevant figure.
// `--score` prints 143/181 for it against 148/167 for the shipped model, and those denominators are
// not the same set — gpt-4o-mini never abstains, the shipped model abstained 14 times. Comparing
// them directly is the mis-denomination this arc has already been caught by once.
const altRes = toModelReplays(
  corpus.map((e) => e.text),
  replayLabels,
  REPLAY_MODELS.slice(1, 2),
  { corpusRev: CORPUS_REV, hashOf: promptHash },
);
const altByText = new Map(
  altRes.replays[0] ? altRes.replays[0].labels.map((l) => [l.text, l.classification]) : [],
);

const self = buildSelfConsistencyReport(
  { corpus: prompts, samples },
  { scope: project ?? "all projects", samples: 10, corpusRev: CORPUS_REV, hashOf: promptHash },
);
const selfByPrefix = new Map(self.perPrompt.map((p) => [p.hashPrefix, p]));

// --- the joined rows ---------------------------------------------------------------------------

interface Row {
  /**
   * IN-MEMORY ONLY, and a JOIN KEY ONLY — never printed, never written. Same rule as
   * `ReplayLabel.text`: the corpus is the owner's own development traffic, the ledger stores a hash
   * (ADR 0001/0008/0009), and the only reason the text is in this process at all is that the hash is
   * one-way, so re-hashing the live text is the sole direction the join can run.
   */
  readonly text: string;
  readonly segment: string;
  readonly referenceLabel: string;
  readonly replayLabel: string;
  readonly correct: boolean;
  /** PREDICTOR: modal task-type frequency over this prompt's own draws. The logprob proxy. */
  readonly modalFreq: number;
  /** Secondary predictor: modal (task_type, difficulty) pair frequency. */
  readonly pairFreq: number;
  /** CONTROL: the replay row's raw self-report, pre-floor. What the readout showed is flat. */
  readonly selfReport: number;
  /** The majority label over the draws — a different intervention, reported not gated. */
  readonly modalLabel: string | null;
  readonly draws: number;
}

const rows: Row[] = [];
let noReference = 0;
let noReplayLabel = 0;
let replayAbstained = 0;
let noDraws = 0;
let noModalLabel = 0;

for (const entry of corpus) {
  const ref = reference.verdicts.get(entry.text);
  if (ref === undefined) {
    noReference += 1;
    continue;
  }
  if (!replayByText.has(entry.text)) {
    noReplayLabel += 1;
    continue;
  }
  const cls = replayByText.get(entry.text) ?? null;
  if (cls === null) {
    replayAbstained += 1;
    continue;
  }
  const sc = selfByPrefix.get(promptHash(entry.text).slice(0, 12));
  if (sc === undefined) {
    noDraws += 1;
    continue;
  }
  if (sc.modalTaskType === null || sc.selfReport === null) {
    noModalLabel += 1;
    continue;
  }
  rows.push({
    text: entry.text,
    segment: entry.segment,
    referenceLabel: ref.taskType,
    replayLabel: cls.taskType,
    correct: cls.taskType === ref.taskType,
    modalFreq:
      sc.taskTypeFrequency.rate.d > 0
        ? sc.taskTypeFrequency.rate.n / sc.taskTypeFrequency.rate.d
        : 0,
    pairFreq: sc.pairFrequency.rate.d > 0 ? sc.pairFrequency.rate.n / sc.pairFrequency.rate.d : 0,
    selfReport: cls.confidence,
    modalLabel: sc.modalTaskType,
    draws: sc.draws,
  });
}

// --- statistics ---------------------------------------------------------------------------------

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
const pp = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}` : "n/a");

const correctRows = rows.filter((r) => r.correct);
const wrongRows = rows.filter((r) => !r.correct);

/** Mean on correct − mean on incorrect, in percentage points. The preregistered `sep(x)`. */
function separation(pick: (r: Row) => number): number {
  return mean(correctRows.map(pick)) - mean(wrongRows.map(pick));
}

/**
 * P(a random correct row scores above a random incorrect one), ties at 0.5 — the rank statistic.
 *
 * Reported beside `separation` because it is invariant to the predictor's scale and to binning,
 * and the two predictors here are on scales that are only superficially comparable: one is a
 * frequency over ten draws, the other is a number the model wrote about itself. A difference of
 * means can be moved by one outlier; this cannot.
 */
function auc(pick: (r: Row) => number): number {
  if (correctRows.length === 0 || wrongRows.length === 0) return Number.NaN;
  let wins = 0;
  for (const c of correctRows) {
    for (const w of wrongRows) {
      const a = pick(c);
      const b = pick(w);
      wins += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return wins / (correctRows.length * wrongRows.length);
}

interface Bin {
  readonly label: string;
  readonly lo: number;
  readonly hi: number;
}
const FREQ_BINS: readonly Bin[] = [
  { label: "<0.60", lo: Number.NEGATIVE_INFINITY, hi: 0.6 },
  { label: "0.60-<0.80", lo: 0.6, hi: 0.8 },
  { label: "0.80-<1.00", lo: 0.8, hi: 1.0 },
  { label: "1.00 (unanimous)", lo: 1.0, hi: Number.POSITIVE_INFINITY },
];
const SELF_BINS: readonly Bin[] = [
  { label: "<0.60", lo: Number.NEGATIVE_INFINITY, hi: 0.6 },
  { label: "0.60-<0.75", lo: 0.6, hi: 0.75 },
  { label: "0.75-<0.90", lo: 0.75, hi: 0.9 },
  { label: ">=0.90", lo: 0.9, hi: Number.POSITIVE_INFINITY },
];

function binTable(bins: readonly Bin[], pick: (r: Row) => number): string[] {
  const out: string[] = [];
  for (const b of bins) {
    const cell = rows.filter((r) => pick(r) >= b.lo && pick(r) < b.hi);
    const n = cell.filter((r) => r.correct).length;
    const r = rate(n, cell.length);
    const mark = cell.length < MIN_REPORTABLE_SUPPORT ? " †" : "";
    const pct = cell.length < MIN_REPORTABLE_SUPPORT ? "withheld" : `${r.pct?.toFixed(1)}%`;
    out.push(
      `    ${b.label.padEnd(18)} ${String(n).padStart(3)}/${String(cell.length).padEnd(4)} ${pct.padStart(9)}${mark}`,
    );
  }
  return out;
}

/**
 * Every threshold a gate could sit at, and what dropping everything below it would cost and save.
 *
 * `moved` is the preregistered L2 reach: entries whose admit/drop decision the gate controls. Read
 * beside `net`, never instead of it — a gate that moves 100 entries by dropping 60 right answers
 * has reach and negative value, and reach alone is what F4 measured for the floor in force.
 */
function sweep(pick: (r: Row) => number): string[] {
  const cuts = [...new Set(rows.map(pick))].sort((a, b) => a - b);
  const out: string[] = [];
  for (const t of cuts) {
    const dropped = rows.filter((r) => pick(r) < t);
    if (dropped.length === 0) continue;
    const wrongDropped = dropped.filter((r) => !r.correct).length;
    const rightDropped = dropped.length - wrongDropped;
    const kept = rows.filter((r) => pick(r) >= t);
    const keptAcc = rate(kept.filter((r) => r.correct).length, kept.length);
    const net = wrongDropped - rightDropped;
    const netCell = `   net ${net >= 0 ? "+" : ""}${net}`.padEnd(11);
    out.push(
      `    >= ${t.toFixed(2)}   moved ${String(dropped.length).padStart(3)}` +
        `   dropped W ${String(wrongDropped).padStart(3)} / R ${String(rightDropped).padStart(3)}` +
        `${netCell}   kept ${keptAcc.n}/${keptAcc.d} (${keptAcc.pct?.toFixed(1) ?? "n/a"}%)`,
    );
  }
  return out;
}

// --- output --------------------------------------------------------------------------------------

const modalAgrees = rows.filter((r) => r.modalLabel === r.referenceLabel).length;
const replayAcc = rate(correctRows.length, rows.length);

console.log(
  [
    "logprob-proxy test — does repeatability predict correctness where the self-report does not?",
    `  corpus rev ${CORPUS_REV} · scope ${project ?? "all projects"} · model ${self.modelId}`,
    "  READ-ONLY. Thresholds preregistered in docs/classifier-logprob-proxy-test.md (commit 0445e9d).",
    "",
    "POPULATION — the intersection of reference label, shipped replay label, and >=1 draw",
    `  corpus entries                    ${corpus.length}`,
    `  no reference label (split/unvoted/incomplete)  -${noReference}`,
    `  no replay row                                  -${noReplayLabel}`,
    `  replay abstained (stored null)                 -${replayAbstained}`,
    `  no self-consistency draws                      -${noDraws}`,
    `  draws all abstained / no self-report           -${noModalLabel}`,
    `  ==> JOINED                        ${rows.length}`,
    `      correct ${correctRows.length} · incorrect ${wrongRows.length} · accuracy ${replayAcc.pct?.toFixed(1)}%`,
    "",
    "L1 — SEPARATION (mean on correct − mean on incorrect, percentage points)",
    `  modal task-type frequency  (predictor)   ${pp(separation((r) => r.modalFreq)).padStart(7)}  pts` +
      `   [correct ${pp(mean(correctRows.map((r) => r.modalFreq)))}%  incorrect ${pp(mean(wrongRows.map((r) => r.modalFreq)))}%]`,
    `  modal PAIR frequency       (secondary)   ${pp(separation((r) => r.pairFreq)).padStart(7)}  pts` +
      `   [correct ${pp(mean(correctRows.map((r) => r.pairFreq)))}%  incorrect ${pp(mean(wrongRows.map((r) => r.pairFreq)))}%]`,
    `  raw self-report            (CONTROL)     ${pp(separation((r) => r.selfReport)).padStart(7)}  pts` +
      `   [correct ${pp(mean(correctRows.map((r) => r.selfReport)))}%  incorrect ${pp(mean(wrongRows.map((r) => r.selfReport)))}%]`,
    "",
    "  rank statistic — P(correct ranks above incorrect), 0.500 = no information",
    `    modal task-type frequency   ${auc((r) => r.modalFreq).toFixed(3)}`,
    `    modal pair frequency        ${auc((r) => r.pairFreq).toFixed(3)}`,
    `    raw self-report             ${auc((r) => r.selfReport).toFixed(3)}`,
    "",
    `L3 — ACCURACY BY MODAL FREQUENCY (cells under n=${MIN_REPORTABLE_SUPPORT} withheld, marked †)`,
    ...binTable(FREQ_BINS, (r) => r.modalFreq),
    "",
    "  the same rows binned on the CONTROL, for the comparison L1 is stated in",
    ...binTable(SELF_BINS, (r) => r.selfReport),
    "",
    "L2 — REACH: what a gate on modal frequency would move",
    ...sweep((r) => r.modalFreq),
    "",
    "  the control's sweep, same rows",
    ...sweep((r) => r.selfReport),
    "",
    "SECONDARY (reported, not gated) — majority vote over the draws vs the single replay label",
    `  single replay label  ${replayAcc.n}/${replayAcc.d} (${replayAcc.pct?.toFixed(1)}%)`,
    `  modal label (10 draws) ${modalAgrees}/${rows.length} (${rate(modalAgrees, rows.length).pct?.toFixed(1)}%)`,
    `  difference ${modalAgrees - correctRows.length >= 0 ? "+" : ""}${modalAgrees - correctRows.length} rows   — 10x inference cost, and NOT a logprob. A different intervention from MUB-220-223.`,
    "",
    "LIKE-FOR-LIKE: the shipped model vs the one whose provider CAN return a logprob",
    "  (same joined rows, same reference. `--score`'s 148/167 and 143/181 are NOT this comparison:",
    "   gpt-4o-mini never abstains, so its denominator carries 14 rows the shipped model declined.)",
    ...(() => {
      const both = rows.filter((r) => (altByText.get(r.text) ?? null) !== null);
      const shipped = both.filter((r) => r.correct).length;
      const alt = both.filter((r) => altByText.get(r.text)?.taskType === r.referenceLabel).length;
      const agree = both.filter((r) => altByText.get(r.text)?.taskType === r.replayLabel).length;
      return [
        `  rows where BOTH produced a label       ${both.length}`,
        `    claude-haiku-4-5 (shipped, NO logprob available)   ${shipped}/${both.length} (${rate(shipped, both.length).pct?.toFixed(1)}%)`,
        `    gpt-4o-mini      (logprob available)               ${alt}/${both.length} (${rate(alt, both.length).pct?.toFixed(1)}%)`,
        `    difference ${alt - shipped >= 0 ? "+" : ""}${alt - shipped} rows` +
          `   · the two models agree with each other on ${agree}/${both.length} (${rate(agree, both.length).pct?.toFixed(1)}%)`,
      ];
    })(),
    "",
    "BY SEGMENT",
    ...["before", "after", "spanning"].map((s) => {
      const cell = rows.filter((r) => r.segment === s);
      if (cell.length === 0) return `  ${s.padEnd(10)} (none)`;
      const c = cell.filter((r) => r.correct);
      const w = cell.filter((r) => !r.correct);
      const sep = mean(c.map((r) => r.modalFreq)) - mean(w.map((r) => r.modalFreq));
      const mark = cell.length < MIN_REPORTABLE_SUPPORT ? " †" : "";
      return `  ${s.padEnd(10)} n=${String(cell.length).padStart(3)}   acc ${rate(c.length, cell.length).pct?.toFixed(1)}%   sep ${pp(sep)} pts${mark}`;
    }),
  ].join("\n"),
);

db.close();
