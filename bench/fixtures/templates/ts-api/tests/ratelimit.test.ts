import { describe, expect, test } from "bun:test";
import { FixedWindowLimiter } from "../src/ratelimit.ts";
import { TOKENS, makeApp, req } from "./helpers.ts";

describe("FixedWindowLimiter", () => {
  test("admits hits up to the limit with a decreasing budget", () => {
    const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 1_000, now: () => 50_000 });
    expect(limiter.hit("k")).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.hit("k")).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(limiter.hit("k")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  test("refuses the hit after the budget is spent", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000, now: () => 50_000 });
    limiter.hit("k");
    limiter.hit("k");
    const refused = limiter.hit("k");
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBe(1_000);
  });

  test("tracks keys independently", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => 50_000 });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.hit("b").allowed).toBe(true);
  });

  test("rejects nonsensical construction options", () => {
    expect(() => new FixedWindowLimiter({ limit: 0, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new FixedWindowLimiter({ limit: 5, windowMs: 0 })).toThrow(RangeError);
  });
});

describe("redirects are rate limited per client", () => {
  test("throttles the configured client but not others", () => {
    const { app } = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    app.handle(
      req("POST", "/api/links", { token: TOKENS.alice, body: { url: "https://example.com", slug: "rl" } }),
    );
    const from = (ip: string) => req("GET", "/r/rl", { headers: { "x-forwarded-for": ip } });
    expect(app.handle(from("10.0.0.1")).status).toBe(302);
    expect(app.handle(from("10.0.0.1")).status).toBe(302);
    const blocked = app.handle(from("10.0.0.1"));
    expect(blocked.status).toBe(429);
    expect((blocked.body as { error: string }).error).toBe("rate_limited");
    expect((blocked.body as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(app.handle(from("10.0.0.2")).status).toBe(302);
  });
});
