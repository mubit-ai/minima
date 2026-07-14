/**
 * exit_plan — let the model request leaving plan mode when the plan is ready (or the user
 * says to proceed). The decision stays with the USER: the tool surfaces an approval prompt
 * through the same AskUserRef seam as `question` — finalize & build / revise / cancel —
 * so enforcement lives in the overlay + dispatcher, never in prompt text. Interactive,
 * GT-plan-session-only: registered by enterPlanMode and disposed on exit, so headless
 * runs and the GT-off default path never see it.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import type { ParseResult, ToolSchema } from "../ai/types.ts";
import { text } from "../ai/types.ts";
import type { AskUserRef } from "./question.ts";

export const EXIT_PLAN_TOOL_NAME = "exit_plan";

const FINALIZE = "Finalize & build";
const REVISE = "Revise the plan";
const CANCEL = "Cancel plan mode";

export interface ExitPlanDeps {
  ask: AskUserRef;
  /** Shared /plan finalize path; ok=false (audit blocker, write failure) stays in plan mode. */
  finalize: () => Promise<{ ok: boolean; message: string }>;
  /** Discard the plan session and exit plan mode without writing anything. */
  cancel: () => void;
  /** Guards a second call in the same batch after the session is already gone. */
  isActive: () => boolean;
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
    return { ok: true, value: { summary: typeof obj.summary === "string" ? obj.summary : "" } };
  },
};

export function exitPlanTool(deps: ExitPlanDeps): AgentTool {
  return {
    name: EXIT_PLAN_TOOL_NAME,
    description:
      "Request to exit plan mode. Call this when the plan is solid, or whenever the user asks " +
      'to proceed with it ("go", "build it", "looks good"). The user is shown an approval ' +
      "prompt with three outcomes: finalize (the ground-truth document is written, plan mode " +
      "ends, and you begin implementing immediately), revise (you stay in plan mode and address " +
      "their note), or cancel (the plan is discarded — do not implement it). Never tell the " +
      "user to run slash commands; call this tool instead.",
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

      const summary = String(params.summary ?? "").trim();
      const choice = await ask({
        question: summary
          ? `The plan is ready:\n${summary}\n\nProceed?`
          : "The plan is ready. Proceed?",
        header: "plan",
        options: [
          {
            label: FINALIZE,
            description: "Write the ground truth, exit plan mode, start building.",
          },
          { label: REVISE, description: "Stay in plan mode and tell the planner what to change." },
          { label: CANCEL, description: "Discard the plan session — nothing is written." },
        ],
        allow_freetext: false,
      });

      if (choice === FINALIZE) {
        const r = await deps.finalize();
        return { content: [text(r.message)], details: { choice: "finalize", ok: r.ok } };
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
