/**
 * runPlanTurn — the plan-mode conversational turn, extracted from the TUI closure so it is
 * testable: optionally convene the design council, fold its result into the in-memory
 * session, surface decision questions, then re-anchor the planner and let it reply.
 *
 * ONE AbortController covers the WHOLE turn (council + question overlay + planner reply),
 * stashed in deps.controllerRef before convening and nulled in a finally — Esc aborts
 * through it. An aborted round still merges its partial result (the research was paid for)
 * but ENDS the turn: no question overlay and no fresh planner LLM call, even when the abort
 * raced synthesis (runCouncilRound can return aborted:true WITH questions).
 *
 * Council spend is booked by THIS caller: a BudgetLedger reserve/reconcile pair per round
 * (note "plan council rN", rec_id NULL — researcher rec_ids already land in
 * routing_decisions) and one lead CostMeter row so /cost shows it. Reachable only when
 * config.bigPlan planted a PlanSessionStore — the default path never gets here.
 */

import { errText } from "../errtext.ts";
import type { AskUser } from "../tools/question.ts";
import type { BudgetLedger } from "./budget.ts";
import type { CostMeter } from "./meter.ts";
import { shouldConveneFullCouncil } from "./plan_council.ts";
import type {
  CouncilRoundResult,
  KeeperMiniResult,
  PlanSession,
  PlanSessionStore,
} from "./plan_session.ts";
import type { RoutingResult } from "./router.ts";

export interface PlanTurnDeps {
  /** One council round; injected so tests never convene a real council. */
  runRound: (
    session: PlanSession,
    text: string,
    opts: { signal: AbortSignal; roundBudgetUsd?: number },
  ) => Promise<CouncilRoundResult>;
  /** Question overlay; null in headless — surfaced questions stay open in the session. */
  askUser: AskUser | null;
  /** Surface a note in the conversation (council summary, skips, aborts). */
  onNote: (text: string, isError?: boolean) => void;
  /** The planner's system prompt for this turn (persona + snapshot projection). */
  buildSystem: (store: PlanSessionStore) => string;
  /** Run the planner reply under `systemPrompt` (promptRouted + routing surfacing). */
  promptPlanner: (text: string, systemPrompt: string) => Promise<RoutingResult | null>;
  /** Whole-turn AbortController stash; Esc aborts through it. */
  controllerRef: { current: AbortController | null };
  /** Convene heuristic (default shouldConveneFullCouncil — MP15: substance AND stakes). */
  convene?: (text: string, session: PlanSession) => boolean;
  /** MP15: keeper mini-update for non-council turns — folds the planner's reply into the
   *  draft (one cheap meta call). Optional; absent = the draft stales between councils. */
  runMiniUpdate?: (
    session: PlanSession,
    text: string,
    o: { signal: AbortSignal },
  ) => Promise<{ update: KeeperMiniResult | null; costUsd: number }>;
  /** Session budget: each round reserves before and reconciles realized spend after. */
  budget?: BudgetLedger | null;
  /** Lead cost meter: one row per council round so /cost shows the spend. */
  meter?: CostMeter | null;
  /** Per-round soft cap in USD (config.planRoundBudgetUsd). */
  roundBudgetUsd?: number;
  /** Plan interview (opt-in): runs after a convened round has presented SYNTH's own
   *  decision-point questions, reusing the same overlay. Absent = inert (default path). */
  runInterview?: (o: { signal: AbortSignal }) => Promise<void>;
}

export async function runPlanTurn(
  store: PlanSessionStore,
  text: string,
  deps: PlanTurnDeps,
): Promise<void> {
  store.adoptGoalIfEmpty(text);
  store.recordUserTurn(text);

  const controller = new AbortController();
  deps.controllerRef.current = controller;
  try {
    const convene = deps.convene ?? ((t: string, s: PlanSession) => shouldConveneFullCouncil(s, t));
    const convened = convene(text, store.session);
    if (convened) {
      const proceed = await conveneCouncil(store, text, controller, deps);
      if (!proceed) return;
    }
    await deps.promptPlanner(text, deps.buildSystem(store));
    // MP15: on a planner-only turn the keeper folds the reply into the draft so MP16's
    // draft view never stales between councils. Only for NON-convened turns — a convened
    // round already replaced the draft; the budget-exhausted/error "proceed" paths were
    // convened and intentionally get no mini-update either.
    if (!convened && deps.runMiniUpdate && !controller.signal.aborted) {
      await runMiniUpdateBudgeted(store, text, controller, deps);
    }
  } finally {
    if (deps.controllerRef.current === controller) deps.controllerRef.current = null;
  }
}

/** MP15: reserve → run → reconcile the keeper mini-update. Silent fail-open: a failed or
 *  skipped update leaves the draft stale (the next stakes council repairs it) — no note,
 *  because a per-turn bookkeeping whine would out-noise the feature. */
const MINI_UPDATE_RESERVE_USD = 0.05;

