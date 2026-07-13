/**
 * Kata: bracket balance, quote-aware.
 *
 * Classic matched-brackets check, except bracket characters that appear
 * inside double-quoted string literals must be ignored.
 */

/**
 * Return true when every bracket in `source` is properly matched.
 *
 * Contract:
 *   - Bracket pairs are `()`, `[]`, `{}` and `<>`. They must close in
 *     LIFO order: `"([)]"` is unbalanced, `"([])"` is balanced.
 *   - Every non-bracket character outside quotes is ignored.
 *   - A double quote (`"`) starts a string literal that runs to the
 *     next unescaped double quote; everything inside it (brackets
 *     included) is ignored. Inside a literal, a backslash escapes the
 *     character after it, so `\"` does not end the literal.
 *   - If a string literal is still open at the end of the input, the
 *     source is unbalanced: return false.
 *   - The empty string is balanced.
 */
export function isBalanced(source: string): boolean {
  throw new Error("kata: implement isBalanced");
}
