/**
 * Classifier-evaluation pure core (MUB-215).
 *
 * Every claim the evaluation's report makes is a counting claim — a distinct count, a
 * denominator, a stratum boundary, an exclusion tally — and every one of them can be silently
 * wrong. So all filtering, grouping, stratification and counting lives HERE, in total functions
 * over plain arrays with no I/O, and the shell (`scripts/classifier_eval.ts`) holds no logic that
 * a reported number depends on.
 *
 * This module is PURE: no filesystem, no ledger, no network, no clock. Same shape as the
 * plan-verification factor engine (`big_plan_factors.ts`), and tested the same way — fixtures
 * declared inline, one field overridden per case.
 */
import type { UserPromptRow } from "../db/minima_db.ts";
import { isHarnessSteerText } from "./stop_gate.ts";

// ---------------------------------------------------------------------------
// Corpus revision. What "the corpus" means, versioned — so cached work cannot outlive it.
// ---------------------------------------------------------------------------

/**
 * Which corpus the counting below describes (ADR 0001).
 *
 * `partitionSteerText` delegates to the SHIPPED steer predicate, so what counts as a prompt at
 * all is decided elsewhere and can change without a line of this file changing. When it does, the
 * corpus becomes a different set of prompts — and anything expensive that was derived from the old
 * set (the reference panel's paid labels, MUB-216) is then attributed to a corpus that no longer
 * exists. Stamping that work with this revision turns a silent misattribution into a cache miss.
 *
 * BUMP THIS whenever `isHarnessSteerText` changes, or whenever the rule for what enters the corpus
 * changes in any other way. It is a hand-maintained constant on purpose: no probe of the predicate
 * can detect a NEW steer kind, because new steer text is by definition text the old probes never
 * contained. The cost of forgetting is paying for labels twice, or worse, not paying and reading
 * stale ones — so it is stated where the predicate's consumers can see it.
 *
 *   r1 — the 243-prompt corpus, before the observer's steer prefix entered the predicate.
 *   r2 — 238 prompts. ADR 0002 widened `isHarnessSteerText` to `[observer] `; five distinct
 *        observer steers left the corpus and raw steer exclusions went 41 → 46.
 */
export const CORPUS_REV = "r2-observer-steer";

