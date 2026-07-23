/**
 * A tiny object-schema builder — the TS analogue of a pydantic `BaseModel` for tool
 * parameters. Each tool declares its params as `objectSchema({...}, [...required])`,
 * getting both a JSON Schema (sent to the model) and a validator (checked before
 * execute) without pulling in a runtime validator dependency.
 */

import type { ToolSchema } from "../ai/types.ts";

export type PropType = "string" | "integer" | "number" | "boolean";

export interface PropSpec {
  type: PropType;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
  /** Normalize a present raw value BEFORE the type check (R3a: e.g. todowrite re-encodes an
   * unencoded array into its string-of-JSON contract, so array args survive the loop's
   * pre-execute validation). Never runs on missing values — defaults/required come first —
   * and is NOT serialized into the model-visible JSON Schema. */
  coerce?: (v: unknown) => unknown;
}

export type ObjectSchemaSpec = Record<string, PropSpec>;

function typeOk(type: PropType, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
  }
}

export function objectSchema(props: ObjectSchemaSpec, required: string[]): ToolSchema {
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    const p: Record<string, unknown> = { type: spec.type, description: spec.description ?? "" };
    if (spec.default !== undefined) p.default = spec.default;
    if (spec.enum) p.enum = spec.enum;
    properties[name] = p;
  }
  const jsonSchema = { type: "object", properties, required };
  return {
    jsonSchema,
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, errors: ["parameters must be an object"] };
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const errors: string[] = [];
      for (const [name, spec] of Object.entries(props)) {
        let v: unknown = obj[name];
        if (v === undefined || v === null) {
          if (spec.default !== undefined) {
            v = spec.default;
          } else if (required.includes(name)) {
            errors.push(`${name}: required`);
            continue;
          } else {
            continue;
          }
        }
        if (spec.coerce) v = spec.coerce(v);
        if (typeOk(spec.type, v)) {
          if (spec.enum && !spec.enum.includes(v as string | number)) {
            errors.push(`${name}: must be one of ${spec.enum.join(", ")}`);
            continue;
          }
          out[name] = v;
        } else {
          errors.push(`${name}: expected ${spec.type}`);
        }
      }
      if (errors.length) return { ok: false, errors };
      return { ok: true, value: out };
    },
  };
}
