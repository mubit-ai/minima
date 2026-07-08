import { describe, expect, test } from "bun:test";
import { TOKENS, makeApp, req } from "./helpers.ts";

const token = TOKENS.alice;

function seedLinks(app: ReturnType<typeof makeApp>["app"]) {
  for (const slug of ["aa", "bb", "cc"]) {
    app.handle(
      req("POST", "/api/links", { token, body: { url: `https://example.com/${slug}`, slug } }),
    );
  }
  app.handle(req("GET", "/r/bb"));
  app.handle(req("GET", "/r/bb"));
  app.handle(req("GET", "/r/bb"));
  app.handle(req("GET", "/r/cc"));
}

describe("GET /api/stats/links/top", () => {
  test("orders by clicks descending with alphabetical ties", () => {
    const { app } = makeApp();
    seedLinks(app);
    const res = app.handle(req("GET", "/api/stats/links/top", { token }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: { slug: string; clicks: number }[] }).items;
    expect(items.map((row) => row.slug)).toEqual(["bb", "cc", "aa"]);
    expect(items[0]!.clicks).toBe(3);
    expect(items[2]!.clicks).toBe(0);
  });

  test("honours the limit parameter and rejects bad values", () => {
    const { app } = makeApp();
    seedLinks(app);
    const limited = app.handle(
      req("GET", "/api/stats/links/top", { token, query: { limit: "1" } }),
    );
    expect((limited.body as { items: unknown[] }).items).toHaveLength(1);
    const bad = app.handle(req("GET", "/api/stats/links/top", { token, query: { limit: "zero" } }));
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/stats/tags", () => {
  test("counts tag usage across notes", () => {
    const { app } = makeApp();
    app.handle(req("POST", "/api/notes", { token, body: { title: "a", tags: ["work", "urgent"] } }));
    app.handle(req("POST", "/api/notes", { token, body: { title: "b", tags: ["work"] } }));
    const res = app.handle(req("GET", "/api/stats/tags", { token }));
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toEqual([
      { tag: "work", count: 2 },
      { tag: "urgent", count: 1 },
    ]);
  });

  test("requires authentication", () => {
    const { app } = makeApp();
    expect(app.handle(req("GET", "/api/stats/tags")).status).toBe(401);
  });
});
