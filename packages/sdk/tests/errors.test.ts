/**
 * raiseForStatus is the whole error contract, and until now it was only ever reached
 * through get/post — so the status mapping and the detail extraction were tested at
 * exactly two statuses and one body shape.
 *
 * The case that matters most: readBody returns null for a non-JSON body (proxy HTML on a
 * 502/504, an empty body), and a message of "null" tells an operator nothing. The status
 * is the only real information such a response carries.
 */

import { describe, expect, test } from "bun:test";
import {
  MinimaError,
  MinimaRateLimited,
  MinimaUnavailable,
  raiseForStatus,
} from "../src/errors.ts";

function thrownBy(status: number, body: unknown, retryAfter?: number): MinimaError {
  try {
    raiseForStatus(status, body, retryAfter);
  } catch (exc) {
    return exc as MinimaError;
  }
  throw new Error(`raiseForStatus(${status}) did not throw`);
}

describe("raiseForStatus — status mapping", () => {
  test.each([200, 201, 204, 299])("%i is a success — no throw", (status) => {
    expect(() => raiseForStatus(status, null)).not.toThrow();
  });

  test.each([502, 503, 504])("%i is retryable upstream trouble", (status) => {
    const exc = thrownBy(status, { detail: "upstream" });
    expect(exc).toBeInstanceOf(MinimaUnavailable);
    expect(exc.name).toBe("MinimaUnavailable");
  });

  test.each([400, 401, 404, 422, 500])("%i is a plain MinimaError", (status) => {
    const exc = thrownBy(status, { detail: "nope" });
    expect(exc.constructor).toBe(MinimaError);
    expect(exc.name).toBe("MinimaError");
    expect(exc.status).toBe(status);
  });

  test("the raw body is preserved for the caller to inspect", () => {
    const body = { detail: "nope", trace_id: "abc" };
    expect(thrownBy(500, body).body).toBe(body);
  });

  test("every subtype is a MinimaError whose name starts with Minima", () => {
    // feedbackRaw classifies transport-vs-service faults on exc.name.startsWith("Minima").
    for (const exc of [thrownBy(429, {}), thrownBy(503, {}), thrownBy(500, {})]) {
      expect(exc).toBeInstanceOf(MinimaError);
      expect(exc.name).toStartWith("Minima");
    }
  });
});

describe("raiseForStatus — 429", () => {
  test("carries retry-after through", () => {
    const exc = thrownBy(429, { detail: "slow down" }, 7) as MinimaRateLimited;
    expect(exc).toBeInstanceOf(MinimaRateLimited);
    expect(exc.retryAfter).toBe(7);
  });

  test("retryAfter defaults to null when the argument is omitted", () => {
    expect((thrownBy(429, { detail: "slow down" }) as MinimaRateLimited).retryAfter).toBeNull();
  });
});

describe("detail extraction", () => {
  test("a string detail is the message verbatim", () => {
    expect(thrownBy(422, { detail: "no model within budget" }).message).toBe(
      "no model within budget",
    );
  });

  test("a FastAPI validation detail (array of objects) is JSON, not [object Object]", () => {
    const detail = [{ loc: ["body", "task"], msg: "field required", type: "value_error.missing" }];
    const message = thrownBy(422, { detail }).message;
    expect(message).toBe(JSON.stringify(detail));
    expect(message).not.toContain("[object Object]");
  });

  test("a body with no detail key falls back to the whole body", () => {
    expect(thrownBy(500, { error: "boom" }).message).toBe('{"error":"boom"}');
  });

  test.each([
    [null, 504],
    [undefined, 502],
  ])("a %p body (non-JSON response) names the status, never 'null'", (body, status) => {
    const exc = thrownBy(status, body);
    expect(exc.message).toBe(`HTTP ${status}`);
    expect(exc).toBeInstanceOf(MinimaUnavailable);
  });

  test("a circular detail degrades to String() rather than blowing up in the error path", () => {
    const detail: Record<string, unknown> = { a: 1 };
    detail.self = detail;
    expect(thrownBy(500, { detail }).message).toBe("[object Object]");
  });
});
