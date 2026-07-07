/**
 * Kata: array chunking with optional padding.
 *
 * Split an array into fixed-size chunks; optionally pad the final short
 * chunk to full size.
 */

/**
 * Split `items` into consecutive chunks of `size` elements.
 *
 * Contract:
 *   - `size` must be an integer >= 1; otherwise throw a `RangeError`.
 *   - Returns a new array of new arrays; `items` is never modified.
 *   - When `items.length` is not a multiple of `size`, the final chunk
 *     is shorter — unless `pad` is provided (i.e. not `undefined`), in
 *     which case the final chunk is filled with `pad` up to `size`
 *     elements. `null` counts as a provided pad value.
 *   - A chunk that is already full is never padded, and an empty input
 *     yields `[]` (nothing to pad).
 *
 * Example: chunk([1, 2, 3], 2, 0) -> [[1, 2], [3, 0]].
 */
export function chunk(items, size, pad) {
  throw new Error("kata: implement chunk");
}
