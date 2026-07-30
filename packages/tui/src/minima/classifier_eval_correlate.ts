/**
 * Prompt↔decision correlation for the classifier evaluation (MUB-225).
 *
 * There is NO key linking a routing decision to the prompt that caused it. The decision's stored
 * `task_label` is a display truncation, and its `event_id` resolves to a `routing` event whose
 * payload carries no task text. So the link is INFERRED, and the whole point of this module is to
 * be honest about the inference's error rate instead of presenting itself as a join.
 *
 * The rule: a decision correlates to the most recent recorded user prompt in the same run whose
 * timestamp is at or before the decision's. The truncated display label is then an INDEPENDENT
 * corroboration signal — if it is a leading substring of the correlated prompt, that pairing is
 * corroborated. It is never used as prompt text.
 *
 * Two things this refuses to sweep up:
 *   · One prompt can drive several decisions, because the recovery ladder re-decides per rung.
 *     Those group under one corpus entry; counting them separately would inflate the classifier's
 *     support by the retry rate.
 *   · A pairing can fail corroboration without being wrong — a prompt can be legitimately
 *     rewritten before dispatch. Those are reported, never discarded.
 *
 * This module is PURE: no filesystem, no ledger, no network, no clock — same boundary as
 * `classifier_eval.ts`, and tested the same way. It carries prompt text internally (the corpus
 * entry is keyed on the exact text), but nothing it RENDERS contains prompt text or a label: the
 * corpus is one developer's own traffic, so the readout is counts and denominators only.
 */
import type { RoutingDecisionRow, UserPromptRow } from "../db/minima_db.ts";
import { type Rate, formatRate, hasPromptText, rate } from "./classifier_eval.ts";
import { isHarnessSteerText } from "./stop_gate.ts";

/**
 * Which population a decision belongs to.
 *
 * Only a service-routed decision has a recommendation behind it; an offline or pinned turn never
 * asked the service, so it is not an observation of the classifier at all. Set aside rather than
 * dropped, so the size of the exclusion stays visible in the readout.
 */
export function partitionServiceRouted(rows: readonly RoutingDecisionRow[]): {
  serviceRouted: RoutingDecisionRow[];
  other: RoutingDecisionRow[];
} {
  const serviceRouted: RoutingDecisionRow[] = [];
  const other: RoutingDecisionRow[] = [];
  for (const row of rows) {
    if (row.routed === "server") serviceRouted.push(row);
    else other.push(row);
  }
  return { serviceRouted, other };
}

// ---------------------------------------------------------------------------
// Corroboration: the display label, used as a signal and never as text.
// ---------------------------------------------------------------------------

/**
 * Whether the display label backs up the pairing. Three states, not two: a decision with no stored
 * label can neither corroborate nor fail to, so it belongs in neither the numerator nor the
 * denominator of the reported rate.
 */
export type Corroboration = "corroborated" | "uncorroborated" | "no-label";

/**
 * The transform the shipped label maker applies before truncating (`runtime.ts:shortLabel` does
 * `text.replace(/\s+/g, " ").trim()`). Mirrored here rather than imported because importing it
 * would pull the whole harness runtime into this pure core.
 *
 * Mirroring is safe in one direction only, and this is that direction: if `shortLabel` ever
 * transforms MORE than this, the comparison stops matching and the corroboration rate FALLS. Drift
 * can therefore make this check pessimistic, never make it vouch for a pairing it should not.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The ellipsis `shortLabel` appends when it truncates at 40 characters. */
const LABEL_TRUNCATION_MARK = "…";

/**
 * Drop the truncation mark, so a truncated label is compared as the prefix it is. Treating the
 * ellipsis as content would fail every prompt longer than 40 characters — half of this ledger's
 * decisions — and report a corroboration rate near zero.
 */
function stripTruncationMark(label: string): string {
  return label.endsWith(LABEL_TRUNCATION_MARK)
    ? label.slice(0, -LABEL_TRUNCATION_MARK.length)
    : label;
}

