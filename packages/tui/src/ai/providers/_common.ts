/**
 * Shared helpers for provider implementations.
 *
 * Port of minima_harness/ai/providers/_common.py.
 */

import type { ToolSchema } from "../types.ts";

/** Options value wins, then the first set environment variable. */
export function resolveApiKey(
  options: Record<string, unknown> | undefined,
  ...envVars: string[]
): string | undefined {
  if (options?.api_key) return String(options.api_key);
  for (const v of envVars) {
    const value = process.env[v];
    if (value) return value;
  }
  return undefined;
}

/**
 * A provider-agnostic JSON Schema for a tool's parameter model.
 *
 * In the Python port this derives the schema from a pydantic model and strips
 * title/anyOf-const noise. Here the ToolSchema already carries its jsonSchema,
 * so we just normalize it (drop `title`, flatten anyOf[{const}] -> enum).
 */
export function toJsonSchema(schema: ToolSchema): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(schema.jsonSchema));
  cleanSchema(clone);
  return clone;
}

function cleanSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) cleanSchema(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    delete obj.title;
    const anyOf = obj.anyOf;
    if (Array.isArray(anyOf) && anyOf.every((a) => a && typeof a === "object" && "const" in a)) {
      obj.enum = anyOf.map((a) => (a as { const: unknown }).const);
      delete obj.anyOf;
    }
    for (const v of Object.values(obj)) cleanSchema(v);
  }
}
