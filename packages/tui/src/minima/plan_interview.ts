/**
 * Plan interview — the opt-in (`MINIMA_TUI_INTERVIEW=1`) elicitation stage of the /plan
 * flow, run right after a council round has presented SYNTH's own decision-point
 * questions (plan_turn's overlay loop). Three questions, each with a skip-gate, hard-
 * capped at 3 per plan session so it can never nag:
 *
 * 1. GOAL/SCOPE — asks NOTHING new in v1: the council's own surfaced decision-points
 *    already flow to the user through the existing plan_turn askUser channel, and GATE's
 *    lesson is that elicitation beats re-asking what the council already asked. This
 *    module therefore only ever adds the two questions below.
 * 2. VERIFICATION — only when the draft would otherwise lack authored verifies: presents
 *    the repo's own mined check commands (mineRepoGates — TiCoder-style "confirm a
 *    candidate, don't ask open-ended") plus free text for a custom command. Answers land
 *    in PlanSessionStore.userVerifies, which finalizePlan applies to verify-less steps so
 *    they seed with check_origin='user' (plan approval = consent, invariant MP18).
 * 3. BUDGET/QUALITY — only when NO routing_profiles row exists for this project:
 *    cost-lean (slider 3) / balanced (5) / quality-lean (7.5) plus an optional free-text
 *    cost cap; the answer writes the routing profile with source='interview'.
 *
 * Free-text elaboration beyond the structured choice is preserved as a kind='preference'
 * memory (origin user, active) — config, verifies, and preferences; NEVER outcome labels
 * (feedback truth stands). Inert by construction when config.interview is off: the caller
 * passes enabled=false and this module returns before doing anything observable.
 */

import type { MinimaDb } from "../db/minima_db.ts";
import type { AskUser } from "../tools/question.ts";
import type { PlanSessionStore } from "./plan_session.ts";
import { type RepoGate, mineRepoGates } from "./repo_gates.ts";

/** Hard cap on interview-originated questions per plan session (don't-nag invariant). */
export const INTERVIEW_MAX_QUESTIONS = 3;

/** Per-plan-session interview state (reset when a new plan session starts). */
export interface InterviewState {
  asked: number;
}

export function newInterviewState(): InterviewState {
  return { asked: 0 };
}

export interface PlanInterviewDeps {
  /** config.interview — false = completely inert (zero behavior change). */
  enabled: boolean;
  askUser: AskUser | null;
  store: PlanSessionStore;
  db: MinimaDb | null;
  projectKey: string | null;
  /** Where to mine candidate check commands; null disables mining (free text remains). */
  repoDir: string | null;
  /** Injectable for tests; defaults to the real miner. */
  mineGates?: (dir: string) => RepoGate[];
  signal?: AbortSignal | null;
  /** Surface a short transcript note about what was recorded. */
  onNote?: (text: string) => void;
  /** Invalidate any cached routing profile after an interview write. */
  onProfileWrite?: () => void;
}

/** Does the draft already carry authored verifies? Matches the council's own step format
 * ("- verify: `cmd`" / "verify: cmd"), the shape toBigPlan renders. */
export function draftHasVerifies(draft: string): boolean {
  return /(^|\n)\s*(?:\d+\.\s*)?(?:[-*]\s*)?verify\s*:/i.test(draft ?? "");
}

const VERIFY_ALL_LABEL = "Use all mined checks";
const VERIFY_NONE_LABEL = "No verify commands";

/** Parse a budget/quality answer: slider from the option keywords (or a bare 0–10
 * number), an optional USD cap from "$0.05" / "cap 0.05" / "max 0.05" phrasing. */
