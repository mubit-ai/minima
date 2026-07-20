/**
 * question — let the model ask the user a structured question mid-run.
 * Port of minima_harness/tools/question.py.
 *
 * When a request is ambiguous, the model would otherwise guess and be corrected
 * on the next turn — a full, billed round-trip. This tool turns that into one
 * cheap clarifying exchange: the model offers a few options, the user picks one
 * (or types a custom answer), and the choice comes back as the tool result.
 *
 * Interactive-only: bound to a TUI callback via an AskUserRef. In headless modes
 * the ref stays null and the tool tells the model to proceed on its best
 * assumption rather than block.
 */

import { type AgentTool, type ToolResult, errorResult } from "../agent/tools.ts";
import type { ParseResult, ToolSchema } from "../ai/types.ts";
import { text } from "../ai/types.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionParams {
  question: string;
  header: string;
  options: QuestionOption[];
  allow_freetext: boolean;
}

/** The TUI provides this: show the question, return the chosen answer, or null if dismissed. */
export type AskUser = (params: QuestionParams) => Promise<string | null>;

/** A late-bound slot for the ask callback (tools are built before the TUI mounts). */
export interface AskUserRef {
  current: AskUser | null;
}

// The objectSchema helper is scalar-only, so hand-build the schema to express the
// nested `options` array (array-of-objects) that this tool needs.
const parameters: ToolSchema = {
  jsonSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user." },
      header: {
        type: "string",
        description: "Optional short topic label (a few words).",
        default: "",
      },
      options: {
        type: "array",
        description: "The choices to offer (ideally 2–4).",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "A short answer the user can pick." },
            description: {
              type: "string",
              description: "Optional one-line explanation of this option.",
            },
          },
          required: ["label"],
        },
        default: [],
      },
      allow_freetext: {
        type: "boolean",
        description: "Let the user type a custom answer instead of picking an option.",
        default: true,
      },
    },
    required: ["question"],
  },
  validate(value): ParseResult<Record<string, unknown>> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, errors: ["parameters must be an object"] };
    }
    const obj = value as Record<string, unknown>;
    const errors: string[] = [];

    if (typeof obj.question !== "string" || !obj.question) {
      errors.push("question: required");
    }
    const header = typeof obj.header === "string" ? obj.header : "";
    const allowFreetext = typeof obj.allow_freetext === "boolean" ? obj.allow_freetext : true;

    const options: QuestionOption[] = [];
    if (obj.options !== undefined && obj.options !== null) {
      if (!Array.isArray(obj.options)) {
        errors.push("options: must be an array");
      } else {
        obj.options.forEach((raw, i) => {
          // Be lenient about the shapes weaker models emit: a bare string is shorthand for
          // { label }, and title/name/text/value are common aliases for `label`.
          if (typeof raw === "string") {
            if (raw.trim()) options.push({ label: raw });
            return;
          }
          const o = (raw ?? {}) as Record<string, unknown>;
          const labelRaw = o.label ?? o.title ?? o.name ?? o.text ?? o.value;
          if (typeof labelRaw !== "string" || !labelRaw) {
            errors.push(`options[${i}].label: required`);
            return;
          }
          options.push({
            label: labelRaw,
            description: typeof o.description === "string" ? o.description : undefined,
          });
        });
      }
    }

    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: { question: obj.question, header, options, allow_freetext: allowFreetext },
    };
  },
};

export function questionTool(ref: AskUserRef): AgentTool {
  return {
    name: "question",
    description:
      "Ask the user a single clarifying question and wait for their answer. Use this ONLY " +
      "when you are genuinely blocked by ambiguity or need a decision/confirmation you " +
      "cannot resolve yourself — never for something you could determine by reading or " +
      "searching the code. NEVER use this tool to greet, chat, acknowledge, deliver your " +
      "answer, or ask an open-ended 'what would you like?' — reply with plain text for all " +
      "of that. If you are not offering concrete choices, you almost certainly want a plain " +
      "reply, not this tool. Put all the choices in this tool's single `options` array argument " +
      "(do NOT call a separate tool per choice); each entry may be a short string, or an " +
      "object {label, description}. Offer 2-4 options; the user picks one or types a custom " +
      "answer. Keep `header` to a few words. Their answer is returned as the tool result; if no " +
      "user is available or they dismiss it, proceed with your best judgment.",
    parameters,
    executionMode: "sequential",
    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const ask = ref.current;
      const qp: QuestionParams = {
        question: String(params.question ?? ""),
        header: String(params.header ?? ""),
        options: (params.options as QuestionOption[]) ?? [],
        allow_freetext: params.allow_freetext !== false,
      };
      if (!ask) {
        return {
          content: [
            text(
              "No interactive user is available to answer (headless mode). Proceed with your " +
                "best assumption and state the assumption you made.",
            ),
          ],
          details: { answered: false, reason: "headless" },
        };
      }
      let answer: string | null;
      try {
        answer = await ask(qp);
      } catch (exc) {
        return errorResult(`question failed: ${String(exc)}`);
      }
      if (!answer) {
        return {
          content: [
            text(
              "The user dismissed the question without answering. Proceed using your best judgment.",
            ),
          ],
          details: { answered: false, reason: "dismissed" },
        };
      }
      return {
        content: [text(`The user answered: ${answer}`)],
        details: { answered: true, answer },
      };
    },
  };
}