/**
 * The instant the SERVICE's classifier changed — 2026-07-22T16:41:36Z, in UNIX seconds, the unit
 * every `ts` in this ledger is recorded in.
 *
 * A fact about the DEPLOYMENT, not about the data: it is when GitHub published release v0.14.0, and
 * publishing a release is what triggers the prod deploy. v0.14.0 is the first release containing
 * `c071670 fix(classifier): web/build vocabulary, scope-aware difficulty, confidence-gated neighbor
 * refinement, cold-start margin (#223)`. Held here rather than derived, because inferring a regime
 * boundary from the rates it is meant to explain is the same mistake as averaging across it.
 *
 * It is what MUB-224 quoted in prose and nothing in the tree backed: over this ledger's 494 routing
 * decisions it splits 321 before / 173 after. Over the 238-prompt corpus the split is 159 before /
 * 77 after / 2 spanning.
 *
 * MUB-226's motivating catch-all figures reproduce at exactly this instant — 110/321 (34.3%) then
 * 129/173 (74.6%) — but READ THE DENOMINATORS. The "before" 321 includes 68 pinned/offline rows
 * that never asked the service and 69 rows carrying no task type at all; the "after" 173 has none
 * of either. So 34.3% is a catch-all rate over a population that is partly rows the service never
 * labelled, and the gap it opens against 74.6% is partly that asymmetry. Like for like — routed to
 * the service AND carrying a label — it is 110/252 (43.7%) then 129/173 (74.6%). The step is real
 * either way; the quoted pair is not the comparison it sounds like.
 *
 * Three more things a reader of any figure segmented on it should carry. ADR 0003 settles why the
 * constant stays here rather than moving to the author change below, and what the data cannot say:
 *
 *   · THIS instant is not identified by the ledger. There are no decisions between
 *     2026-07-22T14:28:08Z and 2026-07-23T09:33:57Z, so every instant in that 19-hour gap —
 *     including a naive midnight cut — produces the same 321/173. The release record pins it; the
 *     data cannot. That is true of this boundary only: the author change below IS data-identifiable,
 *     because the server stamps its own provenance on the rows it serves.
 *   · A SECOND service classifier change sits inside the later regime: the classifier program
 *     (agreement telemetry, cluster-key-space versioning, and the embed classifier served behind
 *     the dispatcher) first shipped in v0.14.2, published 2026-07-23T16:20:11Z — ts 1784823611,
 *     which splits the same decisions 452/42. That one is a change of label AUTHOR where this one
 *     is a revision by the same author, so "two regimes" is an approximation with a third inside it.
 *     It is the weaker cut, not the stronger one: like for like the catch-all rate barely moves
 *     across it (217/383, 56.7% then 22/42, 52.4%), and it leaves MUB-226's adjudication 154 corpus
 *     entries before and 22 after — every task type in those 22 at single-digit support. Segmenting
 *     the AUTHOR question is better served by the 39 rows the server stamped with
 *     `cluster_key_version` and `classification_profile.heuristic_task_type`, where the two authors
 *     are directly observable disagreeing on 24 of 39 (61.5%).
 *   · The catch-all rate had already risen BEFORE this instant, and not because of a classifier.
 *     `classify.py` is byte-identical from 2026-07-02 until `c071670`, yet across that ONE fixed
 *     labeller the rate steps 42/158 (26.6%) on 2026-07-03..07-20 to 68/94 (72.3%) on
 *     07-21..this instant — routed to the service AND carrying a label, both sides. That 45.7-point
 *     step under an unchanged labeller is larger than the 30.9-point step across this boundary, so
 *     the traffic moves this rate at least as hard as the classifier does. Each regime is also a
 *     disjoint block of working days (12 days / 1 day / 3 days), so no segment difference here can
 *     be attributed to the label author at all.
 */
export const REGIME_BOUNDARY_TS = 1784738496;

// ---------------------------------------------------------------------------
// Rates. Every reported rate carries its denominator — structurally, not by convention.
// ---------------------------------------------------------------------------

/**
 * A rate that cannot be quoted without its denominator: the percentage is only ever reachable
 * alongside `n` and `d`, and is `null` when there is nothing to divide by. This corpus is a few
 * hundred prompts of one developer's traffic, so a bare percentage over single-digit support is
 * the most likely way for this evaluation to mislead. Making the denominator inseparable is what
 * prevents that, rather than remembering to print it.
 */
export interface Rate {
  readonly n: number;
  readonly d: number;
  /** Percentage to one decimal, or null when the denominator is zero. */
  readonly pct: number | null;
}

/** Build a {@link Rate}. Total: a zero denominator yields `pct: null`, never NaN or Infinity. */
export function rate(n: number, d: number): Rate {
  if (d <= 0) return { n, d, pct: null };
  return { n, d, pct: Math.round((n / d) * 1000) / 10 };
}

/** Render a rate as `n/d (pct%)`, or `n/d (n/a)` when there is no denominator to divide by. */
export function formatRate(r: Rate): string {
  return `${r.n}/${r.d} (${r.pct === null ? "n/a" : `${r.pct.toFixed(1)}%`})`;
}

/**
 * Does this row carry a prompt at all? One predicate, used by every counting function here, so a
 * whitespace-only row cannot be a prompt to one of them and not to another — an inconsistency
 * that would let the same row be both counted and excluded.
 */
export function hasPromptText(row: UserPromptRow): boolean {
  return row.text !== null && row.text.trim() !== "";
}

/**
 * Split rows by which agent was asked.
 *
 * The client-side classifier runs only for the lead agent — the runtime gates the call on
 * `agentId === null`. A sub-agent's brief is therefore traffic the classifier under test never
 * labels, and scoring it against reference labels would measure something production never does.
 * Set aside rather than dropped, so the size of the exclusion stays visible in the readout.
 */
