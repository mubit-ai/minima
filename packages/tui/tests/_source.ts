/**
 * Reading a source file and asserting on its TEXT, done less brittly.
 *
 * A dozen test files do `expect(src).toContain("const outcome = await finalizePlan(store, {")`.
 * These are wiring guards over app.tsx (5177 lines of React that cannot be exercised
 * directly), and they earn their keep — but read raw they break on any reindent or line
 * wrap. `bun run format` reflowing one call site is enough to turn a green suite red with a
 * failure that says nothing about behavior.
 *
 * `readSource` collapses runs of whitespace to a single space, on BOTH the file and the
 * snippet, so indentation and line breaks stop mattering. It deliberately does NOT strip
 * whitespace: `a===true` still fails to match `a === true`, because token spacing is a real
 * difference while wrapping is not. That keeps these assertions honest about the thing they
 * actually check.
 *
 * These are a last resort. Prefer importing the function and asserting on its behavior —
 * see behavior.ts, panel_state.ts and confidence.ts for logic already extracted out of
 * app.tsx precisely so it could be tested for real.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Collapse whitespace runs to one space so wrapping/indentation cannot break a match. */
export function normalizeCode(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A source file under src/, whitespace-normalized and ready for toContain.
 * Pass the path relative to src/ — e.g. readSource("tui/app.tsx").
 */
export function readSource(relativeToSrc: string): string {
  return normalizeCode(readFileSync(join(import.meta.dir, "..", "src", relativeToSrc), "utf8"));
}

/** The raw file, for the rare assertion that genuinely cares about layout. */
export function readSourceRaw(relativeToSrc: string): string {
  return readFileSync(join(import.meta.dir, "..", "src", relativeToSrc), "utf8");
}

/**
 * Normalize a snippet before matching it against readSource() output. Needed only when the
 * snippet itself spans lines; single-line snippets are already normal-form.
 */
export const code = normalizeCode;
