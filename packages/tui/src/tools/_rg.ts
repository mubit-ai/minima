/**
 * Shared ripgrep resolution — one cached Bun.which lookup instead of per-call
 * spawn-and-catch-ENOENT. The override is a test seam: null forces the fallback
 * engine, a string forces a specific binary, undefined uses the cached lookup.
 */

let cached: string | null | undefined;

export function resolveRg(override?: string | null): string | null {
  if (override !== undefined) return override;
  if (cached === undefined) cached = Bun.which("rg");
  return cached;
}