export function partitionLeadPrompts(rows: readonly UserPromptRow[]): {
  lead: UserPromptRow[];
  subagent: UserPromptRow[];
} {
  const lead: UserPromptRow[] = [];
  const subagent: UserPromptRow[] = [];
  for (const row of rows) {
    if (row.agent_id === null) lead.push(row);
    else subagent.push(row);
  }
  return { lead, subagent };
}

/**
 * Split recorded user-role rows into the corpus and the harness-authored steer messages.
 *
 * Turn-budget warnings, doom-loop nudges, stop-gate continuations and stream-tripwire reminders
 * are all written into the user role, so they would otherwise pollute a corpus of things a
 * developer actually asked for. The shipped predicate decides — never a prefix check
 * re-implemented here, which would drift the moment a new steer kind is added.
 *
 * A null payload text is neither: it cannot be steer text and it cannot be a prompt, so it is
 * reported separately by the caller rather than silently landing in either bucket.
 */
export function partitionSteerText(rows: readonly UserPromptRow[]): {
  corpus: UserPromptRow[];
  excluded: UserPromptRow[];
} {
  const corpus: UserPromptRow[] = [];
  const excluded: UserPromptRow[] = [];
  for (const row of rows) {
    if (!hasPromptText(row)) continue;
    if (isHarnessSteerText(row.text as string)) excluded.push(row);
    else corpus.push(row);
  }
  return { corpus, excluded };
}

/** One distinct prompt in the corpus, with how many recorded messages carried that exact text. */
export interface DistinctPrompt {
  readonly text: string;
  readonly occurrences: number;
}

/**
 * Collapse rows to the distinct prompts they carry, in first-appearance order.
 *
 * Distinctness is on the EXACT recorded text. No normalizing, no case folding, no trimming for
 * the comparison — a normalized key would make the reported distinct count depend on a rule
 * nobody stated. Rows whose text is absent or whitespace-only carry no prompt and are dropped;
 * they are counted by the caller as unusable rather than folded into the corpus.
 */
export function distinctPrompts(rows: readonly UserPromptRow[]): DistinctPrompt[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!hasPromptText(row)) continue;
    counts.set(row.text as string, (counts.get(row.text as string) ?? 0) + 1);
  }
  return [...counts].map(([text, occurrences]) => ({ text, occurrences }));
}

/**
 * THE corpus: the distinct prompts a full run would label, from raw ledger rows.
 *
 * One definition, used by the dry run's counting AND by anything that spends money on those
 * prompts. Composing the three filters at each call site instead would let a report describe a
 * different set than the panel actually labelled — and neither number would look wrong.
 */
export function corpusPrompts(rows: readonly UserPromptRow[]): DistinctPrompt[] {
  return distinctPrompts(partitionSteerText(partitionLeadPrompts(rows).lead).corpus);
}

// ---------------------------------------------------------------------------
// Length stratification.
// ---------------------------------------------------------------------------

/**
 * Sorted, de-duplicated, in-range cut points. Total over any array a caller passes.
 *
 * Every stratification here — length buckets, confidence bins, floor candidates — needs the same
 * thing done to a caller's boundaries before they can be edges: drop what cannot be a cut, remove
 * repeats, put them in order. Stated once, because two copies of this shape drift on the parts
 * that are identical while looking like they differ only where they should.
 *
 * `max` is the one place they genuinely differ: a length has no upper bound, a confidence stops at
 * 1. Absent means unbounded above.
 */
export function cutPoints(values: readonly number[], max?: number): number[] {
  return [
    ...new Set(
      values.filter((v) => Number.isFinite(v) && v > 0 && (max === undefined || v <= max)),
    ),
  ].sort((a, b) => a - b);
}

/** One length bucket of the corpus. `maxChars: null` marks the open-ended top bucket. */
export interface Stratum {
  readonly label: string;
  readonly minChars: number;
  readonly maxChars: number | null;
  readonly count: number;
  readonly share: Rate;
}

/**
 * Bucket the corpus by prompt length in characters. Boundaries are lower-inclusive, so
 * `[60, 200]` yields `<60`, `60-199` and `>=200`.
 *
 * Counts are of DISTINCT prompts, never of occurrences: one prompt asked forty times is one
 * corpus entry, because a repeat is not new evidence about the classifier.
 *
 * Total: boundaries are sorted, de-duplicated and filtered to positive values, so a caller
 * passing them out of order or with a zero cannot produce an incoherent set of strata.
 */
