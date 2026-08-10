/**
 * Cross-validation (`/crossvalidation`) — one model writes the change, a DIFFERENT model
 * reviews it, and the writer gets one pass to answer the objections.
 *
 * The point is that the model that produced a change is the worst possible judge of it:
 * the misreading that wrote the bug writes the review that clears it. So the writer runs
 * as a normal sub-agent with its routing restricted to the user's chosen id (pre-request
 * candidate assembly via Delegation.candidates — never a post-hoc re-rank), and the
 * reviewer is a plain completion on a second user-chosen model that sees only the task
 * and the resulting diff.
 *
 * Advisory only, by design: nothing here writes a gate. A reviewer that never ran a
 * command has no standing on the trust ladder — `verified_in_production` belongs to
 * user/repo/ci-origin gates, and even the E1 diff reviewer may only ever YELLOW a plan.
 * Cross-validation prints its verdict and lets the user decide. Distinct from
 * `diff_review.ts` on purpose: that reviewer is quarantined from the task on purpose
 * (fresh eyes over the code alone); this one is handed the task, because "did it actually
 * do the thing" is the question being asked.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";
import type { MinimaDb } from "../db/minima_db.ts";
import type { ChildResult, SpawnFn } from "../tools/task.ts";
import {
  DIFF_REVIEW_CAP_CHARS,
  type DiffReviewVerdict,
  parseDiffReviewVerdict,
} from "./diff_review.ts";
import { midTruncate } from "./judge.ts";

export const CROSSVALIDATE_SYSTEM =
  "You are an independent reviewer. Another model was given the task below and produced " +
  "the diff below; you did not write it and have seen none of its reasoning. Judge whether " +
  "the diff actually accomplishes the task and is safe to keep. Object only to concrete " +
  "defects a reviewer would block on: the task not actually done, introduced bugs, " +
  "half-finished edits (dead branches, TODO stubs presented as done), deleted or weakened " +
  "tests, debug leftovers, obvious security problems, changes the task never asked for. " +
  "Style and taste are NOT objections. Reply with first line EXACTLY " +
  '"VERDICT: approve" or "VERDICT: object"; when objecting add a "CONCERNS:" line followed ' +
  'by one "- " bullet per concrete defect (at most 6).';

/** One review pass, plus the fix pass it triggered (null when it approved or was last). */
export interface CrossValidateRound {
  /** null = no verdict; `skipped` says which kind, and neither is ever read as an objection. */
  verdict: DiffReviewVerdict | null;
  /**
   * Why there is no verdict. "error" = the call never came back (no key, rate limit,
   * timeout); "unparsed" = it answered but not in the verdict format. Worth separating:
   * one means your reviewer is broken, the other means it rambled, and reporting a dead
   * reviewer as a rambling one is how a review nobody ran gets mistaken for a clean one.
   */
  skipped: "error" | "unparsed" | null;
  fix: ChildResult | null;
}

export interface CrossValidateResult {
  write: ChildResult;
  rounds: CrossValidateRound[];
  /** The writer produced no diff at all — nothing was reviewed. */
  emptyDiff: boolean;
  reviewCostUsd: number;
  /** Writer + every fix pass. The caller books this against the budget ledger. */
  childCostUsd: number;
}

export interface CrossValidateOptions {
  task: string;
  /** Exact model id the writer's routing is restricted to. */
  writerId: string;
  reviewer: Model;
  spawn: SpawnFn;
  /** Working-tree diff — re-read after every write pass, so a fix shows up in round 2. */
  collectDiff: () => string | null;
  signal?: AbortSignal | null;
  onCostUsd?: (usd: number) => void;
  completeFn?: typeof complete;
  /** Fix passes allowed after an objection (default 1 — write · review · fix · review). */
  fixRounds?: number;
  /** Conversation tail handed to the WRITER (see buildWriterContext). Never the reviewer. */
  context?: string;
  /** Live progress for the UI; the caller renders, this only announces. */
  onProgress?: (line: string) => void;
}

const BOUNDARIES =
  "Stay within the task. Make no unrelated changes and touch no files the task does not call for.";

/** A transcript turn as the writer's excerpt sees it — role + text, no TUI types. */
export interface ContextTurn {
  role: string;
  text: string;
}

export const WRITER_CONTEXT_TURNS = 6;
export const WRITER_CONTEXT_CHARS = 4_000;

/**
 * The tail of the conversation, for the WRITER only.
 *
 * A sub-agent inherits none of the lead's transcript, so `/crossvalidation fix the bug we
 * just discussed` used to reach the writer as those eight words and nothing else. This
 * hands it the last few turns. The REVIEWER deliberately never gets this: its independence
 * is the entire point of the command, and a reviewer primed with the conversation that
 * produced the change is just the writer with extra steps.
 */
