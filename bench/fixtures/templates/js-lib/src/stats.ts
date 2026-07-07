/**
 * Descriptive statistics over arrays of finite numbers.
 *
 * Conventions:
 *   - Functions never mutate their input arrays.
 *   - Empty inputs raise RangeError where a value is mathematically
 *     undefined (mean, quantile, …) rather than returning NaN.
 *   - `variance`/`stdev` default to the *sample* (n - 1) estimator; pass
 *     `{ population: true }` for the population (n) form.
 */

/** Sum of all values (0 for an empty array). */
export function sum(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Arithmetic mean. Throws RangeError on an empty array. */
export function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new RangeError("mean of empty array");
  return sum(values) / values.length;
}

export interface VarianceOptions {
  /** Use the population (n) divisor instead of the sample (n - 1) divisor. */
  population?: boolean;
}

/**
 * Variance of the values.
 *
 * Uses the sample estimator (divisor n - 1) by default, which requires at
 * least two values; with `{ population: true }` the divisor is n and a
 * single value is allowed.
 */
export function variance(values: ReadonlyArray<number>, options: VarianceOptions = {}): number {
  const population = options.population ?? false;
  const minLength = population ? 1 : 2;
  if (values.length < minLength) {
    throw new RangeError(`variance requires at least ${minLength} value(s)`);
  }
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return acc / (population ? values.length : values.length - 1);
}

/** Standard deviation; same options and preconditions as {@link variance}. */
export function stdev(values: ReadonlyArray<number>, options: VarianceOptions = {}): number {
  return Math.sqrt(variance(values, options));
}

/**
 * Quantile of the values at probability `q` in [0, 1], using linear
 * interpolation between order statistics (the "R-7" rule used by numpy and
 * spreadsheet software): the quantile sits at rank `q * (n - 1)` of the
 * sorted values, interpolating between the two neighbouring values when the
 * rank is fractional.
 *
 * `q = 0` yields the minimum, `q = 1` the maximum. Throws RangeError for an
 * empty array or `q` outside [0, 1].
 */
export function quantile(values: ReadonlyArray<number>, q: number): number {
  if (values.length === 0) throw new RangeError("quantile of empty array");
  if (!(q >= 0 && q <= 1)) throw new RangeError("q must be within [0, 1]");
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.min(Math.floor(pos), sorted.length - 1);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = pos - lo;
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
}

/** Median: the 0.5 quantile. Throws RangeError on an empty array. */
export function median(values: ReadonlyArray<number>): number {
  return quantile(values, 0.5);
}

/**
 * Pearson correlation coefficient between two equal-length series.
 *
 * Returns a value in [-1, 1]. Throws RangeError when the series lengths
 * differ, when there are fewer than two points, or when either series has
 * zero variance (the coefficient is undefined there).
 */
export function pearson(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  if (x.length !== y.length) throw new RangeError("pearson requires equal-length series");
  if (x.length < 2) throw new RangeError("pearson requires at least two points");
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) {
    throw new RangeError("pearson is undefined for a zero-variance series");
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** One histogram bin: counts values in [x0, x1) (last bin closes at x1). */
export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

export interface HistogramOptions {
  /** Number of equal-width bins. Must be a positive integer. Default 10. */
  bins?: number;
}

/**
 * Bin values into a histogram of equal-width bins spanning [min, max].
 *
 * Each bin covers `[x0, x1)` except the last, which also includes the
 * maximum so every value is counted exactly once. An empty input yields an
 * empty array; when all values are equal a single zero-width bin holding
 * every value is returned. Throws RangeError when `bins` is not a positive
 * integer.
 */
export function histogram(
  values: ReadonlyArray<number>,
  options: HistogramOptions = {},
): HistogramBin[] {
  const bins = options.bins ?? 10;
  if (!Number.isInteger(bins) || bins < 1) {
    throw new RangeError("bins must be a positive integer");
  }
  if (values.length === 0) return [];

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) {
    return [{ x0: lo, x1: hi, count: values.length }];
  }

  const width = (hi - lo) / bins;
  const result: HistogramBin[] = [];
  for (let b = 0; b < bins; b++) {
    result.push({ x0: lo + b * width, x1: lo + (b + 1) * width, count: 0 });
  }
  for (const v of values) {
    let idx = Math.floor((v - lo) / width);
    if (idx >= bins) idx = bins - 1; // the maximum belongs to the last bin
    result[idx]!.count += 1;
  }
  return result;
}
