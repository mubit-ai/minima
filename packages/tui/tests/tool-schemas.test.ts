import { describe, expect, test } from "bun:test";
import { AgentState } from "../src/agent/state.ts";
import { toJsonSchema } from "../src/ai/providers/_common.ts";
import { toGeminiSchema } from "../src/ai/providers/google.ts";
import { checkpointTool, rewindTool } from "../src/tools/checkpoint_rewind.ts";
import { builtinTools } from "../src/tools/index.ts";

const tools = builtinTools();

// Conditional tools constructed directly with inert deps: the wire surface is pinned
// identically in both MINIMA_TUI_REWIND flag states (registration is what the flag gates).
const inertDeps = { getState: () => new AgentState(), db: null, getRunId: () => null };
const conditionalTools = [checkpointTool(inertDeps), rewindTool(inertDeps)];

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
});