export function buildWriterContext(
  turns: ContextTurn[],
  maxTurns = WRITER_CONTEXT_TURNS,
  maxChars = WRITER_CONTEXT_CHARS,
): string {
  const usable = turns
    .filter((t) => (t.role === "user" || t.role === "assistant") && t.text.trim())
    .slice(-maxTurns)
    // A slash command echo is harness chatter, not something the writer should act on.
    .filter((t) => !(t.role === "user" && t.text.trim().startsWith("/")));
  if (usable.length === 0) return "";
  return midTruncate(usable.map((t) => `${t.role}: ${t.text.trim()}`).join("\n\n"), maxChars);
}

/** The writer's objective: the task, plus the conversation it was written in the middle of. */
export function writerObjective(task: string, context?: string): string {
  return context?.trim()
    ? `Recent conversation, for context — the task below continues it:\n\n${context.trim()}\n\n---\n\nTask: ${task}`
    : task;
}

type ReviewOutcome =
  | { verdict: DiffReviewVerdict; skipped: null }
  | { verdict: null; skipped: "error" | "unparsed" };

/** Fail-quiet: an unusable/errored/aborted review is a skip, never a fabricated objection. */
async function review(opts: CrossValidateOptions, diff: string): Promise<ReviewOutcome> {
  const run = opts.completeFn ?? complete;
  try {
    const resp = await run(
      opts.reviewer,
      {
        system_prompt: CROSSVALIDATE_SYSTEM,
        messages: [
          new Message({
            role: "user",
            content: `The task the other model was given:\n\n${opts.task}\n\nThe complete diff it produced:\n\n${midTruncate(
              diff,
              DIFF_REVIEW_CAP_CHARS,
            )}`,
          }),
        ],
        tools: [],
      },
      { options: { timeout: 45, prompt_cache: false }, signal: opts.signal ?? undefined },
    );
    try {
      const usd = resp.usage.cost.total;
      opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break the review
    }
    if (resp.stop_reason === "error") return { verdict: null, skipped: "error" };
    const verdict = parseDiffReviewVerdict(resp.textContent);
    return verdict ? { verdict, skipped: null } : { verdict: null, skipped: "unparsed" };
  } catch {
    return { verdict: null, skipped: "error" };
  }
}

/**
 * Run the whole loop. Throws only what the writer spawn throws — every reviewer failure
 * degrades to a skipped round, because a dead reviewer must not lose the writer's work.
 */
export async function crossValidate(opts: CrossValidateOptions): Promise<CrossValidateResult> {
  opts.onProgress?.(`writing with ${opts.writerId}…`);
  const objective = writerObjective(opts.task, opts.context);
  const write = await opts.spawn(
    {
      step_id: "crossvalidate",
      objective,
      output_format: "A short summary of what you changed and why, naming every file you touched.",
      boundaries: BOUNDARIES,
      candidates: [opts.writerId],
    },
    { depth: 1, parentSignal: opts.signal ?? null, priorResults: [] },
  );

  const result: CrossValidateResult = {
    write,
    rounds: [],
    emptyDiff: false,
    reviewCostUsd: 0,
    childCostUsd: write.costUsd,
  };
  let fixesLeft = opts.fixRounds ?? 1;
  let cost = 0;
  const bill = (usd: number) => {
    cost += usd;
    opts.onCostUsd?.(usd);
  };
  const billed: CrossValidateOptions = { ...opts, onCostUsd: bill };

  for (;;) {
    if (opts.signal?.aborted) break;
    const diff = opts.collectDiff();
    if (!diff?.trim()) {
      // Only an untouched tree after the FIRST pass is "nothing to review"; a later empty
      // diff means a fix reverted everything, which the rounds already recount.
      result.emptyDiff = result.rounds.length === 0;
      break;
    }
    opts.onProgress?.(`reviewing with ${opts.reviewer.id}…`);
    const { verdict, skipped } = await review(billed, diff);
    if (!verdict?.objects || verdict.concerns.length === 0 || fixesLeft <= 0) {
      result.rounds.push({ verdict, skipped, fix: null });
      break;
    }
    fixesLeft--;
    opts.onProgress?.(`${verdict.concerns.length} concern(s) — ${opts.writerId} answering…`);
    const fix = await opts.spawn(
      {
        step_id: "crossvalidate:fix",
        objective: [
          // The RESOLVED objective, not the bare task line: a fix pass that lost the
          // conversation would re-read "fix the bug we just discussed" as gibberish.
          `Original task: ${objective}`,
          "",
          "An independent reviewer examined your change and raised these concerns:",
          ...verdict.concerns.map((c) => `- ${c}`),
          "",
          "Fix every concern that is real. A concern can be WRONG — the reviewer never saw " +
            "your reasoning and cannot run anything. Where it is wrong, change nothing and " +
            "say why.",
        ].join("\n"),
        output_format:
          "One line per concern: FIXED <what you changed> or REJECTED <why the concern is wrong>.",
        boundaries: `Address only the concerns above and the original task. ${BOUNDARIES}`,
        candidates: [opts.writerId],
      },
      { depth: 1, parentSignal: opts.signal ?? null, priorResults: [] },
    );
    result.rounds.push({ verdict, skipped, fix });
    result.childCostUsd += fix.costUsd;
  }

  result.reviewCostUsd = cost;
  return result;
}

