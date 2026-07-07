import { describe, expect, test } from "bun:test";
import { groupBy, indexBy, pivot, rollup } from "../src/transform.ts";

interface Sale {
  region: string;
  quarter: string;
  amount: number;
}

const SALES: Sale[] = [
  { region: "west", quarter: "q1", amount: 10 },
  { region: "east", quarter: "q1", amount: 20 },
  { region: "west", quarter: "q2", amount: 30 },
  { region: "east", quarter: "q2", amount: 40 },
  { region: "west", quarter: "q1", amount: 50 },
];

describe("groupBy", () => {
  test("groups records by key in first-seen order", () => {
    const groups = groupBy(SALES, (s) => s.region);
    expect([...groups.keys()]).toEqual(["west", "east"]);
    expect(groups.get("west")!.map((s) => s.amount)).toEqual([10, 30, 50]);
    expect(groups.get("east")!.map((s) => s.amount)).toEqual([20, 40]);
  });

  test("returns an empty map for no records and accepts the empty string key", () => {
    expect(groupBy([], () => "x").size).toBe(0);
    const groups = groupBy([{ k: "" }, { k: "a" }], (r) => r.k);
    expect(groups.get("")!.length).toBe(1);
  });
});

describe("rollup", () => {
  test("computes named aggregates per group", () => {
    const table = rollup(SALES, (s) => s.region, {
      orders: (g) => g.length,
      revenue: (g) => g.reduce((acc, s) => acc + s.amount, 0),
    });
    expect(table.get("west")).toEqual({ orders: 3, revenue: 90 });
    expect(table.get("east")).toEqual({ orders: 2, revenue: 60 });
  });

  test("preserves group ordering", () => {
    const table = rollup(SALES, (s) => s.quarter, { n: (g) => g.length });
    expect([...table.keys()]).toEqual(["q1", "q2"]);
  });
});

describe("indexBy", () => {
  test("indexes records by a unique key", () => {
    const idx = indexBy(
      [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ],
      (r) => r.id,
    );
    expect(idx.get("b")).toEqual({ id: "b", v: 2 });
  });

  test("throws on duplicate keys", () => {
    expect(() => indexBy([{ id: "a" }, { id: "a" }], (r) => r.id)).toThrow(RangeError);
  });
});

describe("pivot", () => {
  test("builds a row-by-column table of aggregates", () => {
    const table = pivot(
      SALES,
      (s) => s.region,
      (s) => s.quarter,
      (g) => g.reduce((acc, s) => acc + s.amount, 0),
      0,
    );
    expect(table.columns).toEqual(["q1", "q2"]);
    expect(table.rows).toEqual([
      { key: "west", cells: [60, 30] },
      { key: "east", cells: [20, 40] },
    ]);
  });

  test("fills missing row/column pairs", () => {
    const table = pivot(
      [
        { r: "a", c: "x" },
        { r: "b", c: "y" },
      ],
      (rec) => rec.r,
      (rec) => rec.c,
      (g) => g.length,
      null,
    );
    expect(table.columns).toEqual(["x", "y"]);
    expect(table.rows).toEqual([
      { key: "a", cells: [1, null] },
      { key: "b", cells: [null, 1] },
    ]);
  });

  test("orders columns by first appearance", () => {
    const table = pivot(
      [
        { r: "only", c: "later" },
        { r: "only", c: "sooner" },
        { r: "only", c: "later" },
      ],
      (rec) => rec.r,
      (rec) => rec.c,
      (g) => g.length,
    );
    expect(table.columns).toEqual(["later", "sooner"]);
    expect(table.rows[0]!.cells).toEqual([2, 1]);
  });
});
