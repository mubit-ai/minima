/**
 * Kata: English ordinal suffixes.
 *
 * Number to "1st" / "2nd" / "3rd" / "4th" formatting, including the
 * irregular teens.
 */

/**
 * Return `n` followed by its English ordinal suffix.
 *
 * Contract:
 *   - `n` must be a non-negative integer; anything else (negative,
 *     fractional, NaN, Infinity) throws a `RangeError`.
 *   - Numbers ending in 1 take "st", in 2 take "nd", in 3 take "rd",
 *     everything else takes "th": 1 -> "1st", 42 -> "42nd", 63 -> "63rd".
 *   - Teens exception: numbers whose last two digits are 11, 12 or 13
 *     take "th" (11 -> "11th", 112 -> "112th", 1013 -> "1013th").
 *   - Zero takes "th": 0 -> "0th".
 */
export function ordinal(n: number): string {
  throw new Error("kata: implement ordinal");
}