/**
 * A cross-validation objection that survived the fix pass, written to the gates ledger as a
 * yellow milestone gate — the same shape and the same ceiling as the E1 diff reviewer's, so
 * worst-tier resolution can YELLOW an active plan and `/why` can cite it.
 *
 * Three deliberate limits. Only an objection is ever written: approval mints nothing,
 * because a reviewer that ran no command can produce doubt but never proof. Nothing is
 * written without an active plan — gates hang off a plan, and this command runs perfectly
 * well outside one. And unlike diff_review this does NOT call stampVerifiedOutcome: that
 * reviewer fires only after a plan closed green on real gate evidence, whereas this one
 * fires on any `/crossvalidation`, and stamping a routing decision "verified" off a
 * conversational review would be exactly the fabricated quality the feedback contract bans.
 *
 * Returns the gate id, or null when there was nothing (or nowhere) to write.
 */
export function recordCrossValidationObjection(
  db: MinimaDb,
  sessionId: string,
  concerns: string[],
  reviewerId: string,
): string | null {
  if (concerns.length === 0) return null;
  try {
    const plan = db.getActivePlan(sessionId);
    if (!plan) return null;
    const decisions = db.getRunDecisions(sessionId);
    const recId = (decisions.at(-1)?.rec_id as string | undefined) ?? null;
    return db.insertGate({
      planId: plan.id,
      stepId: null,
      kind: "milestone",
      outcome: "verified",
      confidence: "yellow",
      verifiedBy: "judge",
      factors: {
        crossvalidation: true,
        flipContent: `cross-validation review by ${reviewerId}`,
        concerns,
      },
      recId,
      sessionId,
    });
  } catch {
    // Bookkeeping never breaks the command: the review already happened and was reported.
    return null;
  }
}

/** The chat report. Survivors — an objection still standing at the end — lead the summary. */
export function formatCrossValidateReport(
  r: CrossValidateResult,
  writerId: string,
  reviewerId: string,
): string {
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const lines: string[] = [
    `writer   ${writerId} · ${r.write.outcome} · ${usd(r.write.costUsd)}`,
    r.write.text || "(no output)",
  ];
  if (r.emptyDiff) {
    lines.push("", "review   skipped — the writer left no changes to review.");
    return lines.join("\n");
  }
  for (const round of r.rounds) {
    lines.push("");
    if (!round.verdict) {
      lines.push(
        round.skipped === "error"
          ? `review   ${reviewerId} · NEVER RAN — the call failed (no API key, rate limit, or timeout). This change is UNREVIEWED.`
          : `review   ${reviewerId} · no verdict — it answered off-format, so nothing was inferred. This change is UNREVIEWED.`,
      );
      continue;
    }
    lines.push(
      `review   ${reviewerId} · ${round.verdict.objects ? "OBJECT" : "approve"}`,
      ...round.verdict.concerns.map((c) => `  - ${c}`),
    );
    if (round.fix) {
      lines.push(
        "",
        `fix      ${writerId} · ${round.fix.outcome} · ${usd(round.fix.costUsd)}`,
        round.fix.text || "(no output)",
      );
    }
  }
  const last = r.rounds.at(-1);
  const standing =
    last?.verdict?.objects === true
      ? `⚠ ${last.verdict.concerns.length} concern(s) still standing — nothing was auto-accepted, the diff is yours to judge.`
      : last?.verdict
        ? "✓ reviewer approved the final diff."
        : "⚠ NOT cross-validated — the writer ran, the reviewer did not. Treat this as a plain single-model change.";
  lines.push(
    "",
    "---",
    standing,
    `${usd(r.childCostUsd + r.reviewCostUsd)} total · advisory only (no gate written)`,
  );
  return lines.join("\n");
}
