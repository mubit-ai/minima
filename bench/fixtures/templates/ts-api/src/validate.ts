/**
 * linkbox — input validation helpers.
 *
 * All request-body validation is centralised here so handlers only deal with
 * already-checked values. Validators never throw: they return discriminated
 * results (`ok: true` with the parsed value, or `ok: false` with a list of
 * human-readable error strings). Unknown body fields are ignored on purpose:
 * clients may send extra metadata without breaking older servers.
 */

/** Maximum characters accepted for a note title. */
export const MAX_TITLE_LENGTH = 120;
/** Maximum characters accepted for a note body. */
export const MAX_BODY_LENGTH = 4000;
/** Maximum number of tags per note. */
export const MAX_TAGS = 8;
/** Hard cap for the `limit` pagination parameter. */
export const MAX_PAGE_LIMIT = 100;
/** Default page size when the client does not send `limit`. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Slugs: 2-32 chars, alphanumeric plus `-`/`_`, must start alphanumeric. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/i;

/** Tags: 1-24 chars, lower-case alphanumeric plus `-`, starts alphanumeric. */
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** True for a plain string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when `value` parses as an absolute http(s) URL with a hostname. */
export function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** True when `value` is an acceptable custom slug. */
export function isValidSlug(value: unknown): boolean {
  return typeof value === "string" && SLUG_RE.test(value);
}

/** True when `value` is an acceptable note tag. */
export function isValidTag(value: unknown): boolean {
  return typeof value === "string" && TAG_RE.test(value);
}

/** Result of a body validator: parsed value or a list of problems. */
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Parsed and approved payload for `POST /api/links`. */
export interface LinkCreateInput {
  url: string;
  slug?: string;
}

/** Validate the create-link body. `slug` is optional; `url` is required. */
export function validateLinkCreate(body: unknown): Validated<LinkCreateInput> {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: ["body: expected a JSON object"] };
  }
  const raw = body as Record<string, unknown>;
  if (raw.url === undefined) {
    errors.push("url: required");
  } else if (!isValidHttpUrl(raw.url)) {
    errors.push("url: must be an absolute http(s) URL");
  }
  if (raw.slug !== undefined && !isValidSlug(raw.slug)) {
    errors.push("slug: 2-32 chars, alphanumeric with - or _, starting alphanumeric");
  }
  if (errors.length > 0) return { ok: false, errors };
  const value: LinkCreateInput = { url: raw.url as string };
  if (raw.slug !== undefined) value.slug = raw.slug as string;
  return { ok: true, value };
}

/** Parsed and approved payload for `PATCH /api/links/:slug`. */
export interface LinkUpdateInput {
  slug?: string;
  url?: string;
}

/** Validate the update-link body: at least one recognised field, all valid. */
export function validateLinkUpdate(body: unknown): Validated<LinkUpdateInput> {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: ["body: expected a JSON object"] };
  }
  const raw = body as Record<string, unknown>;
  if (raw.slug === undefined && raw.url === undefined) {
    return { ok: false, errors: ["body: provide at least one of slug, url"] };
  }
  if (raw.slug !== undefined && !isValidSlug(raw.slug)) {
    errors.push("slug: 2-32 chars, alphanumeric with - or _, starting alphanumeric");
  }
  if (raw.url !== undefined && !isValidHttpUrl(raw.url)) {
    errors.push("url: must be an absolute http(s) URL");
  }
  if (errors.length > 0) return { ok: false, errors };
  const value: LinkUpdateInput = {};
  if (raw.slug !== undefined) value.slug = raw.slug as string;
  if (raw.url !== undefined) value.url = raw.url as string;
  return { ok: true, value };
}

/** Parsed and approved payload for `POST /api/notes`. */
export interface NoteCreateInput {
  title: string;
  body: string;
  tags: string[];
}

/**
 * Validate the create-note body. `title` is required; `body` defaults to the
 * empty string and `tags` to `[]`.
 */
export function validateNoteCreate(body: unknown): Validated<NoteCreateInput> {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: ["body: expected a JSON object"] };
  }
  const raw = body as Record<string, unknown>;
  if (!isNonEmptyString(raw.title)) {
    errors.push("title: required, non-empty string");
  } else if ((raw.title as string).length > MAX_TITLE_LENGTH) {
    errors.push(`title: at most ${MAX_TITLE_LENGTH} characters`);
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string") {
      errors.push("body: must be a string");
    } else if (raw.body.length > MAX_BODY_LENGTH) {
      errors.push(`body: at most ${MAX_BODY_LENGTH} characters`);
    }
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      errors.push("tags: must be an array");
    } else if (raw.tags.length > MAX_TAGS) {
      errors.push(`tags: at most ${MAX_TAGS} entries`);
    } else if (!raw.tags.every((tag) => isValidTag(tag))) {
      errors.push("tags: each tag is 1-24 lower-case alphanumeric/- chars");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title: (raw.title as string).trim(),
      body: (raw.body as string | undefined) ?? "",
      tags: [...((raw.tags as string[] | undefined) ?? [])],
    },
  };
}

/** Parsed pagination window. */
export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Parse `limit`/`offset` query parameters with defaults and bounds.
 * `limit` ∈ [1, MAX_PAGE_LIMIT], `offset` ≥ 0; both must be integer strings.
 */
export function parsePagination(query: Record<string, string>): Validated<Pagination> {
  const errors: string[] = [];
  let limit = DEFAULT_PAGE_LIMIT;
  let offset = 0;
  if (query.limit !== undefined) {
    const parsed = parseIntStrict(query.limit);
    if (parsed === null || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      errors.push(`limit: integer between 1 and ${MAX_PAGE_LIMIT}`);
    } else {
      limit = parsed;
    }
  }
  if (query.offset !== undefined) {
    const parsed = parseIntStrict(query.offset);
    if (parsed === null || parsed < 0) {
      errors.push("offset: integer >= 0");
    } else {
      offset = parsed;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { limit, offset } };
}

/**
 * Strictly parse a decimal integer string: the entire input must be digits
 * (with optional leading minus). Returns `null` on anything else.
 */
export function parseIntStrict(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse an optional bounded integer query parameter, falling back to
 * `fallback` when absent. Returns `null` when present but invalid.
 */
export function parseBoundedInt(
  raw: string | undefined,
  opts: { min: number; max: number; fallback: number },
): number | null {
  if (raw === undefined) return opts.fallback;
  const parsed = parseIntStrict(raw);
  if (parsed === null || parsed < opts.min || parsed > opts.max) return null;
  return parsed;
}
