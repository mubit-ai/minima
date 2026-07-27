/**
 * Feedback retry (SDK parity with 4249e7d, never ported to the TUI).
 *
 * A dropped label is a PERMANENT learning loss: runtime.ts's feedbackSafely
 * logs-and-swallows, so nothing re-sends it and a gate-verified outcome is gone. Retrying
 * is safe — the server's reconcile replay guard dedupes on recommendation_id.
 *
 * The TUI diverges from packages/sdk on purpose: feedback is awaited in the turn's
 * critical path, so only FAST faults are retried. A timeout is not.
 */

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/minima/client.ts";
import { MinimaClient, isFastRetryable, retryDelayMs } from "../src/minima/client.ts";
import { MinimaError, MinimaRateLimited, MinimaUnavailable } from "../src/minima/errors.ts";

const REQ = {
  recommendation_id: "rec_1",
  chosen_model_id: "m",
  outcome: "success" as const,
};

/** A fetch that replays `statuses` in order, recording every attempt. */
function scriptedFetch(statuses: (number | Error)[], retryAfter?: string) {
  const attempts: string[] = [];
  const fetchLike: FetchLike = async (url) => {
    const next = statuses[attempts.length];
    attempts.push(url);
    if (next instanceof Error) throw next;
    return {
      status: next ?? 200,
      json: async () => (next === 200 ? { accepted: true } : { detail: "nope" }),
      headers: { get: (n: string) => (n === "retry-after" ? (retryAfter ?? null) : null) },
    };
  };
  return { fetchLike, attempts };
}

function client(fetchLike: FetchLike): MinimaClient {
  return new MinimaClient({
    baseUrl: "http://svc.local",
    fetch: fetchLike,
    feedbackRetryDelaysMs: [1, 1], // keep the suite fast; schedule shape is what matters
  });
}

describe("MinimaClient.feedback retry", () => {
  test("a transient 503 is retried and the label survives", async () => {
    const { fetchLike, attempts } = scriptedFetch([503, 200]);
    expect(await client(fetchLike).feedback(REQ)).toEqual({ accepted: true });
    expect(attempts).toHaveLength(2);
  });

  test("a 429 is retried", async () => {
    const { fetchLike, attempts } = scriptedFetch([429, 200]);
    await client(fetchLike).feedback(REQ);
    expect(attempts).toHaveLength(2);
  });

  test("a connection-level fault is retried", async () => {
    const { fetchLike, attempts } = scriptedFetch([new TypeError("fetch failed"), 200]);
    await client(fetchLike).feedback(REQ);
    expect(attempts).toHaveLength(2);
  });

  test("the schedule bounds the attempts — 2 delays means 3 tries, then it gives up", async () => {
    const { fetchLike, attempts } = scriptedFetch([503, 503, 503, 503]);
    const exc = await client(fetchLike).feedback(REQ).catch((e) => e);
    expect(exc).toBeInstanceOf(MinimaUnavailable);
    expect(attempts).toHaveLength(3);
  });

  test("a 4xx is NOT retried — the server rejected it on the merits", async () => {
    const { fetchLike, attempts } = scriptedFetch([422, 200]);
    const exc = await client(fetchLike).feedback(REQ).catch((e) => e);
    expect(exc).toBeInstanceOf(MinimaError);
    expect((exc as MinimaError).status).toBe(422);
    expect(attempts).toHaveLength(1);
  });

  test("recommend is never retried — fail fast, fail open in the caller", async () => {
    const { fetchLike, attempts } = scriptedFetch([503, 200]);
    await client(fetchLike)
      .recommend("hi")
      .catch(() => {});
    expect(attempts).toHaveLength(1);
  });
});

describe("isFastRetryable (the TUI's divergence from the SDK)", () => {
  test("a deadline is never retried — it already cost a full timeout", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isFastRetryable(timeout)).toBe(false);
    expect(isFastRetryable(abort)).toBe(false);
  });

  test("server-answered transients and connection faults are retryable", () => {
    expect(isFastRetryable(new MinimaUnavailable("x", 503, {}))).toBe(true);
    expect(isFastRetryable(new MinimaRateLimited("x", 429, {}, null))).toBe(true);
    expect(isFastRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  test("a plain 4xx MinimaError is not retryable", () => {
    expect(isFastRetryable(new MinimaError("bad", 422, {}))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  test("a 429's retry-after wins over the backoff schedule", () => {
    expect(retryDelayMs(new MinimaRateLimited("x", 429, {}, 3), 500)).toBe(3000);
  });

  test("an absurd retry-after is capped so a bad header can't stall the turn", () => {
    expect(retryDelayMs(new MinimaRateLimited("x", 429, {}, 9999), 500)).toBe(10_000);
  });

  test("anything else uses the schedule", () => {
    expect(retryDelayMs(new MinimaUnavailable("x", 503, {}), 500)).toBe(500);
    expect(retryDelayMs(new TypeError("fetch failed"), 2000)).toBe(2000);
  });

  test("the retry-after header is parsed off the response and reaches the error", async () => {
    const { fetchLike } = scriptedFetch([429, 429, 429, 429], "7");
    const exc = await new MinimaClient({
      baseUrl: "http://svc.local",
      fetch: fetchLike,
      feedbackRetryDelaysMs: [],
    })
      .feedback(REQ)
      .catch((e) => e);
    expect(exc).toBeInstanceOf(MinimaRateLimited);
    expect((exc as MinimaRateLimited).retryAfter).toBe(7);
  });
});