/**
 * Does the display label corroborate this pairing?
 *
 * The label is `collapseWhitespace(task).slice(0, 40)`, plus an ellipsis when that cut anything. So
 * the check strips the truncation mark and compares against the prompt under the same whitespace
 * collapse. Case is significant: the label maker does not fold it.
 *
 * A prompt rewritten before dispatch (a replan prefix prepended, say) fails this check without
 * being mis-paired. That is the reported-not-discarded case, not a defect.
 */
export function corroborate(label: string | null, promptText: string | null): Corroboration {
  const stem = label === null ? "" : collapseWhitespace(stripTruncationMark(label));
  if (stem === "") return "no-label";
  if (promptText === null) return "uncorroborated";
  return collapseWhitespace(promptText).startsWith(stem) ? "corroborated" : "uncorroborated";
}

// ---------------------------------------------------------------------------
// The correlation itself.
// ---------------------------------------------------------------------------

/**
 * Which population the correlated prompt itself belongs to. The rule names the nearest recorded
 * user row, whatever it is — so a decision can land on harness steer text, on a sub-agent's brief,
 * or on a row with no text at all. Only a `corpus` pairing is evidence about the classifier under
 * test, and reporting the rest is what keeps this a measured heuristic rather than a join.
 */
export type PromptBucket = "corpus" | "steer" | "subagent" | "unusable";

/** Every bucket, in the order the readout lists them. */
export const PROMPT_BUCKETS: readonly PromptBucket[] = ["corpus", "steer", "subagent", "unusable"];

/**
 * Classify one correlated prompt row. Same order of tests as the dry run's corpus build
 * (`partitionLeadPrompts` then `partitionSteerText`), so a row cannot be corpus here and excluded
 * there.
 */
function bucketOf(row: UserPromptRow): PromptBucket {
  if (row.agent_id !== null) return "subagent";
  if (!hasPromptText(row)) return "unusable";
  return isHarnessSteerText(row.text as string) ? "steer" : "corpus";
}

/** One decision paired to the prompt the rule says caused it. A heuristic pairing, not a join. */
export interface Pairing {
  readonly recId: string;
  readonly runId: string;
  /** The correlated prompt's event id — the closest thing to a join key that exists. */
  readonly promptEventId: string;
  /** The FULL recorded prompt, or null for an `unusable` row. Never rendered. */
  readonly promptText: string | null;
  readonly promptBucket: PromptBucket;
  readonly corroboration: Corroboration;
}

/**
 * Why the rule could not pair a decision. The two are not the same claim and must not be added up:
 *
 *   · `before-read-window` — the decision predates every prompt row supplied, so the prompt read
 *     simply did not reach back to it. An artifact of the read's cap, not a fact about the ledger.
 *   · `no-earlier-prompt-in-run` — the read DID cover that instant, and its run still has no user
 *     prompt at or before it. That is a genuine gap.
 *
 * Reporting one number for both would let a `--limit` too small to cover the decisions read
 * masquerade as a finding about prompt coverage.
 */
export type UnpairedReason = "before-read-window" | "no-earlier-prompt-in-run";

/** A decision the rule could not pair, with which of the two reasons applies. */
export interface Unpaired {
  readonly recId: string;
  readonly runId: string;
  readonly reason: UnpairedReason;
}

/** The outcome of correlating a set of decisions. Every input decision lands in exactly one list. */
export interface Correlation {
  readonly pairings: readonly Pairing[];
  readonly unpaired: readonly Unpaired[];
}

/**
 * Apply the run-and-timestamp rule to every decision.
 *
 * Total, and deterministic in a way the equivalent SQL is not: among the candidates at or before
 * the decision, the greatest timestamp wins, and a TIE is broken on the later-arriving row. A
 * nondeterministic tie-break would move the reported corroboration rate without the ledger moving.
 * The result does not depend on the order rows arrive in.
 *
 * Prompts are indexed by run first, so this is one pass per run rather than a scan per decision.
 */
