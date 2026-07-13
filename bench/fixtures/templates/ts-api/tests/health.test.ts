import { describe, expect, test } from "bun:test";
import { makeApp, req } from "./helpers.ts";

describe("GET /api/health", () => {
  test("responds ok without authentication", () => {
    const { app } = makeApp();
    const res = app.handle(req("GET", "/api/health"));
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  test("uptime follows the injected clock", () => {
    const { app, clock } = makeApp();
    clock.advance(5_000);
    const res = app.handle(req("GET", "/api/health"));
    expect((res.body as { uptimeMs: number }).uptimeMs).toBe(5_000);
  });
});
