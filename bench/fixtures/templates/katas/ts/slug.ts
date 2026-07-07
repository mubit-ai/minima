/**
 * Kata: URL slugs with an apostrophe rule.
 *
 * Standard slugification turns "Don't Stop" into "don-t-stop", which
 * reads badly. This variant treats apostrophes as invisible.
 */

/**
 * Convert a human title into a URL slug.
 *
 * Contract:
 *   - Apostrophes — ASCII `'` and typographic `’` (U+2019) — are
 *     removed outright, joining their neighbours: "Don't" -> "dont".
 *   - The result is lowercase.
 *   - After apostrophe removal, every maximal run of characters other
 *     than `a-z` / `0-9` (spaces, punctuation, accented letters, ...)
 *     becomes a single hyphen.
 *   - Leading and trailing hyphens are trimmed.
 *   - A title with no alphanumerics at all yields `""`.
 */
export function slugify(title: string): string {
  throw new Error("kata: implement slugify");
}
