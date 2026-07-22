/**
 * MinimaClient per-request deadline: `timeoutMs` was accepted by the constructor but
 * never enforced, so a black-holed request hung forever (one link in the pinned-busy
 * memory-leak chain). Every GET/POST now carries AbortSignal.timeout, composed with a
 * caller signal when one is given; omitting timeoutMs keeps the old signal-less shape.
 */

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/minima/client.ts";
import { MinimaClient } from "../src/minima/index.ts";

/** A fetch that never resolves — it only rejects with the signal's reason on abort. */
function hangingFetch() {
  const inits: { signal?: AbortSignal }[] = [];
  const fetchLike: FetchLike = (_url, init) => {
    inits.push(init ?? {});
    return new Promise((_, reject) => {
      const sig = init?.signal;
      if (!sig) return; // hang forever (no signal, nothing to abort with)
      if (sig.aborted) reject(sig.reason);
      else sig.addEventListener("abort", () => reject(sig.reason), { once: true });
    });
  };
  return { fetchLike, inits };
}

/** A fetch that records the init and resolves 200 (for the disabled-timeout shape check). */
function recordingFetch() {
  const inits: { signal?: AbortSignal }[] = [];
  const fetchLike: FetchLike = async (_url, init) => {
    inits.push(init ?? {});
    return { status: 200, json: async () => ({ ok: true }) };
  };
  return { fetchLike, inits };
}

describe("MinimaClient timeoutMs", () => {
  test("a GET against a black-holed server rejects with TimeoutError", async () => {
    const { fetchLike, inits } = hangingFetch();
    const client = new MinimaClient({ baseUrl: "http://svc.local", timeoutMs: 25, fetch: fetchLike });
    await expect(client.health()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(inits[0]?.signal).toBeDefined();
  });

  test("a caller signal composes with the deadline — abort wins promptly", async () => {
    const { fetchLike } = hangingFetch();
    const client = new MinimaClient({
      baseUrl: "http://svc.local",
      timeoutMs: 60_000,
      fetch: fetchLike,
    });
    const ctl = new AbortController();
    ctl.abort();
    await expect(client.recommend("task", { signal: ctl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("timeoutMs undefined keeps the old shape: GET carries no signal", async () => {
    const { fetchLike, inits } = recordingFetch();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    await client.health();
    expect(inits[0]?.signal).toBeUndefined();
  });
});