export function correlateDecisions(
  decisions: readonly RoutingDecisionRow[],
  prompts: readonly UserPromptRow[],
): Correlation {
  const byRun = new Map<string, UserPromptRow[]>();
  for (const row of prompts) {
    const bucket = byRun.get(row.run_id);
    if (bucket) bucket.push(row);
    else byRun.set(row.run_id, [row]);
  }
  // The oldest prompt supplied bounds the read's window. A decision before it had nothing to pair
  // against, which is a different claim from "its run has no earlier prompt" — see UnpairedReason.
  const windowStart = prompts.reduce<number | null>(
    (min, row) => (min === null || row.ts < min ? row.ts : min),
    null,
  );
  const pairings: Pairing[] = [];
  const unpaired: Unpaired[] = [];
  for (const d of decisions) {
    let best: UserPromptRow | null = null;
    for (const row of byRun.get(d.run_id) ?? []) {
      if (row.ts > d.ts) continue;
      if (best === null || row.ts >= best.ts) best = row;
    }
    if (best === null) {
      unpaired.push({
        recId: d.rec_id,
        runId: d.run_id,
        reason:
          windowStart === null || d.ts < windowStart
            ? "before-read-window"
            : "no-earlier-prompt-in-run",
      });
      continue;
    }
    pairings.push({
      recId: d.rec_id,
      runId: d.run_id,
      promptEventId: best.id,
      promptText: best.text,
      promptBucket: bucketOf(best),
      corroboration: corroborate(d.task_label, best.text),
    });
  }
  return { pairings, unpaired };
}

// ---------------------------------------------------------------------------
// Grouping: one prompt, however many decisions it drove.
// ---------------------------------------------------------------------------

/** One corpus entry with every decision the prompt it carries drove, in first-appearance order. */
export interface CorpusEntryDecisions {
  /** The exact recorded prompt text — the corpus entry's identity. Never rendered. */
  readonly text: string;
  readonly recIds: readonly string[];
  /** The distinct prompt events carrying this text; more than one means it was asked again. */
  readonly promptEventIds: readonly string[];
}

/**
 * Collapse pairings to corpus entries, keyed on the EXACT recorded text — the same distinctness
 * rule `distinctPrompts` uses, so the two agree on what one entry is.
 *
 * Only `corpus` pairings are entries: a decision that landed on steer text or a sub-agent brief is
 * not an observation of the corpus, and folding it in would attribute it to a prompt it did not
 * come from. It stays counted in the bucket tally instead.
 *
 * Every decision one prompt drove ends up under one entry. That is the point: the recovery ladder
 * re-decides per rung, and three rungs of one prompt are one observation of the classifier, not
 * three.
 */
