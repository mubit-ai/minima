import { describe, expect, test } from "bun:test";
import { histogram, mean, median, pearson, quantile, stdev, sum, variance } from "../src/stats.ts";

describe("sum and mean", () => {
  test("sum adds all values; mean averages and rejects empty input", () => {
    expect(sum([1.5, 2.5, 4])).toBe(8);
    expect(sum([])).toBe(0);
    expect(mean([2, 4, 9])).toBe(5);
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe("variance and stdev", () => {
  test("sample variance uses the n-1 divisor and needs two values", () => {
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428571, 8);
    expect(() => variance([1])).toThrow(RangeError);
  });

  test("population variance uses the n divisor and allows a single value", () => {
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9], { population: true })).toBe(4);
    expect(variance([1], { population: true })).toBe(0);
  });

  test("stdev is the square root of variance", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], { population: true })).toBe(2);
  });
});

describe("quantile and median", () => {
  test("q = 0 is the minimum and q = 1 the maximum", () => {
    expect(quantile([9, 3, 7], 0)).toBe(3);
    expect(quantile([9, 3, 7], 1)).toBe(9);
  });

  test("a single value is every quantile", () => {
    expect(quantile([42], 0.5)).toBe(42);
    expect(median([42])).toBe(42);
  });

  test("rejects empty input and q outside [0, 1]", () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
    expect(() => quantile([1, 2], -0.1)).toThrow(RangeError);
    expect(() => quantile([1, 2], 1.1)).toThrow(RangeError);
    expect(() => quantile([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

describe("pearson", () => {
  test("measures linear correlation and rejects degenerate input", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
    expect(() => pearson([1, 2], [1])).toThrow(RangeError);
    expect(() => pearson([1, 1], [2, 3])).toThrow(RangeError);
  });
});

describe("histogram", () => {
  test("bins values into equal-width bins over [min, max]", () => {
    const bins = histogram([0, 1, 2, 3], { bins: 2 });
    expect(bins).toEqual([
      { x0: 0, x1: 1.5, count: 2 },
      { x0: 1.5, x1: 3, count: 2 },
    ]);
  });

  test("counts the maximum in the last bin", () => {
    const bins = histogram([0, 10], { bins: 5 });
    expect(bins[4]).toEqual({ x0: 8, x1: 10, count: 1 });
  });

  test("collapses identical values into one zero-width bin; empty input yields none", () => {
    expect(histogram([5, 5, 5], { bins: 4 })).toEqual([{ x0: 5, x1: 5, count: 3 }]);
    expect(histogram([])).toEqual([]);
  });

  test("rejects a non-positive or fractional bin count", () => {
    expect(() => histogram([1, 2], { bins: 0 })).toThrow(RangeError);
    expect(() => histogram([1, 2], { bins: 2.5 })).toThrow(RangeError);
  });
});
