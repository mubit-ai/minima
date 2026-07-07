/**
 * linkbox — in-memory data store.
 *
 * Layout:
 *
 *   links         Map<id, LinkRecord>    canonical link records
 *   slugIndex     Map<slug, id>          lookup index for the resolve path
 *   clicksBySlug  Map<slug, number>      click ledger feeding the stats API
 *   notes         Map<id, NoteRecord>    canonical note records
 *
 * `slugIndex` and `clicksBySlug` are keyed by slug so the hot redirect path
 * (GET /r/:slug) costs a single map hit. The slug index is derived state:
 * snapshots persist only canonical records plus the click ledger, and
 * {@link Store.load} rebuilds the index from the records it is given.
 *
 * The store is synchronous and single-threaded by design; the app shell owns
 * exactly one instance.
 */

import type { LinkRecord, NoteRecord } from "./types.ts";
import { ConflictError } from "./errors.ts";

/** Alphabet used for generated slugs (lower-case alphanumerics). */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Length of generated slugs. */
const SLUG_LENGTH = 6;
/** Default PRNG seed — fixed so fixtures and tests are reproducible. */
const DEFAULT_SLUG_SEED = 0x2f6e2b1;

/** Constructor options for {@link Store}. */
export interface StoreOptions {
  /** Injected clock (ms since epoch); defaults to Date.now. */
  now?: () => number;
  /** Seed for the slug generator; fixed default keeps runs reproducible. */
  slugSeed?: number;
}

/** Everything a snapshot needs to reconstruct a store. */
export interface StoreDump {
  links: LinkRecord[];
  /** Click ledger keyed by slug. */
  clicks: Record<string, number>;
  notes: NoteRecord[];
  /** Id sequence counters, persisted so restored stores never reuse ids. */
  counters: { link: number; note: number };
}

/** One row of the top-links stats view. */
export interface TopLinkEntry {
  slug: string;
  url: string;
  clicks: number;
}

/** One row of the tag-count stats view. */
export interface TagCountEntry {
  tag: string;
  count: number;
}