export function stratifyByLength(
  prompts: readonly DistinctPrompt[],
  boundaries: readonly number[],
): Stratum[] {
  const edges = [0, ...cutPoints(boundaries)];
  return edges.map((minChars, i) => {
    const next = edges[i + 1];
    const maxChars = next === undefined ? null : next - 1;
    const count = prompts.filter(
      (p) => p.text.length >= minChars && (maxChars === null || p.text.length <= maxChars),
    ).length;
    const label =
      maxChars === null ? `>=${minChars}` : minChars === 0 ? `<${next}` : `${minChars}-${maxChars}`;
    return { label, minChars, maxChars, count, share: rate(count, prompts.length) };
  });
}

// ---------------------------------------------------------------------------
// Cost estimation — what a full run WOULD spend. Nothing here spends anything.
// ---------------------------------------------------------------------------

/**
 * One leg of the full run's spend: a model the evaluation would call, how many calls each prompt
 * costs it, and its prices. Supplied by the caller rather than read from a catalog so the estimate
 * stays a pure function of stated numbers — an estimate whose inputs are visible is one a reviewer
 * can re-derive.
 */
export interface CallSpec {
  readonly label: string;
  readonly callsPerPrompt: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /**
   * Input tokens every call pays regardless of prompt — the system prompt and instructions. NOT
   * optional: the classifier's own system prompt is ~99 tokens against a ~17-token average prompt
   * here, so a silently-defaulted zero would understate input by nearly 7x. State it, even as 0.
   */
  readonly fixedInputTokensPerCall: number;
  /** Output budget assumed per call — a label response is short and bounded. */
  readonly outputTokensPerCall: number;
}

/**
 * The projected spend for one {@link CallSpec} across the whole corpus. Carries the prices it was
 * computed from, so the printed estimate can be re-derived from the output alone — an estimate a
 * reviewer cannot check is as misleading as a percentage without its denominator.
 */
export interface CostLine {
  readonly label: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly usd: number;
}

/** The projected spend for a full run, per leg and in total. */
export interface CostEstimate {
  readonly prompts: number;
  readonly lines: readonly CostLine[];
  readonly totalCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalUsd: number;
}

/**
 * Rough token count for a prompt: four characters per token, rounded up. A heuristic, and stated
 * as one wherever the estimate is reported — no tokenizer is loaded, because an order-of-magnitude
 * spend figure is what a cost guard needs and an exact one would cost a dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Round a dollar figure to the cent's sixth decimal, so float noise never reaches the report. */
function usd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Project what a full run would spend, without spending it.
 *
 * Input tokens come from the prompts themselves plus each leg's fixed per-call overhead; output
 * tokens from each leg's declared per-call budget. Each DISTINCT prompt is priced once however
 * often it was asked — the corpus is the unit of work, so a prompt repeated forty times is not
 * forty calls.
 *
 * The chars/4 + fixed-output-allowance heuristic is the same one `estimatedPassCostUsd` uses for
 * the observer's cap. Deliberately not shared: that one is shaped around a single pass over a
 * `Model`, and reusing it would pull the AI layer's types into this pure core for two lines of
 * arithmetic.
 */
