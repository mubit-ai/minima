import { describe, expect, test } from "bun:test";
import { AgentState } from "../src/agent/state.ts";
import { toJsonSchema } from "../src/ai/providers/_common.ts";
import { toGeminiSchema } from "../src/ai/providers/google.ts";
import { BgJobRegistry } from "../src/tools/_bgjobs.ts";
import { bashTool } from "../src/tools/bash.ts";
import { bgJobTool } from "../src/tools/bgjob.ts";
import { checkpointTool, rewindTool } from "../src/tools/checkpoint_rewind.ts";
import { builtinTools } from "../src/tools/index.ts";
import { taskTool } from "../src/tools/task.ts";

const tools = builtinTools();

// Conditional tools constructed directly with inert deps: the wire surface is pinned
// identically in both flag states (registration is what the flag gates). The task tool
// (D1) advertises output_schema regardless of MINIMA_TUI_TYPED_TASK — the flag gates
// enforcement, never the wire schema — so its inert construction pins the surface once.
const inertDeps = { getState: () => new AgentState(), db: null, getRunId: () => null };
const conditionalTools = [
  checkpointTool(inertDeps),
  rewindTool(inertDeps),
  taskTool({
    spawn: async () => {
      throw new Error("inert spawn (schema surface only)");
    },
  }),
];

// W4.1 additive variants (inert registry): the bgjobs-on `bash` (with `background`) and the
// `bgjob` control tool. Pinned under distinct names so the DEFAULT bash entry stays untouched.
const bgRegistry = new BgJobRegistry();
const bgjobsVariants = [bashTool({ bgJobs: bgRegistry }), bgJobTool(bgRegistry)];

describe("tool schema surface (model-agnostic gate)", () => {
  test("builtin roster is pinned", () => {
    expect(tools.map((t) => t.name)).toMatchSnapshot();
  });

  for (const t of [...tools, ...conditionalTools]) {
    test(`jsonSchema pinned across all provider conversions: ${t.name}`, () => {
      expect({
        description: t.description,
        anthropic_input_schema: toJsonSchema(t.parameters),
        openai_function_parameters: toJsonSchema(t.parameters),
        google_function_declaration_parameters: toGeminiSchema(t.parameters),
      }).toMatchSnapshot();
    });
  }

  for (const t of bgjobsVariants) {
    test(`jsonSchema pinned across all provider conversions (bgjobs): ${t.name}`, () => {
      expect({
        description: t.description,
        anthropic_input_schema: toJsonSchema(t.parameters),
        openai_function_parameters: toJsonSchema(t.parameters),
        google_function_declaration_parameters: toGeminiSchema(t.parameters),
      }).toMatchSnapshot();
    });
  }
});
