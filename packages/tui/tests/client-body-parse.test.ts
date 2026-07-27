/**
 * MinimaClient body parsing: a non-JSON error body (proxy HTML on a 502/504, empty body)
 * used to throw SyntaxError from resp.json() BEFORE raiseForStatus ran, so no MinimaError
 * was ever built and the real status was lost. The routing banner then read
 * "routing offline: Unexpected token '<'" instead of naming the 504, and the same parse
 * noise surfaced as the learning-loop error. Ported from packages/sdk (dce63eb).
 */

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/minima/client.ts";
import { MinimaClient } from "../src/minima/index.ts";
import { MinimaError, isBudgetInfeasible, raiseForStatus } from "../src/minima/errors.ts";

/** A fetch whose body is not JSON — resp.json() rejects, exactly like a real proxy page. */
function nonJsonFetch(status: number, body: string): FetchLike {
  return async () => ({
    status,
    json: async () => {
      JSON.parse(body); // throws SyntaxError, as the real Response.json() would
      return null;
    },
  });
}

function client(fetchLike: FetchLike): MinimaClient {
  return new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
}

describe("MinimaClient non-JSON error bodies", () => {
  test("a proxy's HTML 502 throws MinimaError carrying the status, not SyntaxError", async () => {
    const c = client(nonJsonFetch(502, "<html><body>502 Bad Gateway</body></html>"));
    const exc = await c.health().catch((e) => e);
    expect(exc).toBeInstanceOf(MinimaError);
    expect(exc.name).not.toBe("SyntaxError");
    expect((exc as MinimaError).status).toBe(502);
  });

  test("the message names the status instead of rendering the literal string 'null'", async () => {
    const c = client(nonJsonFetch(504, ""));
    const exc = await c.health().catch((e) => e);
    expect((exc as MinimaError).message).toBe("HTTP 504");
    expect((exc as MinimaError).message).not.toContain("null");
    expect((exc as MinimaError).message).not.toContain("Unexpected");
  });

  test("POST bodies get the same treatment (feedback must not die on proxy HTML)", async () => {
    const c = client(nonJsonFetch(503, "<html>503</html>"));
    const exc = await c
      .feedback({
        recommendation_id: "rec_1",
        chosen_model_id: "m",
        outcome: "success",
      })
      .catch((e) => e);
    expect(exc).toBeInstanceOf(MinimaError);
    expect((exc as MinimaError).status).toBe(503);
  });

  test("a 2xx with an unparseable body still succeeds (null, not a throw)", async () => {
    const c = client(nonJsonFetch(200, "not json"));
    expect(await c.health()).toBeNull();
  });

  test("a real JSON detail is still surfaced verbatim — no regression", () => {
    const exc = (() => {
      try {
        raiseForStatus(422, { detail: "no model within max_cost_per_call budget" });
      } catch (e) {
        return e as MinimaError;
      }
    })()!;
    expect(exc.message).toBe("no model within max_cost_per_call budget");
    // The budget-infeasibility probe keys on the message; the fallback must not break it.
    expect(isBudgetInfeasible(exc)).toBe(true);
  });
});