export function estimateRunCost(
  prompts: readonly DistinctPrompt[],
  specs: readonly CallSpec[],
): CostEstimate {
  const corpusInputTokens = prompts.reduce((sum, p) => sum + estimateTokens(p.text), 0);
  const lines = specs.map((s) => {
    const calls = prompts.length * s.callsPerPrompt;
    const inputTokens =
      (corpusInputTokens + prompts.length * s.fixedInputTokensPerCall) * s.callsPerPrompt;
    const outputTokens = calls * s.outputTokensPerCall;
    return {
      label: s.label,
      calls,
      inputTokens,
      outputTokens,
      inputUsdPerMTok: s.inputUsdPerMTok,
      outputUsdPerMTok: s.outputUsdPerMTok,
      usd: usd((inputTokens / 1e6) * s.inputUsdPerMTok + (outputTokens / 1e6) * s.outputUsdPerMTok),
    };
  });
  return {
    prompts: prompts.length,
    lines,
    totalCalls: lines.reduce((n, l) => n + l.calls, 0),
    totalInputTokens: lines.reduce((n, l) => n + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((n, l) => n + l.outputTokens, 0),
    totalUsd: usd(lines.reduce((n, l) => n + l.usd, 0)),
  };
}

// ---------------------------------------------------------------------------
// The dry-run report: what corpus a full run would use, and what it would cost.
// ---------------------------------------------------------------------------

/**
 * Corpus length buckets in characters: terse one-liners, ordinary asks, briefs, long specs. The
 * 60-char boundary is the one the sizing figures on MUB-215 were quoted at, so a run here stays
 * comparable to those.
 */
export const DEFAULT_LENGTH_BOUNDARIES: readonly number[] = [60, 200, 1000];

/**
 * A label reply is one line of minified JSON (three short fields), so ~40 output tokens covers it
 * with room to spare. The instruction is `CLASSIFY_SYSTEM` itself — 395 chars, ~99 tokens — which
 * every leg here pays per call. Both are allowances, and both are printed.
 *
 * A leg whose model reasons SERVER-SIDE bills those hidden tokens as output, so 40 understates it
 * by an order of magnitude. Legs like that state their own larger allowance (see the reference
 * panel in `consensus_panel.ts`); the constant below is the non-reasoning case.
 */
export const LABEL_OUTPUT_TOKENS = 40;
export const LABEL_INSTRUCTION_TOKENS = 99;

/**
 * PROVISIONAL leg for the full arc's spend estimate: one replay of the harness classifier per
 * prompt (MUB-218). It exists so the dry run prints the arc's order of magnitude, and NOTHING
 * executes it — `--spend` runs the reference panel only.
 *
 * The reference panel's legs are no longer here: MUB-216 chose the panel, and its models, prices
 * and per-leg output allowances now live with the panel itself (`consensus_panel.ts`), so the
 * projection and the calls that get billed cannot disagree about which models they mean.
 *
 * The price below was COPIED from the harness's own model registry and nothing keeps it in sync —
 * the first price edit there makes it stale. Tolerable only because the readout prints each leg's
 * prices, so drift shows up in the output rather than hiding inside the total.
 */
export const REPLAY_CALL_SPECS: readonly CallSpec[] = [
  {
    label: "replay: harness classifier",
    callsPerPrompt: 1,
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    fixedInputTokensPerCall: LABEL_INSTRUCTION_TOKENS,
    outputTokensPerCall: LABEL_OUTPUT_TOKENS,
  },
];

// ---------------------------------------------------------------------------
// Invocation. The cost guard is a pure decision, so it can be pinned by a test.
// ---------------------------------------------------------------------------

/** Default row cap: far above this ledger's size, so a normal run is never truncated. */
export const DEFAULT_ROW_CAP = 20000;

/**
 * Which ledger rows a run reads. Shared by every run kind, so a flag cannot select one corpus for
 * a dry run and a different one for the paid run whose cost that dry run just projected.
 */
export interface CorpusScope {
  readonly project: string | null;
  readonly dbPath: string | null;
  readonly rowCap: number;
}

/**
 * Why a spend request was refused. An enum rather than a message, so the shell's wording is derived
 * from the decision instead of re-deciding alongside it.
 *
 * `missing-ceiling` — `--spend` with no `--max-usd`. Bare `--spend` is not permission.
 * `bad-ceiling` — a `--max-usd` that is not a positive finite number of dollars.
 */
export type SpendRefusal = "missing-ceiling" | "bad-ceiling";

/**
 * Why a scoring request was refused. Same shape as {@link SpendRefusal}, and for the same reason:
 * the shell's wording is derived from the decision rather than re-deciding alongside it.
 *
 * `missing-target` — `--score` with no `--target-correctness`. The bar an admitted override has to
 * clear is the caller's to state; the non-arbitrary one is what the SERVICE's own label scores on
 * this corpus, which is a different readout's answer.
 * `bad-target` — a `--target-correctness` that is not a correctness: outside (0, 1].
 */
export type ScoreRefusal = "missing-target" | "bad-target";

/**
 * What an argv asks the evaluation to do. Total over argv: every argument list maps to exactly one
 * of these, and the only one that permits a billable call is `spend`, which is unreachable without
 * a stated ceiling. Kept total deliberately — the paid legs (MUB-216 onward) add their execution to
 * the shell, and should not need to touch this union.
 */
export type Invocation =
  | { kind: "help" }
  | ({ kind: "refuse-spend"; reason: SpendRefusal } & CorpusScope)
  | ({ kind: "dry-run" } & CorpusScope)
  /** MUB-225: report the prompt↔decision correlation and its corroboration rate. Reads only. */
  | ({ kind: "correlate" } & CorpusScope)
  /** MUB-218: score the classifier replay against the panel and derive a floor. Reads only. */
  | ({ kind: "score"; targetCorrectness: number } & CorpusScope)
  | ({ kind: "refuse-score"; reason: ScoreRefusal } & CorpusScope)
  /** MUB-226: adjudicate what overriding the service's label would have done. Reads only. */
  | ({ kind: "adjudicate" } & CorpusScope)
  | ({ kind: "spend"; maxUsd: number } & CorpusScope);

/**
 * Decide what an argv means, without doing any of it.
 *
 * The cost guard lives here rather than in the shell so it is unit-testable, and the invariant it
 * exists to hold is a property of this function alone: `spend` is reachable only from an argv
 * carrying BOTH `--spend` and a valid `--max-usd`, so no accidental argv can spend. `--spend` is
 * the verb and the ceiling is the affirmative — a bare `--spend` states an intention, not a
 * permission, and is refused.
 *
 * `--help` is decided first: asking for documentation must never spend, whatever else is present.
 * (Before a paid path existed, refusal was checked first instead — with `spend` reachable, that
 * order would let `--spend --max-usd=1 --help` bill.) Flag order carries no permission either way;
 * the ceiling is the only thing that grants it.
 *
 * The read-only modes — `--correlate` (MUB-225), `--score` (MUB-218), `--adjudicate` (MUB-226) —
 * are all decided INSIDE the no-spend branch, so `--spend` is answered ahead of every one of them.
 * That keeps the guard's invariant a property of the spend flags alone: a read-only mode can
 * neither be read as permission nor route around the refusal a `--spend` in the same argv has
 * earned. Among themselves the order above is a stated PRECEDENCE and first match wins — an argv
 * naming several picks one, rather than printing figures under a heading computed for another.
 *
 * `--score` refuses without a target the same way `--spend` refuses without a ceiling. Nothing is
 * at stake but a number's honesty rather than money, and the reasoning is the same: a defaulted
 * target would put a figure nobody chose into the bar the floor derivation is measured against,
 * where it would read as derived.
 *
 * A refusal still carries its scope, so the shell can price the corpus the caller asked about and
 * quote a real figure back — choosing a ceiling is only possible against a number.
 *
 * A nonsense row cap falls back to the default instead of reading nothing and reporting an empty
 * corpus as a finding. A nonsense ceiling does NOT fall back: a defaulted spending limit is the one
 * default that could cost money.
 */
export function decideInvocation(argv: readonly string[]): Invocation {
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const option = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  if (has("help")) return { kind: "help" };
  const raw = Number(option("limit") ?? DEFAULT_ROW_CAP);
  const scope: CorpusScope = {
    project: option("project"),
    dbPath: option("db"),
    rowCap: Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_ROW_CAP,
  };
  if (!has("spend")) {
    if (has("correlate")) return { kind: "correlate", ...scope };
    if (has("score")) {
      const stated = option("target-correctness");
      if (stated === null) return { kind: "refuse-score", reason: "missing-target", ...scope };
      const targetCorrectness = Number(stated);
      if (!Number.isFinite(targetCorrectness) || targetCorrectness <= 0 || targetCorrectness > 1) {
        return { kind: "refuse-score", reason: "bad-target", ...scope };
      }
      return { kind: "score", targetCorrectness, ...scope };
    }
    if (has("adjudicate")) return { kind: "adjudicate", ...scope };
    return { kind: "dry-run", ...scope };
  }
  const ceiling = option("max-usd");
  if (ceiling === null) return { kind: "refuse-spend", reason: "missing-ceiling", ...scope };
  const maxUsd = Number(ceiling);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    return { kind: "refuse-spend", reason: "bad-ceiling", ...scope };
  }
  return { kind: "spend", maxUsd, ...scope };
}

