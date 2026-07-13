/**
 * Kata: greedy word wrap with hard breaks.
 *
 * Wrap prose to a column width, slicing words that are too long to fit
 * on any line.
 */

/**
 * Wrap `text` at `width` columns and return the list of lines.
 *
 * Contract:
 *   - `width` must be an integer >= 1; otherwise throw a `RangeError`.
 *   - Words are the maximal runs of non-whitespace; any run of
 *     whitespace (spaces, tabs, newlines) is just a separator.
 *   - Greedy fill: append the next word to the current line (joined by
 *     a single space) whenever the line stays <= `width` characters;
 *     otherwise start a new line with that word.
 *   - A word longer than `width` is hard-broken: the current line (if
 *     any) is flushed, the word is cut into `width`-sized slices, each
 *     full slice becomes its own line, and the final short slice starts
 *     the new current line (later words may join it if they fit).
 *   - No line ever exceeds `width`; lines contain no leading/trailing
 *     spaces. Empty or all-whitespace input returns `[]`.
 *
 * Example: wordWrap("abcdefg hi", 5) -> ["abcde", "fg hi"].
 */
export function wordWrap(text, width) {
  throw new Error("kata: implement wordWrap");
}
