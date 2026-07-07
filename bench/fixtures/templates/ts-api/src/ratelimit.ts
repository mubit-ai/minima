/**
 * linkbox — fixed-window rate limiting.
 *
 * Each key (typically a client address) gets a counting window of
 * `windowMs` milliseconds. The first hit opens the window; every hit inside
 * it consumes one unit of the budget. Once `limit` hits have been consumed,
 * further hits are refused until the window has fully elapsed — after which
 * the next hit opens a fresh window with a completely fresh budget. A quiet
 * key therefore always recovers after at most one window of silence.
 *
 * The clock is injected so tests (and replay tooling) can drive time
 * explicitly instead of sleeping.
 */

/** Constructor options for {@link FixedWindowLimiter}. */
export interface RateLimitOptions {
  /** Maximum hits allowed inside one window. Must be >= 1. */
  limit: number;
  /** Window length in milliseconds. Must be >= 1. */
  windowMs: number;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
}

/** Outcome of a single {@link FixedWindowLimiter.hit} call. */
export interface RateDecision {
  /** Whether the hit is admitted. */
  allowed: boolean;
  /** Budget left in the current window after this hit (0 when refused). */
  remaining: number;
  /** When refused: milliseconds until the window expires. 0 when allowed. */
  retryAfterMs: number;
}

interface WindowEntry {
  windowStart: number;
  count: number;
}

/** Per-key fixed-window counter. */
export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, WindowEntry>();

  constructor(opts: RateLimitOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new RangeError(`rate limit must be a positive integer, got ${opts.limit}`);
    }
    if (!Number.isInteger(opts.windowMs) || opts.windowMs < 1) {
      throw new RangeError(`window must be a positive integer of ms, got ${opts.windowMs}`);
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record one hit for `key` and decide whether it is admitted.
   *
   * A hit that arrives once the key's window has fully elapsed opens a new
   * window and counts as the first hit of that window.
   */
  hit(key: string): RateDecision {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.windowStart + this.windowMs - now,
      };
    }
    return { allowed: true, remaining: this.limit - entry.count, retryAfterMs: 0 };
  }

  /** Forget every tracked window (used after admin restores and in tests). */
  reset(): void {
    this.entries.clear();
  }

  /** Number of keys currently tracked (diagnostics only). */
  size(): number {
    return this.entries.size;
  }
}