/** The ceiling check's verdict. Carries both figures on refusal, so the shell states neither. */
export type CeilingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly estimateUsd: number; readonly maxUsd: number };

/**
 * Is a projected run within the ceiling its caller stated?
 *
 * This bounds the PROJECTION, not the money. The estimate is a chars/4 heuristic over declared
 * prices, so a real run's actual spend can exceed it, and this check cannot stop that — what it
 * catches is a ceiling chosen against one corpus and re-used against a bigger one, which is how a
 * remembered command quietly turns into a larger bill than the one it was approved for. A live cap
 * that watches realized cost as it accrues belongs with the code that does the billing (MUB-216).
 *
 * Boundary: an estimate exactly equal to the ceiling passes. The ceiling is a limit the caller
 * accepted paying, not one they accepted staying under.
 */
export function checkSpendCeiling(estimateUsd: number, maxUsd: number): CeilingVerdict {
  if (estimateUsd <= maxUsd) return { ok: true };
  return { ok: false, estimateUsd, maxUsd };
}

/**
 * A ceiling that would admit this projection: the estimate rounded up to the next cent, and never
 * below a cent. Printed as a concrete suggestion because a ceiling can only be chosen against a
 * number, and a caller with no figure to anchor on picks one that is wrong in whichever direction
 * is more annoying.
 *
 * Carries no headroom for actuals, on purpose: it is the smallest ceiling that clears the estimate,
 * so the caller adds headroom deliberately rather than inheriting a number that silently permits
 * more than they read.
 *
 * Rounds through the micro-dollar the estimate is already quantized to, rather than `x * 100`
 * directly: nine values under $2 (`$0.07`, `$0.28`, `$0.55`…) have a binary expansion just above
 * their exact cent, so the direct form suggests a cent more than an exact-cent estimate needs. A
 * cost guard whose printed figures cannot be re-derived by hand is not worth much.
 */
