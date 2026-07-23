import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "../src/ai/providers/_common.ts";
import { toGeminiSchema } from "../src/ai/providers/google.ts";
import { builtinTools } from "../src/tools/index.ts";

const tools = builtinTools();

describe("tool schema surface (model-agnostic gate)", () => {
  test("builtin roster is pinned", () => {
    expect(tools.map((t) => t.name)).toMatchSnapshot();
  });

  for (const t of tools) {
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