/** The application's single source of truth for links, notes and clicks. */
export class Store {
  private readonly links = new Map<string, LinkRecord>();
  private readonly slugIndex = new Map<string, string>();
  private readonly clicksBySlug = new Map<string, number>();
  private readonly notes = new Map<string, NoteRecord>();
  private counters = { link: 1, note: 1 };
  private readonly now: () => number;
  private rngState: number;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.rngState = (opts.slugSeed ?? DEFAULT_SLUG_SEED) >>> 0;
  }

  // ── links ────────────────────────────────────────────────────────────────

  /**
   * Create a link. When `slug` is provided it must be free, otherwise a
   * fresh slug is generated (regenerating on the astronomically unlikely
   * collision). Throws {@link ConflictError} when a requested slug is taken.
   */
  createLink(input: { url: string; slug?: string }): LinkRecord {
    let slug: string;
    if (input.slug !== undefined) {
      if (this.slugIndex.has(input.slug)) {
        throw new ConflictError(`slug already in use: ${input.slug}`);
      }
      slug = input.slug;
    } else {
      slug = this.generateSlug();
      while (this.slugIndex.has(slug)) {
        slug = this.generateSlug();
      }
    }
    const id = `lnk_${this.counters.link++}`;
    const record: LinkRecord = {
      id,
      slug,
      url: input.url,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.links.set(id, record);
    this.slugIndex.set(slug, id);
    return record;
  }

  /** Fetch a link by slug via the index; `undefined` when unknown. */
  getLinkBySlug(slug: string): LinkRecord | undefined {
    const id = this.slugIndex.get(slug);
    return id === undefined ? undefined : this.links.get(id);
  }

  /**
   * List links ordered alphabetically by slug, windowed by limit/offset.
   * `total` is the full (unwindowed) count.
   */
  listLinks(opts: { limit: number; offset: number }): { items: LinkRecord[]; total: number } {
    const slugs = [...this.slugIndex.keys()].sort();
    const items: LinkRecord[] = [];
    for (const slug of slugs.slice(opts.offset, opts.offset + opts.limit)) {
      const id = this.slugIndex.get(slug)!;
      const record = this.links.get(id);
      if (record !== undefined) items.push(record);
    }
    return { items, total: slugs.length };
  }

  /**
   * Apply a partial update to the link currently known by `slug`.
   *
   * Renames keep the slug index and the click ledger keyed consistently
   * with the record: all three move to the new slug in the same mutation.
   * Throws {@link ConflictError} when the requested new slug is taken.
   * Returns the updated record, or `undefined` when `slug` is unknown.
   */
  updateLink(slug: string, changes: { slug?: string; url?: string }): LinkRecord | undefined {
    const id = this.slugIndex.get(slug);
    if (id === undefined) return undefined;
    const record = this.links.get(id)!;
    if (changes.slug !== undefined && changes.slug !== record.slug) {
      if (this.slugIndex.has(changes.slug)) {
        throw new ConflictError(`slug already in use: ${changes.slug}`);
      }
      this.slugIndex.delete(record.slug);
      this.slugIndex.set(changes.slug, id);
      const clicks = this.clicksBySlug.get(record.slug);
      if (clicks !== undefined) {
        this.clicksBySlug.delete(record.slug);
        this.clicksBySlug.set(changes.slug, clicks);
      }
      record.slug = changes.slug;
    }
    if (changes.url !== undefined) {
      record.url = changes.url;
    }
    return record;
  }

  /**
   * Delete the link known by `slug`, including its index entry and click
   * ledger row. Returns `false` when the slug is unknown.
   */
  deleteLink(slug: string): boolean {
    const id = this.slugIndex.get(slug);
    if (id === undefined) return false;
    this.links.delete(id);
    this.slugIndex.delete(slug);
    this.clicksBySlug.delete(slug);
    return true;
  }

  /** Record one redirect served for `slug`. */
  recordClick(slug: string): void {
    this.clicksBySlug.set(slug, (this.clicksBySlug.get(slug) ?? 0) + 1);
  }

  /** Clicks recorded for `slug` (0 when never clicked). */
  getClicks(slug: string): number {
    return this.clicksBySlug.get(slug) ?? 0;
  }

  /** Number of stored links. */
  countLinks(): number {
    return this.links.size;
  }

  /** Sum of every click in the ledger. */
  totalClicks(): number {
    let total = 0;
    for (const n of this.clicksBySlug.values()) total += n;
    return total;
  }

  /** Top `limit` links by click count (ties broken alphabetically by slug). */
  topLinks(limit: number): TopLinkEntry[] {
    const rows: TopLinkEntry[] = [...this.links.values()].map((record) => ({
      slug: record.slug,
      url: record.url,
      clicks: this.getClicks(record.slug),
    }));
    rows.sort((a, b) => b.clicks - a.clicks || (a.slug < b.slug ? -1 : 1));
    return rows.slice(0, limit);
  }

  // ── notes ────────────────────────────────────────────────────────────────

  /** Create a note. Input is assumed validated by the handler layer. */
  createNote(input: { title: string; body: string; tags: string[] }): NoteRecord {
    const id = `note_${this.counters.note++}`;
    const record: NoteRecord = {
      id,
      title: input.title,
      body: input.body,
      tags: [...input.tags],
      createdAt: new Date(this.now()).toISOString(),
    };
    this.notes.set(id, record);
    return record;
  }

  /** Fetch a note by id; `undefined` when unknown. */
  getNote(id: string): NoteRecord | undefined {
    return this.notes.get(id);
  }

  /** List notes in creation order, optionally filtered by tag. */
  listNotes(opts: { tag?: string } = {}): NoteRecord[] {
    const items: NoteRecord[] = [];
    for (const record of this.notes.values()) {
      if (opts.tag !== undefined && !record.tags.includes(opts.tag)) continue;
      items.push(record);
    }
    return items;
  }

  /** Delete a note by id. Returns `false` when the id is unknown. */
  deleteNote(id: string): boolean {
    return this.notes.delete(id);
  }

  /** Number of stored notes. */
  countNotes(): number {
    return this.notes.size;
  }

  /** Tag usage counts, sorted by count descending then tag ascending. */
  tagCounts(): TagCountEntry[] {
    const counts = new Map<string, number>();
    for (const record of this.notes.values()) {
      for (const tag of record.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const rows = [...counts.entries()].map(([tag, count]) => ({ tag, count }));
    rows.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
    return rows;
  }

  // ── snapshot support ─────────────────────────────────────────────────────

  /** Export canonical state (records, click ledger, counters). */
  dump(): StoreDump {
    return {
      links: [...this.links.values()].map((record) => ({ ...record })),
      clicks: Object.fromEntries(this.clicksBySlug),
      notes: [...this.notes.values()].map((record) => ({ ...record, tags: [...record.tags] })),
      counters: { ...this.counters },
    };
  }

  /**
   * Replace all state with `dump`. The slug index is derived state: it is
   * always rebuilt from the canonical records here, never read from disk,
   * so a snapshot can never smuggle in a divergent index.
   */
  load(dump: StoreDump): void {
    this.links.clear();
    this.slugIndex.clear();
    this.clicksBySlug.clear();
    this.notes.clear();
    for (const record of dump.links) {
      this.links.set(record.id, { ...record });
      this.slugIndex.set(record.slug, record.id);
    }
    for (const [slug, clicks] of Object.entries(dump.clicks)) {
      this.clicksBySlug.set(slug, clicks);
    }
    for (const record of dump.notes) {
      this.notes.set(record.id, { ...record, tags: [...record.tags] });
    }
    this.counters = { link: dump.counters.link, note: dump.counters.note };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Deterministic slug generator (32-bit LCG). Seeded per store so test
   * fixtures are reproducible; uniqueness is enforced by the caller's
   * index check, not by the generator itself.
   */
  private generateSlug(): string {
    let slug = "";
    for (let i = 0; i < SLUG_LENGTH; i++) {
      this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
      slug += SLUG_ALPHABET[this.rngState % SLUG_ALPHABET.length];
    }
    return slug;
  }
}
