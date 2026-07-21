/**
 * exit_plan — let the model request leaving plan mode when the plan is ready (or the user
 * says to proceed). The decision stays with the USER: the tool surfaces an approval prompt
 * through the same AskUserRef seam as `question` — finalize (auto-accept or build) /
 * revise / cancel — so enforcement lives in the overlay + dispatcher, never in prompt
 * text. Interactive: registered whenever plan mode is on (MP17 — GT on OR off), disposed
 * on exit; headless runs get the ask-null guard.
 *
 * MP17 (universal gate): without a GT plan session there is no store to finalize from, so
 * the tool REQUIRES the complete plan as a markdown argument (CC's ExitPlanMode contract) —
 * `showPlan` pushes it into the transcript first, so the user approves exactly what they
 * can see. With a session, the store/finalize path is authoritative and the argument is
 * ignored.
 *
 * CC's ExitPlanMode dialog shape (2026-07-20): the first approve flavor lands the mode on
 * accept-edits (implementation edits pre-approved, cwd-scoped), the second on build
 * (per-edit prompts). Both run the SAME finalize; only the landing mode differs.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import type { ParseResult, ToolSchema } from "../ai/types.ts";
import { text } from "../ai/types.ts";
import type { AskUserRef } from "./question.ts";

export const EXIT_PLAN_TOOL_NAME = "exit_plan";

const FINALIZE_AUTO = "Finalize & auto-accept edits";
const FINALIZE = "Finalize & build";
const REVISE = "Revise the plan";
const CANCEL = "Cancel plan mode";

export interface ExitPlanDeps {
  ask: AskUserRef;
  /** Shared finalize path. planMd is the tool's `plan` argument on the sessionless (GT-off)
   *  path, null on the store path; ok=false (audit blocker, write failure) stays in plan mode.
   *  autoAcceptEdits lands the post-approval mode on accept-edits instead of build. */
  finalize: (
    planMd: string | null,
    autoAcceptEdits: boolean,
  ) => Promise<{ ok: boolean; message: string }>;
  /** Discard the plan (session if any) and exit plan mode without writing anything. */
  cancel: () => void;
  /** Guards a second call in the same batch after plan mode already ended. */
  isActive: () => boolean;
  /** True when no GT plan session exists — the `plan` argument becomes REQUIRED. */
  requiresPlan: () => boolean;
  /** Surface the plan markdown (transcript push) before the approval ask. */
  showPlan?: (planMd: string) => void;
}

const parameters: ToolSchema = {
  jsonSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Optional 1-2 sentence recap of the plan, shown in the approval prompt.",
        default: "",
      },
      plan: {
        type: "string",
        description:
          "The complete plan as markdown. REQUIRED when no ground-truth plan session is " +
          "active — it is exactly what the user reviews and approves.",
        default: "",
      },
    },
    required: [],
  },
  validate(value): ParseResult<Record<string, unknown>> {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "object" || Array.isArray(value))
    ) {
      return { ok: false, errors: ["parameters must be an object"] };
    }
    const obj = (value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        summary: typeof obj.summary === "string" ? obj.summary : "",
        plan: typeof obj.plan === "string" ? obj.plan : "",
      },
    };
  },
};

export function exitPlanTool(deps: ExitPlanDeps): AgentTool {
  return {
    name: EXIT_PLAN_TOOL_NAME,
    description:
      "Request to exit plan mode. Call this when the plan is solid, or whenever the user asks " +
      'to proceed with it ("go", "build it", "looks good"). Pass the COMPLETE plan as markdown ' +
      "in `plan` — it is what the user reviews and approves. The user is shown an approval " +
      "prompt with three outcomes: approve (plan mode ends and you begin implementing " +
      "immediately — the user chooses whether your edits are pre-approved or reviewed one by " +
      "one), revise (you stay in plan mode and address their note), or cancel (the plan is " +
      "discarded — do not implement it). Never tell the user to run slash commands; call this " +
      "tool instead.",
    parameters,
    executionMode: "sequential",
    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | null,
    ): Promise<ToolResult> {
      if (!deps.isActive()) {
        return {
          content: [text("Plan mode is not active — no plan session to exit.")],
          details: { choice: "inactive" },
        };
      }
      const ask = deps.ask.current;
      if (!ask) {
        return {
          content: [
            text(
              "No interactive user is available to approve exiting plan mode. Continue planning.",
            ),
          ],
          details: { choice: "headless" },
        };
      }
      if (signal?.aborted) return errorResult("exit_plan aborted");

      const planMd = String(params.plan ?? "").trim();
      const sessionless = deps.requiresPlan();
      if (sessionless && !planMd) {
        return errorResult(
          "exit_plan requires the `plan` argument here: resend with the complete plan as " +
            "markdown in `plan` so the user can review what they are approving.",
        );
      }
      if (sessionless) deps.showPlan?.(planMd);

      const summary = String(params.summary ?? "").trim();
      const choice = await ask({
        question: summary
          ? `The plan is ready:\n${summary}\n\nProceed?`
          : "The plan is ready. Proceed?",
        header: "plan",
        options: [
          {
            label: FINALIZE_AUTO,
            description:
              "Approve, exit plan mode into accept-edits — file edits inside the project are pre-approved.",
          },
          {
            label: FINALIZE,
            description: "Approve, exit plan mode, build with per-edit approval.",
          },
          { label: REVISE, description: "Stay in plan mode and tell the planner what to change." },
          { label: CANCEL, description: "Discard the plan session — nothing is written." },
        ],
        allow_freetext: false,
      });

      if (choice === FINALIZE_AUTO || choice === FINALIZE) {
        const r = await deps.finalize(sessionless ? planMd : null, choice === FINALIZE_AUTO);
        return {
          content: [text(r.message)],
          details: { choice: "finalize", ok: r.ok, autoAcceptEdits: choice === FINALIZE_AUTO },
        };
      }

      if (choice === REVISE) {
        if (signal?.aborted) return errorResult("exit_plan aborted");
        const note = await ask({
          question: "What should the planner change?",
          header: "revise",
          options: [],
          allow_freetext: true,
        });
        if (note?.trim()) {
          return {
            content: [
              text(
                `The user wants the plan revised before building:\n${note.trim()}\nStay in plan mode: update the plan to address this, then call exit_plan again.`,
              ),
            ],
            details: { choice: "revise", note: note.trim() },
          };
        }
        return {
          content: [
            text("The user chose to revise but left no note. Stay in plan mode and keep planning."),
          ],
          details: { choice: "revise", note: null },
        };
      }

      if (choice === CANCEL) {
        deps.cancel();
        return {
          content: [
            text(
              "The user canceled plan mode: the plan session was discarded, no ground-truth " +
                "document was written, and the plan is NOT approved. Do not implement it. " +
                "Stop and wait for the user's next message.",
            ),
          ],
          details: { choice: "cancel" },
          terminate: true,
        };
      }

      return {
        content: [
          text("The user dismissed the exit-plan prompt. Stay in plan mode and continue planning."),
        ],
        details: { choice: "dismissed" },
      };
    },
  };
}
