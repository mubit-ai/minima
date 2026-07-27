/**
 * Per-request deadline. fetch has no timeout of its own, so without this a black-holed
 * connection — a hung proxy, a dropped route, a server that accepts and never answers —
 * hung the caller forever. Defaults on (60s); `timeoutMs: 0` opts out.
 */

import { describe, expect, test } from "bun:test";
import { MinimaClient } from "../src/client.ts";
import type { FetchLike } from "../src/client.ts";

/** A fetch that never resolves — it only rejects with the signal's reason on abort. */
function hangingFetch() {
  const inits: { signal?: AbortSignal }[] = [];
  const fetchLike: FetchLike = (_url, init) => {
    inits.push(init ?? {});
    return new Promise((_, reject) => {
      const sig = init?.signal;
      if (!sig) return; // hang forever — nothing to abort with
      if (sig.aborted) reject(sig.reason);
      else sig.addEventListener("abort", () => reject(sig.reason), { once: true });
    });
  };
  return { fetchLike, inits };
}

const REQ = { recommendation_id: "r", chosen_model_id: "m", outcome: "success" as const };

describe("MinimaClient timeoutMs", () => {
  test("a GET against a black-holed server rejects instead of hanging", async () => {
    const { fetchLike } = hangingFetch();
    const c = new MinimaClient({ baseUrl: "http://svc.local", timeoutMs: 25, fetch: fetchLike });
    const exc = await c.health().catch((e) => e);
    expect((exc as Error).name).toBe("TimeoutError");
  });

  test("a POST gets the deadline too", async () => {
    const { fetchLike } = hangingFetch();
    const c = new MinimaClient({ baseUrl: "http://svc.local", timeoutMs: 25, fetch: fetchLike });
    const exc = await c.recommend("hi").catch((e) => e);
    expect((exc as Error).name).toBe("TimeoutError");
  });

  test("the deadline is on by default — no opt-in required", async () => {
    const { fetchLike, inits } = hangingFetch();
    const c = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    void c.health().catch(() => {});
    await Promise.resolve();
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("timeoutMs: 0 opts out — no signal is attached", async () => {
    const { fetchLike, inits } = hangingFetch();
    const c = new MinimaClient({ baseUrl: "http://svc.local", timeoutMs: 0, fetch: fetchLike });
    void c.health().catch(() => {});
    await Promise.resolve();
    expect(inits[0]!.signal).toBeUndefined();
  });

  test("a caller signal still aborts when composed with the deadline", async () => {
    const { fetchLike } = hangingFetch();
    const c = new MinimaClient({
      baseUrl: "http://svc.local",
      timeoutMs: 60_000,
      fetch: fetchLike,
    });
    const ctl = new AbortController();
    const p = c.recommend("hi", { signal: ctl.signal }).catch((e) => e);
    ctl.abort(new Error("user cancelled"));
    expect(((await p) as Error).message).toBe("user cancelled");
  });

  test("a timed-out feedback is NOT retried — the deadline was already spent", async () => {
    const { fetchLike, inits } = hangingFetch();
    const c = new MinimaClient({
      baseUrl: "http://svc.local",
      timeoutMs: 25,
      feedbackRetryDelaysMs: [1, 1],
      fetch: fetchLike,
    });
    const exc = await c.feedbackRaw(REQ).catch((e) => e);
    expect((exc as Error).name).toBe("TimeoutError");
    expect(inits).toHaveLength(1); // one attempt, not three
  });

  test("a transient 503 is still retried — the old classification is intact", async () => {
    let n = 0;
    const fetchLike: FetchLike = async () => {
      n++;
      return n === 1
        ? { status: 503, json: async () => ({ detail: "down" }) }
        : { status: 200, json: async () => ({ accepted: true }) };
    };
    const c = new MinimaClient({
      baseUrl: "http://svc.local",
      feedbackRetryDelaysMs: [1, 1],
      fetch: fetchLike,
    });
    expect(await c.feedbackRaw(REQ)).toEqual({ accepted: true });
    expect(n).toBe(2);
  });
});
