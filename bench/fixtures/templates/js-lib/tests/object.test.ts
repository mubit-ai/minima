import { describe, expect, test } from "bun:test";
import {
  deepClone,
  deepDiff,
  deepEqual,
  deepMerge,
  flattenPaths,
  getPath,
  setPath,
} from "../src/object.ts";

describe("deepClone", () => {
  test("clones nested structures independently", () => {
    const original = { a: { b: [1, { c: 2 }] } };
    const copy = deepClone(original);
    expect(copy).toEqual(original);
    (copy.a.b[1] as { c: number }).c = 99;
    expect((original.a.b[1] as { c: number }).c).toBe(2);
  });
});

describe("deepEqual", () => {
  test("compares nested structures structurally and treats NaN as equal to NaN", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(deepEqual({ v: Number.NaN }, { v: Number.NaN })).toBe(true);
  });
});

describe("deepMerge", () => {
  test("merges nested plain objects key by key without mutating inputs", () => {
    const target = { a: { x: 1, y: 2 }, keep: true };
    const source = { a: { y: 20, z: 30 } };
    const merged = deepMerge(target, source);
    expect(merged).toEqual({ a: { x: 1, y: 20, z: 30 }, keep: true });
    expect(target).toEqual({ a: { x: 1, y: 2 }, keep: true });
    expect(source).toEqual({ a: { y: 20, z: 30 } });
  });

  test("replaces arrays by default", () => {
    expect(deepMerge({ tags: [1, 2] }, { tags: [3] })).toEqual({ tags: [3] });
  });

  test("concat strategy appends source elements", () => {
    expect(deepMerge({ tags: [1, 2] }, { tags: [2, 3] }, { arrays: "concat" })).toEqual({
      tags: [1, 2, 2, 3],
    });
  });

  test("union strategy skips deep-equal duplicates", () => {
    expect(deepMerge({ tags: [1, 2] }, { tags: [2, 3] }, { arrays: "union" })).toEqual({
      tags: [1, 2, 3],
    });
  });

  test("mismatched types resolve to the source value", () => {
    expect(deepMerge({ a: { deep: true } }, { a: 5 })).toEqual({ a: 5 });
  });
});

describe("getPath / setPath", () => {
  test("getPath reads dotted paths through objects and arrays", () => {
    const obj = { users: [{ name: "ada" }, { name: "grace" }] };
    expect(getPath(obj, "users.1.name")).toBe("grace");
  });

  test("getPath returns the fallback for missing segments", () => {
    expect(getPath({ a: 1 }, "a.b.c", "missing")).toBe("missing");
    expect(getPath({ a: 1 }, "z", 0)).toBe(0);
  });

  test("setPath writes nested values, creating objects or arrays per segment", () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, "a.b.c", 7);
    setPath(obj, "list.0", "first");
    expect(obj).toEqual({ a: { b: { c: 7 } }, list: ["first"] });
    expect(() => setPath({}, "", 1)).toThrow(RangeError);
  });
});

describe("flattenPaths", () => {
  test("maps dotted paths to leaves, keeping empty containers as leaves", () => {
    expect(flattenPaths({ a: { b: [10, 20] }, c: "x" })).toEqual({
      "a.b.0": 10,
      "a.b.1": 20,
      c: "x",
    });
    expect(flattenPaths({ empty: {}, none: [] })).toEqual({ empty: {}, none: [] });
  });
});

describe("deepDiff", () => {
  test("reports added, removed, and changed paths; deep-equal values yield none", () => {
    const entries = deepDiff({ a: 1, gone: true, nested: { x: 1 } }, { a: 2, nested: { x: 1, y: 3 } });
    expect(entries).toEqual([
      { path: "a", kind: "changed", before: 1, after: 2 },
      { path: "gone", kind: "removed", before: true },
      { path: "nested.y", kind: "added", after: 3 },
    ]);
    expect(deepDiff({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });

  test("reports differing arrays as a single changed entry", () => {
    expect(deepDiff({ a: [1] }, { a: [1, 2] })).toEqual([
      { path: "a", kind: "changed", before: [1], after: [1, 2] },
    ]);
  });
});
