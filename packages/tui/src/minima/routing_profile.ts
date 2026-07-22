/**
 * Per-repo routing profile application — pure helpers that turn a `routing_profiles` row
 * into effective route() inputs. Precedence at the route seam is always
 * EXPLICIT PER-CALL OPTS > PROFILE > CONFIG DEFAULT; these helpers only resolve the
 * PROFILE layer (parse, validate, filter) — the caller composes the chain.
 *
 * Propensity integrity: everything here is pre-request candidate assembly (the pool the
 * server ranks over), never a post-hoc re-rank of what the server returned.
 */

import type { PerTaskTypePool, RoutingProfileRow } from "../db/minima_db.ts";

/** Parse the profile's JSON `candidates` column. Malformed/empty → null (no override). */
export function parseProfileCandidates(profile: RoutingProfileRow | null): string[] | null {
  if (!profile?.candidates) return null;
  try {
    const parsed: unknown = JSON.parse(profile.candidates);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** The per-task-type entry for `taskType`, validated. Unknown type / malformed → null. */
export function perTaskTypeEntry(
  profile: RoutingProfileRow | null,
  taskType: string | null | undefined,
): PerTaskTypePool | null {
  if (!profile?.per_task_type || !taskType) return null;
  let map: unknown;
  try {
    map = JSON.parse(profile.per_task_type);
  } catch {
    return null;
  }
  if (typeof map !== "object" || map === null || Array.isArray(map)) return null;
  const raw = (map as Record<string, unknown>)[taskType];
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const candidates = Array.isArray(entry.candidates)
    ? entry.candidates.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (candidates.length === 0) return null;
  const minQuality =
    typeof entry.minQuality === "number" && Number.isFinite(entry.minQuality)
      ? entry.minQuality
      : undefined;
  return minQuality !== undefined ? { candidates, minQuality } : { candidates };
}

/**
 * The profile's default candidate pool for this request: the per-task-type pool when a
 * taskType is known — filtered to registry-known models, falling back to the profile's
 * default `candidates` when the filter empties it — else the default `candidates`.
 * Null = the profile does not override the pool (use config.candidates).
 */
export function resolveProfilePool(
  profile: RoutingProfileRow | null,
  taskType: string | null | undefined,
  knownModel: (id: string) => boolean,
): string[] | null {
  const entry = perTaskTypeEntry(profile, taskType);
  if (entry) {
    const known = entry.candidates.filter(knownModel);
    if (known.length > 0) return known;
  }
  return parseProfileCandidates(profile);
}

/** The tighter of two optional USD ceilings (both are caps — honoring both = min). */
export function minDefinedCap(
  a: number | null | undefined,
  b: number | null | undefined,
): number | undefined {
  const vals = [a, b].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return undefined;
  return Math.min(...vals);
}