export function groupByCorpusEntry(pairings: readonly Pairing[]): CorpusEntryDecisions[] {
  const entries = new Map<string, { recIds: string[]; promptEventIds: string[] }>();
  for (const p of pairings) {
    if (p.promptBucket !== "corpus" || p.promptText === null) continue;
    let entry = entries.get(p.promptText);
    if (!entry) {
      entry = { recIds: [], promptEventIds: [] };
      entries.set(p.promptText, entry);
    }
    entry.recIds.push(p.recId);
    if (!entry.promptEventIds.includes(p.promptEventId)) entry.promptEventIds.push(p.promptEventId);
  }
  return [...entries].map(([text, e]) => ({
    text,
    recIds: e.recIds,
    promptEventIds: e.promptEventIds,
  }));
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/** What the correlation run is told to measure. `scope` is descriptive only — it labels the readout. */
export interface CorrelationConfig {
  readonly scope: string;
  /** The row cap the decision read was made under, so a truncated read reports as truncated. */
  readonly rowCap?: number;
}

/** How many pairings landed in one bucket, and what share of all pairings that is. */
export interface BucketCount {
  readonly bucket: PromptBucket;
  readonly count: number;
  readonly share: Rate;
}

/**
 * Every number the correlation reports. Each rate is a {@link Rate}, so no figure in here can be
 * quoted without its denominator — and each denominator is a different population on purpose:
 * decisions read, service-routed decisions, pairings, pairings carrying a label, prompt events.
 */
export interface CorrelationReport {
  readonly scope: string;
  /** Decision rows read, before any filtering. */
  readonly decisionsRead: number;
  /** True when the read hit its cap, so these figures describe a slice, not the ledger. */
  readonly capHit: boolean;
  /** Decisions set aside as offline or pinned, over all rows read — they never asked the service. */
  readonly notServiceRouted: Rate;
  readonly serviceRouted: number;
  /** Decisions the rule paired to a prompt, over the service-routed population. */
  readonly correlated: Rate;
  /** Every decision the rule could not pair. Reported in full — a dropped one would be invisible. */
  readonly uncorrelatedRecIds: readonly string[];
  /** Uncorrelated because the prompt read did not reach back that far — a cap artifact. */
  readonly uncorrelatedBeforeReadWindow: number;
  /** Uncorrelated inside the read's window: a genuine gap in prompt coverage. */
  readonly uncorrelatedNoEarlierPrompt: number;
  /** Pairings the display label backs up, over pairings whose decision carried a label. */
  readonly corroborated: Rate;
  /** Pairings the label contradicts. Reported, not discarded: a rewrite fails this check. */
  readonly uncorroborated: number;
  /** Pairings whose decision stored no label — in neither side of the corroboration rate. */
  readonly labelUnavailable: number;
  readonly buckets: readonly BucketCount[];
  /** Distinct prompt events something correlated to — the grouping denominator. */
  readonly promptEventsCorrelated: number;
  /** Prompt events that drove more than one decision, over the events correlated to. */
  readonly promptEventsWithMultipleDecisions: Rate;
  readonly maxDecisionsPerPromptEvent: number;
  /** Distinct corpus prompts the decisions group under — NOT the number of decisions. */
  readonly corpusEntries: number;
  /** Decisions attributed to a corpus entry — always >= corpusEntries. */
  readonly corpusEntryDecisions: number;
  readonly maxDecisionsPerCorpusEntry: number;
}

/** Assemble the whole correlation readout from raw ledger rows. Pure: reads nothing, spends nothing. */
export function buildCorrelationReport(
  decisions: readonly RoutingDecisionRow[],
  prompts: readonly UserPromptRow[],
  cfg: CorrelationConfig,
): CorrelationReport {
  const { serviceRouted, other } = partitionServiceRouted(decisions);
  const { pairings, unpaired } = correlateDecisions(serviceRouted, prompts);

  const perEvent = new Map<string, number>();
  for (const p of pairings) perEvent.set(p.promptEventId, (perEvent.get(p.promptEventId) ?? 0) + 1);
  const eventCounts = [...perEvent.values()];

  const entries = groupByCorpusEntry(pairings);
  const entryCounts = entries.map((e) => e.recIds.length);

  const labelled = pairings.filter((p) => p.corroboration !== "no-label").length;

  return {
    scope: cfg.scope,
    decisionsRead: decisions.length,
    capHit: cfg.rowCap !== undefined && decisions.length >= cfg.rowCap,
    notServiceRouted: rate(other.length, decisions.length),
    serviceRouted: serviceRouted.length,
    correlated: rate(pairings.length, serviceRouted.length),
    uncorrelatedRecIds: unpaired.map((u) => u.recId),
    uncorrelatedBeforeReadWindow: unpaired.filter((u) => u.reason === "before-read-window").length,
    uncorrelatedNoEarlierPrompt: unpaired.filter((u) => u.reason === "no-earlier-prompt-in-run")
      .length,
    corroborated: rate(pairings.filter((p) => p.corroboration === "corroborated").length, labelled),
    uncorroborated: pairings.filter((p) => p.corroboration === "uncorroborated").length,
    labelUnavailable: pairings.length - labelled,
    buckets: PROMPT_BUCKETS.map((bucket) => {
      const count = pairings.filter((p) => p.promptBucket === bucket).length;
      return { bucket, count, share: rate(count, pairings.length) };
    }),
    promptEventsCorrelated: perEvent.size,
    promptEventsWithMultipleDecisions: rate(eventCounts.filter((n) => n > 1).length, perEvent.size),
    maxDecisionsPerPromptEvent: eventCounts.reduce((a, b) => Math.max(a, b), 0),
    corpusEntries: entries.length,
    corpusEntryDecisions: entryCounts.reduce((a, b) => a + b, 0),
    maxDecisionsPerCorpusEntry: entryCounts.reduce((a, b) => Math.max(a, b), 0),
  };
}

/**
 * Render the report as plain text — counts and denominators ONLY. No prompt text, no display
 * label: the corpus is one developer's own traffic, so this readout is safe to paste anywhere.
 *
 * Lives in the pure core alongside the counting so the shell cannot reformat a number on its way
 * out, and so the "this is a heuristic, not a key" caveat travels with every figure rather than
 * being remembered by whoever quotes it.
 */
export function renderCorrelationReport(r: CorrelationReport): string {
  const lines: string[] = [
    "Classifier eval — prompt↔decision correlation (INFERRED, not a join)",
    `scope: ${r.scope}`,
    "",
    "Population",
    `  decision rows read           ${r.decisionsRead}${r.capHit ? "  ⚠ TRUNCATED at the row cap" : ""}`,
    `  set aside as offline/pinned  ${formatRate(r.notServiceRouted)}`,
    `  service-routed decisions     ${r.serviceRouted}`,
    "",
    "Correlation (most recent user prompt in the same run, at or before the decision)",
    `  correlated                   ${formatRate(r.correlated)}`,
    `  uncorrelated                 ${r.uncorrelatedRecIds.length}`,
    `    before the prompt read     ${r.uncorrelatedBeforeReadWindow}  (raise --limit; not a finding)`,
    `    no earlier prompt in run   ${r.uncorrelatedNoEarlierPrompt}`,
  ];
  if (r.uncorrelatedRecIds.length > 0) {
    const shown = r.uncorrelatedRecIds.slice(0, 5).join(" ");
    const more = r.uncorrelatedRecIds.length - shown.split(" ").length;
    lines.push(`    rec_ids: ${shown}${more > 0 ? ` … +${more} more` : ""}`);
  }
  lines.push("", "Where the correlated prompt actually came from (of all pairings)");
  for (const b of r.buckets) {
    lines.push(`  ${b.bucket.padEnd(28)} ${formatRate(b.share)}`);
  }
  lines.push(
    "",
    "Corroboration (display label as a leading substring — a signal, never prompt text)",
    `  corroborated                 ${formatRate(r.corroborated)}`,
    `  uncorroborated               ${r.uncorroborated}`,
    `  no label stored              ${r.labelUnavailable}`,
    "",
    "Grouping (one prompt, however many decisions it drove)",
    `  prompt events correlated to  ${r.promptEventsCorrelated}`,
    `  driving >1 decision          ${formatRate(r.promptEventsWithMultipleDecisions)}` +
      ` · max ${r.maxDecisionsPerPromptEvent}`,
    `  corpus entries               ${r.corpusEntries} (from ${r.corpusEntryDecisions} decisions,` +
      ` max ${r.maxDecisionsPerCorpusEntry} per entry)`,
  );
  // The correlation's limits travel with the report, not alongside it — a figure quoted out of this
  // readout should carry the reason it is not a join.
  lines.push(
    "",
    "What these figures are, which travels with every one of them:",
    "  · The prompt↔decision link is a HEURISTIC, not a key. Nothing in the ledger joins the two:",
    "    the decision's stored label is a display truncation and its event carries no task text.",
    "    The corroboration rate above IS this heuristic's measured agreement — not its accuracy.",
    "  · An uncorroborated pairing is not necessarily wrong. A prompt that was rewritten before",
    "    dispatch (a replan prefix prepended, say) fails a leading-substring check while still",
    "    being the prompt that caused the decision. They are reported here, never discarded.",
    "  · A pairing outside the `corpus` bucket landed on harness steer text, a sub-agent's brief",
    "    or a row with no text. Those are not observations of the classifier under test, which",
    "    labels lead-agent turns only.",
    "  · Decisions group under one corpus entry per distinct prompt. The recovery ladder re-decides",
    "    per rung, so several decisions from one prompt are ONE observation, not several.",
  );
  if (r.capHit) {
    lines.push(
      "  · ⚠ The read was TRUNCATED at its row cap, so this describes the most recent slice of",
      "    the ledger, not the whole of it. Raise the cap.",
    );
  }
  return lines.join("\n");
}
