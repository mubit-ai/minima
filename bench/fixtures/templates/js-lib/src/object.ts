/**
 * Deep object utilities: cloning, structural equality, deep merge with
 * configurable array strategies, dotted-path access, and structural diff.
 *
 * "Plain object" below means an object literal-like value (prototype is
 * Object.prototype or null). Class instances, Maps, Dates, etc. are treated
 * as opaque leaf values: compared by identity semantics in `deepEqual` only
 * where structurally comparable, and replaced (never merged) by `deepMerge`.
 */

/** How {@link deepMerge} combines two arrays found at the same path. */
export type ArrayStrategy = "replace" | "concat" | "union";

export interface MergeOptions {
  /**
   * Array strategy, applied at *every* depth of the merge:
   *   - "replace" (default): the source array wins wholesale;
   *   - "concat": target elements followed by source elements;
   *   - "union": concat, but skip source elements deep-equal to an element
   *     already present.
   */
  arrays?: ArrayStrategy;
}

/** True for object-literal-like values (prototype Object.prototype/null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively clone plain objects and arrays; leaves are returned as-is. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/**
 * Structural equality for JSON-like data: plain objects compared by keys,
 * arrays element-wise, everything else with SameValueZero (so NaN equals
 * NaN, and +0 equals -0).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b || (Number.isNaN(a as number) && Number.isNaN(b as number))) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Combine two arrays according to an {@link ArrayStrategy}. */
function mergeArrays(target: unknown[], source: unknown[], strategy: ArrayStrategy): unknown[] {
  switch (strategy) {
    case "replace":
      return deepClone(source);
    case "concat":
      return [...deepClone(target), ...deepClone(source)];
    case "union": {
      const out = deepClone(target);
      for (const v of source) {
        if (!out.some((existing) => deepEqual(existing, v))) out.push(deepClone(v));
      }
      return out;
    }
  }
}

/** Recursive worker for {@link deepMerge}; carries the array strategy down. */
function mergeValues(target: unknown, source: unknown, arrays: ArrayStrategy): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return mergeArrays(target, source, arrays);
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(target)) out[k] = deepClone(v);
    for (const [k, v] of Object.entries(source)) {
      out[k] = Object.hasOwn(target, k) ? mergeValues(target[k], v, arrays) : deepClone(v);
    }
    return out;
  }
  return deepClone(source);
}

/**
 * Recursively merge `source` into `target`, returning a new object; neither
 * input is mutated.
 *
 * Plain objects merge key-by-key at any depth. Arrays are combined with the
 * configured {@link ArrayStrategy} — the same strategy applies no matter how
 * deeply the arrays are nested. Any other value (or a type mismatch between
 * target and source) resolves to a clone of the source value.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  options: MergeOptions = {},
): Record<string, unknown> {
  const arrays = options.arrays ?? "replace";
  return mergeValues(target, source, arrays) as Record<string, unknown>;
}

/** Split a dotted path into keys; arrays are used as-is. */
function toPath(path: string | ReadonlyArray<string | number>): (string | number)[] {
  if (Array.isArray(path)) return [...path] as (string | number)[];
  if ((path as string).length === 0) return [];
  return (path as string).split(".").map((seg) => {
    const n = Number(seg);
    return Number.isInteger(n) && String(n) === seg && n >= 0 ? n : seg;
  });
}

/**
 * Read the value at a dotted path (e.g. `"a.items.0.name"`) or an explicit
 * key array. Returns `fallback` when any segment is missing or traverses a
 * non-container value. Numeric segments index arrays.
 */
export function getPath<T = unknown>(
  obj: unknown,
  path: string | ReadonlyArray<string | number>,
  fallback?: T,
): T | undefined {
  let current: unknown = obj;
  for (const key of toPath(path)) {
    if (Array.isArray(current) && typeof key === "number") {
      current = current[key];
    } else if (isPlainObject(current) && Object.hasOwn(current, String(key))) {
      current = current[String(key)];
    } else {
      return fallback;
    }
    if (current === undefined) return fallback;
  }
  return current as T;
}

/**
 * Set the value at a dotted path, mutating `obj` in place and returning it.
 * Missing intermediate containers are created: an object for a string
 * segment, an array for a numeric segment. Throws RangeError on an empty
 * path.
 */
export function setPath<T extends object>(
  obj: T,
  path: string | ReadonlyArray<string | number>,
  value: unknown,
): T {
  const keys = toPath(path);
  if (keys.length === 0) throw new RangeError("setPath requires a non-empty path");
  let current: Record<string | number, unknown> = obj as Record<string | number, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = current[key as string | number];
    if (!isPlainObject(next) && !Array.isArray(next)) {
      current[key as string | number] = typeof keys[i + 1] === "number" ? [] : {};
    }
    current = current[key as string | number] as Record<string | number, unknown>;
  }
  current[keys[keys.length - 1]! as string | number] = value;
  return obj;
}

/**
 * Flatten a nested structure into a map from dotted path to leaf value.
 *
 * Plain objects and arrays are descended into (array indices become numeric
 * path segments); every other value is a leaf. Empty objects and arrays are
 * themselves reported as leaves so no data is silently dropped.
 *
 * ```ts
 * flattenPaths({ a: { b: [10, 20] } })
 * // => { "a.b.0": 10, "a.b.1": 20 }
 * ```
 */
export function flattenPaths(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  walkFlatten(value, "", out);
  return out;
}

function walkFlatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((v, i) => {
      walkFlatten(v, prefix === "" ? String(i) : `${prefix}.${i}`, out);
    });
    return;
  }
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) {
      walkFlatten(v, prefix === "" ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out[prefix] = value;
}

/** One entry in a {@link deepDiff} result. */
export interface DiffEntry {
  /** Dotted path from the root to the differing value. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

/**
 * Structural diff between two JSON-like values. Descends through plain
 * objects; arrays and leaves are compared with {@link deepEqual} and
 * reported as a single "changed" entry when they differ. Keys present only
 * in `before` are "removed"; keys present only in `after` are "added".
 * Entries are ordered by first appearance during traversal.
 */
export function deepDiff(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walkDiff(before, after, "", out);
  return out;
}

function walkDiff(before: unknown, after: unknown, prefix: string, out: DiffEntry[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (!Object.hasOwn(after, key)) {
        out.push({ path, kind: "removed", before: before[key] });
      } else {
        walkDiff(before[key], after[key], path, out);
      }
    }
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        out.push({ path, kind: "added", after: after[key] });
      }
    }
    return;
  }
  if (!deepEqual(before, after)) {
    out.push({ path: prefix, kind: "changed", before, after });
  }
}
