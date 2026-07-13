/**
 * linkbox — snapshot persistence.
 *
 * A snapshot is a plain-JSON envelope around {@link StoreDump}: format
 * version, creation timestamp, and the canonical data. Derived state — most
 * importantly the slug index — is deliberately NOT serialised;
 * {@link Store.load} rebuilds it from the canonical records, so a snapshot
 * can never smuggle in an index that disagrees with the records.
 *
 * Shape validation is strict: restoring is an admin operation that replaces
 * the whole dataset, so a malformed payload must fail loudly (HTTP 400)
 * rather than half-apply. Required fields are checked exactly; unknown extra
 * fields on records are preserved verbatim so snapshots written by newer
 * builds restore losslessly on this one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { LinkRecord, NoteRecord } from "./types.ts";
import type { Store, StoreDump } from "./store.ts";
import { SnapshotError } from "./errors.ts";

/** Current snapshot format version. */
export const SNAPSHOT_VERSION = 1;

/** Versioned snapshot envelope. */
export interface Snapshot {
  version: number;
  /** ISO-8601 timestamp of when the snapshot was taken. */
  createdAt: string;
  data: StoreDump;
}

/** Capture the store's canonical state at `nowMs`. */
export function takeSnapshot(store: Store, nowMs: number): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    data: store.dump(),
  };
}

/**
 * Validate `value` and load it into `store`, replacing all existing state.
 * Returns restored record counts for the admin API response.
 * Throws {@link SnapshotError} when the payload fails shape checks.
 */
export function restoreSnapshot(store: Store, value: unknown): { links: number; notes: number } {
  const snapshot = assertSnapshotShape(value);
  store.load(snapshot.data);
  return { links: snapshot.data.links.length, notes: snapshot.data.notes.length };
}

/** Serialise a snapshot to pretty-printed JSON. */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** Parse and shape-check snapshot JSON text. Throws {@link SnapshotError}. */
export function parseSnapshot(text: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError(`snapshot is not valid JSON: ${(err as Error).message}`);
  }
  return assertSnapshotShape(value);
}

/** Write a snapshot to disk (pretty JSON, UTF-8). */
export function saveSnapshotToFile(path: string, snapshot: Snapshot): void {
  writeFileSync(path, serializeSnapshot(snapshot), "utf8");
}

/** Read and shape-check a snapshot from disk. */
export function loadSnapshotFromFile(path: string): Snapshot {
  return parseSnapshot(readFileSync(path, "utf8"));
}

// ── shape checks ───────────────────────────────────────────────────────────

function fail(path: string, expected: string): never {
  throw new SnapshotError(`invalid snapshot at ${path}: expected ${expected}`);
}

function checkString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "a string");
  return value;
}

function checkCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "a non-negative integer");
  }
  return value;
}

function checkObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function checkArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "an array");
  return value;
}

/** Validate an arbitrary value as a {@link Snapshot}; throws on any defect. */
export function assertSnapshotShape(value: unknown): Snapshot {
  const root = checkObject(value, "$");
  if (root.version !== SNAPSHOT_VERSION) {
    fail("$.version", `the number ${SNAPSHOT_VERSION}`);
  }
  const createdAt = checkString(root.createdAt, "$.createdAt");
  const data = checkObject(root.data, "$.data");

  const links = checkArray(data.links, "$.data.links").map((entry, i) => {
    const raw = checkObject(entry, `$.data.links[${i}]`);
    checkString(raw.id, `$.data.links[${i}].id`);
    checkString(raw.slug, `$.data.links[${i}].slug`);
    checkString(raw.url, `$.data.links[${i}].url`);
    checkString(raw.createdAt, `$.data.links[${i}].createdAt`);
    return { ...raw } as unknown as LinkRecord;
  });

  const clicksRaw = checkObject(data.clicks, "$.data.clicks");
  const clicks: Record<string, number> = {};
  for (const [slug, count] of Object.entries(clicksRaw)) {
    clicks[slug] = checkCount(count, `$.data.clicks[${JSON.stringify(slug)}]`);
  }

  const notes = checkArray(data.notes, "$.data.notes").map((entry, i) => {
    const raw = checkObject(entry, `$.data.notes[${i}]`);
    checkArray(raw.tags, `$.data.notes[${i}].tags`).forEach((tag, j) =>
      checkString(tag, `$.data.notes[${i}].tags[${j}]`),
    );
    checkString(raw.id, `$.data.notes[${i}].id`);
    checkString(raw.title, `$.data.notes[${i}].title`);
    checkString(raw.body, `$.data.notes[${i}].body`);
    checkString(raw.createdAt, `$.data.notes[${i}].createdAt`);
    return { ...raw } as unknown as NoteRecord;
  });

  const countersRaw = checkObject(data.counters, "$.data.counters");
  const counters = {
    link: checkCount(countersRaw.link, "$.data.counters.link"),
    note: checkCount(countersRaw.note, "$.data.counters.note"),
  };

  return { version: SNAPSHOT_VERSION, createdAt, data: { links, clicks, notes, counters } };
}
