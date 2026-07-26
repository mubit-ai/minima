import { describe, expect, test } from "bun:test";
import {
  extractJson,
  reaskMessage,
  schemaShapeErrors,
  validateAgainstSchema,
} from "../src/tools/output_schema.ts";

describe("schemaShapeErrors (D2 authoring allowlist)", () => {
  test("accepts the supported subset and its annotations", () => {
    expect(
      schemaShapeErrors({
        type: "object",
        title: "Result",
        description: "the result",
        default: {},
        examples: [{}],
        properties: {
          answer: { type: "number", description: "the number" },
          tags: { type: "array", items: { type: "string" } },
          mode: { enum: ["a", "b"] },
          nullable: { type: ["string", "null"] },
        },
        required: ["answer"],
      }),
    ).toEqual([]);
  });

  test("rejects unsupported keywords by name and path", () => {
    const errs = schemaShapeErrors({ type: "string", pattern: "^x$", minimum: 1 });
    expect(errs.some((e) => e.includes('"pattern"'))).toBe(true);
    expect(errs.some((e) => e.includes('"minimum"'))).toBe(true);
    // reject nested unsupported keywords too
    const nested = schemaShapeErrors({
      type: "object",
      properties: { a: { type: "string", additionalProperties: false } },
    });
    expect(nested.some((e) => e.includes("properties/a") && e.includes('"additionalProperties"'))).toBe(
      true,
    );
  });

  test("rejects a non-object schema and bad keyword values", () => {
    expect(schemaShapeErrors("nope")).not.toEqual([]);
    expect(schemaShapeErrors({ type: "widget" }).some((e) => e.includes("/type"))).toBe(true);
    expect(schemaShapeErrors({ type: [] }).some((e) => e.includes("/type"))).toBe(true);
    expect(schemaShapeErrors({ required: "answer" }).some((e) => e.includes("/required"))).toBe(true);
    expect(schemaShapeErrors({ enum: [] }).some((e) => e.includes("/enum"))).toBe(true);
    expect(schemaShapeErrors({ properties: [] }).some((e) => e.includes("/properties"))).toBe(true);
  });
});

describe("validateAgainstSchema (subset semantics)", () => {
  test("primitive types incl. integer vs number and null", () => {
    expect(validateAgainstSchema("x", { type: "string" })).toEqual([]);
    expect(validateAgainstSchema(3, { type: "integer" })).toEqual([]);
    expect(validateAgainstSchema(3.5, { type: "integer" })).not.toEqual([]);
    expect(validateAgainstSchema(3.5, { type: "number" })).toEqual([]);
    expect(validateAgainstSchema(null, { type: "null" })).toEqual([]);
    expect(validateAgainstSchema(null, { type: ["string", "null"] })).toEqual([]);
    expect(validateAgainstSchema(1, { type: "boolean" })[0]).toContain("expected boolean");
  });

  test("required + properties + nested paths", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "object", properties: { c: { type: "string" } } } },
      required: ["a", "b"],
    };
    expect(validateAgainstSchema({ a: 1, b: { c: "ok" } }, schema)).toEqual([]);
    expect(validateAgainstSchema({ b: { c: "ok" } }, schema)[0]).toContain("/a: required");
    const nested = validateAgainstSchema({ a: 1, b: { c: 5 } }, schema);
    expect(nested[0]).toContain("/b/c");
    expect(nested[0]).toContain("expected string");
  });

  test("items validates every array element", () => {
    const schema = { type: "array", items: { type: "number" } };
    expect(validateAgainstSchema([1, 2, 3], schema)).toEqual([]);
    const errs = validateAgainstSchema([1, "two", 3], schema);
    expect(errs[0]).toContain("/1");
    expect(errs[0]).toContain("expected number");
  });

  test("enum membership uses deep equality", () => {
    expect(validateAgainstSchema("b", { enum: ["a", "b"] })).toEqual([]);
    expect(validateAgainstSchema({ x: 1 }, { enum: [{ x: 1 }] })).toEqual([]);
    expect(validateAgainstSchema("z", { enum: ["a", "b"] })[0]).toContain("is not one of");
  });

  test("errors are capped at 8", () => {
    const props: Record<string, unknown> = {};
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      props[`k${i}`] = { type: "number" };
      value[`k${i}`] = "wrong";
    }
    const errs = validateAgainstSchema(value, { type: "object", properties: props });
    expect(errs).toHaveLength(8);
  });
});

describe("extractJson (fence-tolerant ladder)", () => {
  test("parses whole-text JSON", () => {
    const r = extractJson('  {"a": 1}  ');
    expect(r.ok && r.value).toEqual({ a: 1 });
  });

  test("pulls a fenced ```json block out of prose", () => {
    const r = extractJson('Here:\n```json\n{"a": 2}\n```\ndone');
    expect(r.ok && r.value).toEqual({ a: 2 });
  });

  test("tolerates an untagged fence and falls through to a balanced slice", () => {
    expect((extractJson("result:\n```\n[1,2,3]\n```") as { value: unknown }).value).toEqual([1, 2, 3]);
    expect((extractJson('prefix {"a": 3} suffix') as { value: unknown }).value).toEqual({ a: 3 });
    expect((extractJson("prefix [1, 2] suffix") as { value: unknown }).value).toEqual([1, 2]);
  });

  test("fails cleanly when there is no JSON", () => {
    const r = extractJson("no json here at all");
    expect(r.ok).toBe(false);
  });
});

describe("reaskMessage", () => {
  test("quotes the errors, the schema, and demands ONLY JSON", () => {
    const msg = reaskMessage({ type: "object" }, ["/a: required property missing"]);
    expect(msg).toContain("/a: required property missing");
    expect(msg).toContain('"type": "object"');
    expect(msg).toContain("ONLY");
  });
});
