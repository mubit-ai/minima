/**
 * A tiny JSON-Schema-SUBSET validator for typed sub-agent outputs (W4.3).
 *
 * Pure, dependency-free, and free of any agent/minima imports so `task.ts` can lean on it
 * without reaching into `minima/`. The subset is deliberately small and STRICTLY allowlisted:
 * a delegation may only author keywords the harness actually enforces, so an `output_schema`
 * never fakes a guarantee (e.g. `pattern`/`minimum`) that nothing checks.
 *
 * Supported keywords:
 *   type       — one of the 7 JSON primitives, or an array of them (a union)
 *   properties — object of sub-schemas (constrains named keys only; extras allowed)
 *   required   — array of property-name strings that must be present
 *   items      — sub-schema every array element must satisfy
 *   enum       — array of allowed values (deep-equality membership)
 * Accepted-but-not-enforced annotations: description, title, default, examples.
 * Everything else is rejected at authoring time.
 */

const SUPPORTED = new Set(["type", "properties", "required", "items", "enum"]);
const ANNOTATIONS = new Set(["description", "title", "default", "examples"]);
const PRIMITIVES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const MAX_ERRORS = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Recursively check that a schema uses only the supported subset (D2 authoring-time gate). */
export function schemaShapeErrors(schema: unknown, path = "#"): string[] {
  const errors: string[] = [];
  if (!isPlainObject(schema)) {
    errors.push(`${path}: schema must be a JSON object`);
    return errors;
  }
  for (const [key, val] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!SUPPORTED.has(key)) {
      errors.push(
        `${path}: unsupported keyword "${key}" (subset supports: type, properties, required, items, enum)`,
      );
      continue;
    }
    if (key === "type") {
      const ok =
        typeof val === "string"
          ? PRIMITIVES.has(val)
          : Array.isArray(val) &&
            val.length > 0 &&
            val.every((t) => typeof t === "string" && PRIMITIVES.has(t));
      if (!ok) {
        errors.push(
          `${path}/type: must be one of ${[...PRIMITIVES].join(", ")} (or an array of them)`,
        );
      }
    } else if (key === "properties") {
      if (!isPlainObject(val)) {
        errors.push(`${path}/properties: must be an object`);
      } else {
        for (const [prop, sub] of Object.entries(val)) {
          errors.push(...schemaShapeErrors(sub, `${path}/properties/${prop}`));
        }
      }
    } else if (key === "required") {
      if (!Array.isArray(val) || !val.every((r) => typeof r === "string")) {
        errors.push(`${path}/required: must be an array of property-name strings`);
      }
    } else if (key === "items") {
      errors.push(...schemaShapeErrors(val, `${path}/items`));
    } else if (key === "enum") {
      if (!Array.isArray(val) || val.length === 0) {
        errors.push(`${path}/enum: must be a non-empty array`);
      }
    }
  }
  return errors;
}

function matchesType(value: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function checkNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (errors.length >= MAX_ERRORS) return;
  const where = path === "" ? "(root)" : path;

  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((tt) => typeof tt === "string" && matchesType(value, tt))) {
      errors.push(`${where}: expected ${types.join(" | ")}, got ${jsonType(value)}`);
      return; // a type mismatch makes deeper checks noise
    }
  }
  if (errors.length >= MAX_ERRORS) return;

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push(
        `${where}: ${JSON.stringify(value)} is not one of ${schema.enum
          .map((e) => JSON.stringify(e))
          .join(", ")}`,
      );
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (errors.length >= MAX_ERRORS) return;
        if (typeof key === "string" && !(key in value)) {
          errors.push(`${path === "" ? "" : path}/${key}: required property missing`);
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (errors.length >= MAX_ERRORS) return;
        if (key in value && isPlainObject(sub)) {
          checkNode(value[key], sub, `${path === "" ? "" : path}/${key}`, errors);
        }
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const items = schema.items;
    for (let i = 0; i < value.length; i++) {
      if (errors.length >= MAX_ERRORS) return;
      checkNode(value[i], items, `${path === "" ? "" : path}/${i}`, errors);
    }
  }
}

/** Validate a parsed value against a subset schema. Returns error strings (empty = valid),
 *  capped at 8 with JSON-pointer-ish paths. */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  checkNode(value, schema, "", errors);
  return errors.slice(0, MAX_ERRORS);
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (exc) {
    return { ok: false, error: String(exc) };
  }
}

/** Fence-tolerant JSON extractor: (1) the whole trimmed text; (2) each fenced code block in
 *  order; (3) a balanced first-`{`→last-`}` slice, then first-`[`→last-`]`. */
export function extractJson(
  textIn: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const direct = tryParse(textIn.trim());
  if (direct.ok) return direct;

  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = fence.exec(textIn);
  while (m !== null) {
    const inner = tryParse(m[1]!.trim());
    if (inner.ok) return inner;
    m = fence.exec(textIn);
  }

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = textIn.indexOf(open);
    const end = textIn.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const slice = tryParse(textIn.slice(start, end + 1));
      if (slice.ok) return slice;
    }
  }
  return { ok: false, error: "no parseable JSON found in the reply" };
}

/** Build the single re-ask message: quotes the violations + the schema + an ONLY-JSON demand. */
export function reaskMessage(schema: Record<string, unknown>, errors: string[]): string {
  return [
    "Your previous reply did not satisfy the required output schema.",
    "",
    "Problems:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Required schema (JSON Schema):",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Reply with ONLY a single JSON value that satisfies the schema — no prose, no explanation, no markdown fences.",
  ].join("\n");
}