export function suggestCeilingUsd(estimateUsd: number): number {
  return Math.max(0.01, Math.ceil(Math.round(estimateUsd * 1e6) / 1e4) / 100);
}

/** What the dry run is told to measure. `scope` is descriptive only — it labels the readout. */
export interface DryRunConfig {
  readonly scope: string;
  readonly lengthBoundaries: readonly number[];
  readonly specs: readonly CallSpec[];
  /** The row cap the read was made under, so a truncated read can be reported as truncated. */
  readonly rowCap?: number;
}

/**
 * Every number the dry run reports. Each rate is a {@link Rate}, so no figure in here can be
 * quoted without its denominator.
 *
 * Steer exclusion is reported twice on purpose. "How many records were excluded" is ambiguous
 * between raw messages and distinct texts — a steer message repeats across runs, so the two
 * differ a lot — and reporting one number would leave a reader guessing which was meant.
 */
export interface DryRunReport {
  readonly scope: string;
  /** Recorded user-role messages read, before any filtering. */
  readonly rawUserRows: number;
  /** True when the read hit its cap, so these figures describe a slice, not the ledger. */
  readonly capHit: boolean;
  /** Rows whose payload carried no prompt text at all, over all rows read. */
  readonly unusableRows: Rate;
  /** Messages set aside as a sub-agent's, over all rows read — traffic the classifier never sees. */
  readonly subagentRows: Rate;
  /** Raw messages excluded as harness steer text, over all rows read. */
  readonly steerRows: Rate;
  /** Distinct steer texts, over all distinct LEAD texts — so `corpusDistinct + n = d`. */
  readonly steerDistinct: Rate;
  readonly corpusDistinct: number;
  /** Recorded messages carrying a corpus prompt — always >= corpusDistinct. */
  readonly corpusOccurrences: number;
  readonly strata: readonly Stratum[];
  readonly cost: CostEstimate;
}