export function parseBudgetAnswer(answer: string): {
  slider: number | null;
  maxCostPerCall: number | null;
} {
  // Cap first, then strip its digits — "max 0.25 per call" must never read as slider 0.25.
  let cap: number | null = null;
  let stripped = answer;
  const capMatch =
    /\$\s*(\d+(?:\.\d+)?)/.exec(answer) ?? /(?:cap|max)\D{0,12}?(\d+(?:\.\d+)?)/i.exec(answer);
  if (capMatch) {
    const c = Number(capMatch[1]);
    if (Number.isFinite(c) && c > 0) {
      cap = c;
      stripped = answer.replace(capMatch[0], " ");
    }
  }
  const lower = stripped.toLowerCase();
  let slider: number | null = null;
  if (lower.includes("cost")) slider = 3;
  else if (lower.includes("quality")) slider = 7.5;
  else if (lower.includes("balanced")) slider = 5;
  else {
    const bare = /(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/.exec(stripped);
    const n = bare ? Number(bare[1]) : Number.NaN;
    if (Number.isFinite(n) && n >= 0 && n <= 10) slider = n;
  }
  return { slider, maxCostPerCall: cap };
}

/**
 * Run the interview for this council round. Skip-gated per question, capped per session;
 * every observable effect (question overlays, DB writes, store writes, notes) is behind
 * `enabled`. Fail-open throughout — a broken write never breaks the plan turn.
 */
export async function runPlanInterview(
  state: InterviewState,
  deps: PlanInterviewDeps,
): Promise<void> {
  if (!deps.enabled || !deps.askUser) return;
  await askVerificationQuestion(state, deps);
  if (deps.signal?.aborted) return;
  await askBudgetQuestion(state, deps);
}

async function askVerificationQuestion(
  state: InterviewState,
  deps: PlanInterviewDeps,
): Promise<void> {
  const ask = deps.askUser;
  if (!ask || state.asked >= INTERVIEW_MAX_QUESTIONS) return;
  const session = deps.store.session;
  // Skip-gate: steps already carry authored verifies, or the interview already recorded some.
  if ((session.userVerifies ?? []).length > 0 || draftHasVerifies(session.draft)) return;

  let gates: RepoGate[] = [];
  if (deps.repoDir) {
    try {
      gates = (deps.mineGates ?? mineRepoGates)(deps.repoDir);
    } catch {
      gates = [];
    }
  }
  const options: { label: string; description?: string }[] = [];
  if (gates.length > 1) {
    options.push({
      label: VERIFY_ALL_LABEL,
      description: gates.map((g) => g.command).join(" · "),
    });
  }
  for (const g of gates) {
    options.push({ label: g.command, description: `${g.kind} (from ${g.source})` });
  }
  options.push({
    label: VERIFY_NONE_LABEL,
    description: "steps fall back to mined auto-gates / the judge",
  });

  state.asked += 1;
  let answer: string | null = null;
  try {
    answer = await ask({
      question:
        "How do you verify changes in this repo? Confirmed commands become the plan's step checks (check origin: user).",
      header: "plan interview",
      options,
      allow_freetext: true,
    });
  } catch {
    return;
  }
  if (!answer || answer === VERIFY_NONE_LABEL) return;

  const accepted: string[] = [];
  if (answer === VERIFY_ALL_LABEL) {
    for (const g of gates) accepted.push(g.command);
  } else {
    accepted.push(answer.trim());
  }
  for (const cmd of accepted) deps.store.addUserVerify(cmd);
  if (accepted.length > 0) {
    deps.onNote?.(
      `interview: recorded ${accepted.length} verify command(s) — they attach to verify-less steps at /plan finalize (check origin: user).`,
    );
  }
}

async function askBudgetQuestion(state: InterviewState, deps: PlanInterviewDeps): Promise<void> {
  const ask = deps.askUser;
  if (!ask || state.asked >= INTERVIEW_MAX_QUESTIONS) return;
  const { db, projectKey } = deps;
  if (!db || !projectKey) return;
  // Skip-gate: a routing profile already exists for this project (any source).
  try {
    if (db.getRoutingProfile(projectKey) !== null) return;
  } catch {
    return;
  }

  const options = [
    { label: "Cost-lean", description: "slider 3 — prefer cheaper models" },
    { label: "Balanced", description: "slider 5 — the config default" },
    { label: "Quality-lean", description: "slider 7.5 — prefer stronger models" },
  ];
  state.asked += 1;
  let answer: string | null = null;
  try {
    answer = await ask({
      question:
        'Cost/quality preference for routing in this repo? (Free text may add a per-call cost cap, e.g. "balanced, cap $0.05".)',
      header: "plan interview",
      options,
      allow_freetext: true,
    });
  } catch {
    return;
  }
  if (!answer) return;

  const { slider, maxCostPerCall } = parseBudgetAnswer(answer);
  if (slider !== null || maxCostPerCall !== null) {
    try {
      const patch: { slider?: number; maxCostPerCall?: number } = {};
      if (slider !== null) patch.slider = slider;
      if (maxCostPerCall !== null) patch.maxCostPerCall = maxCostPerCall;
      db.upsertRoutingProfile(projectKey, patch, "interview");
      deps.onProfileWrite?.();
      deps.onNote?.(
        `interview: routing profile saved (${[
          slider !== null ? `slider ${slider}` : null,
          maxCostPerCall !== null ? `cap $${maxCostPerCall}` : null,
        ]
          .filter(Boolean)
          .join(", ")}) — inspect with /profile show.`,
      );
    } catch {
      // profile write is bookkeeping — never break the plan turn
    }
  }
  // Free-text elaboration beyond the structured options is a durable preference.
  const structured = options.some((o) => o.label === answer);
  if (!structured) {
    try {
      db.insertMemory({
        projectKey,
        kind: "preference",
        content: answer.trim().slice(0, 500),
        evidenceSource: "human",
        origin: "user",
        status: "active",
        actor: "user",
      });
    } catch {
      // memory write is bookkeeping — never break the plan turn
    }
  }
}
