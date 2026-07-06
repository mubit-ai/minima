/**
 * Kata: drift cipher.
 *
 * A Caesar cipher whose shift drifts: each successive LETTER is shifted
 * one position further than the letter before it.
 */

/**
 * Encode `text` with a drifting Caesar shift.
 *
 * Contract:
 *   - `shift` must be an integer (negative and values beyond 26 are
 *     fine); otherwise throw a `RangeError`.
 *   - The 1st letter of `text` is rotated by `shift`, the 2nd letter by
 *     `shift + 1`, the 3rd by `shift + 2`, and so on. Rotation wraps
 *     around the alphabet (modulo 26) and preserves case.
 *   - Non-letter characters are copied through unchanged and do NOT
 *     advance the drift counter: in "a b!c" with shift 0 the letters
 *     get shifts 0, 1 and 2.
 *   - The empty string encodes to the empty string.
 *
 * Example: driftEncode("abc", 0) === "ace".
 */
export function driftEncode(text: string, shift: number): string {
  throw new Error("kata: implement driftEncode");
}