/** Assemble the whole dry-run readout from raw ledger rows. Pure: reads nothing, spends nothing. */
export function buildDryRunReport(rows: readonly UserPromptRow[], cfg: DryRunConfig): DryRunReport {
  const { lead, subagent } = partitionLeadPrompts(rows);
  const { excluded } = partitionSteerText(lead);
  const corpus = corpusPrompts(rows);
  const steerPrompts = distinctPrompts(excluded);
  const leadDistinct = corpus.length + steerPrompts.length;
  const unusable = rows.filter((r) => !hasPromptText(r)).length;
  return {
    scope: cfg.scope,
    rawUserRows: rows.length,
    capHit: cfg.rowCap !== undefined && rows.length >= cfg.rowCap,
    unusableRows: rate(unusable, rows.length),
    subagentRows: rate(subagent.length, rows.length),
    steerRows: rate(excluded.length, rows.length),
    steerDistinct: rate(steerPrompts.length, leadDistinct),
    corpusDistinct: corpus.length,
    corpusOccurrences: corpus.reduce((n, p) => n + p.occurrences, 0),
    strata: stratifyByLength(corpus, cfg.lengthBoundaries),
    cost: estimateRunCost(corpus, cfg.specs),
  };
}

/**
 * Render the report as plain text. Lives in the pure core alongside the counting, so the shell
 * cannot reformat a number on its way out — and so the "every rate carries its denominator"
 * guarantee is testable without running the script.
 */
export function renderDryRunReport(r: DryRunReport): string {
  const lines: string[] = [
    "Classifier eval — DRY RUN (no billable call was made)",
    `scope: ${r.scope}`,
    "",
    "Corpus",
    `  user-role messages read      ${r.rawUserRows}${r.capHit ? "  ⚠ TRUNCATED at the row cap" : ""}`,
    `  set aside as sub-agent       ${formatRate(r.subagentRows)}`,
    `  excluded as harness steer    ${formatRate(r.steerRows)} raw · ${formatRate(r.steerDistinct)} distinct`,
    `  unusable (no prompt text)    ${formatRate(r.unusableRows)}`,
    `  distinct prompts in corpus   ${r.corpusDistinct} (from ${r.corpusOccurrences} messages)`,
    "",
    "Length strata (chars, distinct prompts)",
  ];
  for (const s of r.strata) {
    lines.push(`  ${s.label.padEnd(28)} ${formatRate(s.share)}`);
  }
  lines.push("", "Projected spend for a full run (~4 chars/token, estimate only)");
  if (r.cost.lines.length === 0) {
    lines.push("  no call legs configured");
  }
  for (const l of r.cost.lines) {
    lines.push(
      `  ${l.label.padEnd(28)} ${l.calls} calls · ${l.inputTokens} in · ${l.outputTokens} out` +
        ` · $${l.inputUsdPerMTok}/$${l.outputUsdPerMTok} per Mtok · $${l.usd.toFixed(4)}`,
    );
  }
  lines.push(
    `  ${"TOTAL".padEnd(28)} ${r.cost.totalCalls} calls · $${r.cost.totalUsd.toFixed(4)}`,
    "",
    "Spending requires --spend --max-usd=<ceiling>. Nothing above cost anything.",
  );
  // The corpus's limits travel with the report, not alongside it — a figure quoted out of this
  // readout should carry the reason it is not a general claim.
  lines.push(
    "",
    "Limits of this corpus, which travel with every figure above:",
    "  · One developer's traffic, a few hundred prompts. Aggregate figures mean something;",
    "    per-task-type figures mostly will not.",
    "  · Sub-agent messages are excluded: the client-side classifier only labels lead-agent",
    "    turns, so they are traffic it never sees.",
  );
  if (r.capHit) {
    lines.push(
      "  · ⚠ The read was TRUNCATED at its row cap, so this describes the most recent slice of",
      "    the ledger, not the whole of it. Raise the cap.",
    );
  }
  return lines.join("\n");
}
