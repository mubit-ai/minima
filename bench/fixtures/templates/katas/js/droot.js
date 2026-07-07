/**
 * Kata: digital root in an arbitrary base.
 *
 * The classic repeated-digit-sum, generalised from base 10 to any base
 * from 2 to 36.
 */

/**
 * Return the digital root of `value` written in base `base`.
 *
 * Contract:
 *   - `value` must be a non-negative integer and `base` an integer with
 *     2 <= base <= 36; otherwise throw a `RangeError`.
 *   - Write `value` in base `base`, sum its digits, and repeat on the
 *     sum until a single base-`base` digit remains; return that digit's
 *     numeric value (a plain number in 0..base-1).
 *   - `0` has digital root `0` in every base; any value smaller than
 *     `base` is its own digital root.
 *
 * Example: digitalRoot(255, 16) -> 15 (FF -> 1E -> F).
 */
export function digitalRoot(value, base) {
  throw new Error("kata: implement digitalRoot");
}
