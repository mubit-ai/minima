import { describe, expect, test } from "bun:test";
import { Router, matchPattern, splitPath } from "../src/router.ts";
import { json } from "../src/respond.ts";

describe("matchPattern", () => {
  test("captures :name segments and decodes them", () => {
    expect(matchPattern("/api/links/:slug", "/api/links/my%20slug")).toEqual({ slug: "my slug" });
    expect(matchPattern("/api/links/:slug", "/api/notes/abc")).toBeNull();
  });

  test("requires matching segment counts but tolerates trailing slashes", () => {
    expect(matchPattern("/api/links", "/api/links/")).toEqual({});
    expect(matchPattern("/api/links", "/api/links/extra")).toBeNull();
    expect(splitPath("/a//b/")).toEqual(["a", "b"]);
  });
});

describe("Router", () => {
  test("resolves method case-insensitively and extracts params", () => {
    const router = new Router();
    router.add({ method: "GET", pattern: "/x/:id", handler: () => json(200, null) });
    const match = router.resolve("get", "/x/42");
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ id: "42" });
    expect(router.resolve("POST", "/x/42")).toBeNull();
  });

  test("hasPath reports path matches regardless of method", () => {
    const router = new Router();
    router.add({ method: "DELETE", pattern: "/x/:id", handler: () => json(200, null) });
    expect(router.hasPath("/x/1")).toBe(true);
    expect(router.hasPath("/y/1")).toBe(false);
  });
});
