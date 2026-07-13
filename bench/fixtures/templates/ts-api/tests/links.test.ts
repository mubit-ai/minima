import { describe, expect, test } from "bun:test";
import { TOKENS, makeApp, req } from "./helpers.ts";

const write = TOKENS.alice;

function create(app: ReturnType<typeof makeApp>["app"], body: unknown) {
  return app.handle(req("POST", "/api/links", { token: write, body }));
}

describe("POST /api/links", () => {
  test("creates a link with a generated slug", () => {
    const { app } = makeApp();
    const res = create(app, { url: "https://example.com/a" });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.url).toBe("https://example.com/a");
    expect(body.slug).toMatch(/^[a-z0-9]{6}$/);
    expect(body.id).toMatch(/^lnk_/);
    expect(body.clicks).toBe(0);
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("honours a valid custom slug", () => {
    const { app } = makeApp();
    const res = create(app, { url: "https://example.com", slug: "docs" });
    expect(res.status).toBe(201);
    expect((res.body as { slug: string }).slug).toBe("docs");
  });

  test("rejects an invalid destination url or custom slug", () => {
    const { app } = makeApp();
    const badUrl = create(app, { url: "not-a-url" });
    expect(badUrl.status).toBe(400);
    expect((badUrl.body as { error: string }).error).toBe("invalid_link");
    const badSlug = create(app, { url: "https://example.com", slug: "!bad slug!" });
    expect(badSlug.status).toBe(400);
  });
});

describe("GET /api/links", () => {
  test("lists links in slug order with pagination metadata", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com/1", slug: "zeta" });
    create(app, { url: "https://example.com/2", slug: "alpha" });
    create(app, { url: "https://example.com/3", slug: "mid" });
    const res = app.handle(req("GET", "/api/links", { token: write }));
    expect(res.status).toBe(200);
    const body = res.body as { items: { slug: string }[]; total: number; limit: number };
    expect(body.total).toBe(3);
    expect(body.limit).toBe(20);
    expect(body.items.map((item) => item.slug)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("windows results by limit and offset", () => {
    const { app } = makeApp();
    for (const slug of ["aa", "bb", "cc", "dd"]) {
      create(app, { url: `https://example.com/${slug}`, slug });
    }
    const res = app.handle(
      req("GET", "/api/links", { token: write, query: { limit: "2", offset: "1" } }),
    );
    const body = res.body as { items: { slug: string }[]; total: number };
    expect(body.items.map((item) => item.slug)).toEqual(["bb", "cc"]);
    expect(body.total).toBe(4);
    const bad = app.handle(req("GET", "/api/links", { token: write, query: { limit: "abc" } }));
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/links/:slug", () => {
  test("returns the record and 404s on unknown slugs", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com/x", slug: "known" });
    const hit = app.handle(req("GET", "/api/links/known", { token: write }));
    expect(hit.status).toBe(200);
    expect((hit.body as { url: string }).url).toBe("https://example.com/x");
    const miss = app.handle(req("GET", "/api/links/ghost", { token: write }));
    expect(miss.status).toBe(404);
  });
});

describe("PATCH /api/links/:slug", () => {
  test("updates the destination url", () => {
    const { app } = makeApp();
    create(app, { url: "https://old.example.com", slug: "move" });
    const res = app.handle(
      req("PATCH", "/api/links/move", { token: write, body: { url: "https://new.example.com" } }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { url: string }).url).toBe("https://new.example.com");
    const follow = app.handle(req("GET", "/r/move"));
    expect(follow.headers?.location).toBe("https://new.example.com");
  });

  test("renames a slug and serves it under the new name", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com/r", slug: "before" });
    const res = app.handle(
      req("PATCH", "/api/links/before", { token: write, body: { slug: "after" } }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { slug: string }).slug).toBe("after");
    const fetched = app.handle(req("GET", "/api/links/after", { token: write }));
    expect(fetched.status).toBe(200);
  });

  test("rejects an empty update and 404s on unknown slugs", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com", slug: "solo" });
    const empty = app.handle(req("PATCH", "/api/links/solo", { token: write, body: {} }));
    expect(empty.status).toBe(400);
    const miss = app.handle(
      req("PATCH", "/api/links/ghost", { token: write, body: { url: "https://example.com" } }),
    );
    expect(miss.status).toBe(404);
  });
});

describe("DELETE /api/links/:slug", () => {
  test("removes the link entirely", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com", slug: "gone" });
    const res = app.handle(req("DELETE", "/api/links/gone", { token: write }));
    expect(res.status).toBe(204);
    expect(app.handle(req("GET", "/api/links/gone", { token: write })).status).toBe(404);
    expect(app.handle(req("GET", "/r/gone")).status).toBe(404);
  });
});

describe("GET /r/:slug", () => {
  test("redirects and records the click", () => {
    const { app } = makeApp();
    create(app, { url: "https://example.com/target", slug: "hot" });
    const res = app.handle(req("GET", "/r/hot"));
    expect(res.status).toBe(302);
    expect(res.headers?.location).toBe("https://example.com/target");
    const fetched = app.handle(req("GET", "/api/links/hot", { token: write }));
    expect((fetched.body as { clicks: number }).clicks).toBe(1);
  });

  test("404s for unknown slugs", () => {
    const { app } = makeApp();
    expect(app.handle(req("GET", "/r/nothing")).status).toBe(404);
  });
});

describe("routing edges", () => {
  test("known path with wrong verb yields 405, unknown path 404", () => {
    const { app } = makeApp();
    expect(app.handle(req("PUT", "/api/links", { token: write })).status).toBe(405);
    expect(app.handle(req("GET", "/api/nope", { token: write })).status).toBe(404);
  });
});
