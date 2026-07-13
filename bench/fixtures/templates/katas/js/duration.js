/**
 * Kata: parse compact duration strings.
 *
 * Turn strings like "1h30m15s" into a number of seconds.
 */

/**
 * Parse a compact duration spec and return the total seconds.
 *
 * Contract:
 *   - `spec` is one or more components, each a run of one or more
 *     decimal digits followed by a unit: `h` (hours), `m` (minutes) or
 *     `s` (seconds). Leading zeros are fine; values are unbounded
 *     ("90m" is 5400 seconds).
 *   - Components must appear in strictly descending unit order (h, then
 *     m, then s) and each unit at most once; units may be skipped
 *     ("1h5s" is valid and equals 3605).
 *   - No whitespace, signs or other characters are allowed anywhere.
 *   - At least one component is required.
 *   - Any malformed spec (empty string, unknown unit, wrong order,
 *     repeated unit, dangling digits or bare units) throws an `Error`.
 *
 * Example: parseDuration("1h30m15s") -> 5415.
 */
export function parseDuration(spec) {
  throw new Error("kata: implement parseDuration");
}