async function runMiniUpdateBudgeted(
  store: PlanSessionStore,
  text: string,
  controller: AbortController,
  deps: PlanTurnDeps,
): Promise<void> {
  const budget = deps.budget ?? null;
  if (budget && budget.mode === "enforce" && budget.exhausted()) return;
  const label = "plan keeper update";
  let reservationId: string | null = null;
  if (budget) {
    const remaining = budget.status().remainingUsd;
    const r = budget.reserve(Math.min(MINI_UPDATE_RESERVE_USD, Math.max(0, remaining)), label);
    if (!r.ok) return;
    reservationId = r.id;
  }
  try {
    if (!deps.runMiniUpdate) return;
    const { update, costUsd } = await deps.runMiniUpdate(store.session, text, {
      signal: controller.signal,
    });
    const realized = Number.isFinite(costUsd) ? costUsd : 0;
    if (budget && reservationId) budget.reconcile(reservationId, realized, label);
    deps.meter?.record({
      label,
      routing: null,
      actualCostUsd: realized,
      quality: null,
      outcome: "success",
    });
    if (update && !controller.signal.aborted) store.applyKeeperUpdate(update, realized);
  } catch {
    if (budget && reservationId) budget.release(reservationId);
  }
}

/** Run one budgeted council round. Returns false when the turn must END (abort). Fail-open:
 *  any council failure degrades to a planner-only turn rather than breaking the conversation. */
async function conveneCouncil(
  store: PlanSessionStore,
  text: string,
  controller: AbortController,
  deps: PlanTurnDeps,
): Promise<boolean> {
  const budget = deps.budget ?? null;
  if (budget && budget.mode === "enforce" && budget.exhausted()) {
    deps.onNote("ℹ council skipped: budget exhausted — planner reply only");
    return true;
  }

  const label = `plan council r${store.session.rounds + 1}`;
  let roundBudgetUsd =
    deps.roundBudgetUsd !== undefined && Number.isFinite(deps.roundBudgetUsd)
      ? deps.roundBudgetUsd
      : undefined;
  if (budget) {
    const remaining = budget.status().remainingUsd;
    roundBudgetUsd = roundBudgetUsd === undefined ? remaining : Math.min(roundBudgetUsd, remaining);
  }

  let reservationId: string | null = null;
  if (budget && roundBudgetUsd !== undefined) {
    const r = budget.reserve(roundBudgetUsd, label);
    if (r.ok) reservationId = r.id;
    else {
      deps.onNote(`ℹ council skipped: ${r.reason}`);
      return true;
    }
  }

  try {
    const result = await deps.runRound(store.session, text, {
      signal: controller.signal,
      roundBudgetUsd,
    });
    store.applyCouncilResult(result);
    const aborted = result.aborted || controller.signal.aborted;
    const realized = Number.isFinite(result.costUsd) ? result.costUsd : 0;
    if (budget && reservationId) budget.reconcile(reservationId, realized, label);
    deps.meter?.record({
      label,
      routing: null,
      actualCostUsd: realized,
      quality: null,
      outcome: aborted ? "aborted" : "success",
    });

    const lines: string[] = [];
    if (result.aborted) lines.push("(council aborted early)");
    for (const f of result.faults) lines.push(`⚠ ${f.severity}: ${f.summary}`);
    for (const f of result.findings) lines.push(`• ${f.source}: ${f.summary}`);
    lines.push(`council cost $${realized.toFixed(4)} · round ${store.session.rounds}`);
    deps.onNote(lines.join("\n"));

    // An abort ends the WHOLE turn: partial results are kept (paid for), but no question
    // overlay and no fresh planner call — even when the abort raced synthesis and the
    // round still carried questions.
    if (aborted) {
      deps.onNote("(plan turn aborted — partial council results kept, planner not called)");
      return false;
    }
    if (deps.askUser) {
      for (const q of result.questions) {
        if (controller.signal.aborted) {
          deps.onNote("(plan turn aborted — planner not called)");
          return false;
        }
        const answer = await deps.askUser({
          question: q.why ? `${q.question}\n(${q.why})` : q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          allow_freetext: true,
        });
        if (answer != null) store.answerQuestion(q.question, answer);
      }
    }
    if (controller.signal.aborted) {
      deps.onNote("(plan turn aborted — planner not called)");
      return false;
    }
    // Plan interview (opt-in): right after the round's own decision-points were
    // presented, so the council never re-asks what the interview covers and vice versa.
    // Fail-open — a broken interview never costs the planner reply.
    if (deps.runInterview && deps.askUser) {
      try {
        await deps.runInterview({ signal: controller.signal });
      } catch {
        // interview is strictly additive
      }
      if (controller.signal.aborted) {
        deps.onNote("(plan turn aborted — planner not called)");
        return false;
      }
    }
    return true;
  } catch (exc) {
    if (budget && reservationId) budget.release(reservationId);
    deps.onNote(`ℹ council skipped: ${errText(exc)}`);
    return true;
  }
}
