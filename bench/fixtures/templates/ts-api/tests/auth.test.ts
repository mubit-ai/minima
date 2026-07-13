import { describe, expect, test } from "bun:test";
import { TOKENS, makeApp, req } from "./helpers.ts";

describe("authentication", () => {
  test("well-formed bearer credential is accepted", () => {
    const { app } = makeApp();
    const res = app.handle(req("GET", "/api/links", { token: TOKENS.alice }));
    expect(res.status).toBe(200);
  });

  test("scheme matching is case-insensitive per RFC 7235", () => {
    const { app } = makeApp();
    const res = app.handle(
      req("GET", "/api/links", { headers: { authorization: `bearer ${TOKENS.alice}` } }),
    );
    expect(res.status).toBe(200);
  });

  test("missing header on a protected route yields 401", () => {
    const { app } = makeApp();
    const res = app.handle(req("GET", "/api/links"));
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe("unauthorized");
  });

  test("unknown token yields 401", () => {
    const { app } = makeApp();
    const res = app.handle(req("GET", "/api/links", { token: "tok_never_issued" }));
    expect(res.status).toBe(401);
  });

  test("valid token lacking the required scope yields 403", () => {
    const { app } = makeApp();
    const res = app.handle(
      req("POST", "/api/links", { token: TOKENS.carol, body: { url: "https://example.com" } }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("forbidden");
  });

  test("admin routes refuse non-admin tokens", () => {
    const { app } = makeApp();
    const res = app.handle(req("POST", "/api/admin/snapshot", { token: TOKENS.alice }));
    expect(res.status).toBe(403);
  });
});
