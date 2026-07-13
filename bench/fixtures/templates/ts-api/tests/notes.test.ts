import { describe, expect, test } from "bun:test";
import { TOKENS, makeApp, req } from "./helpers.ts";

const token = TOKENS.alice;

function create(app: ReturnType<typeof makeApp>["app"], body: unknown) {
  return app.handle(req("POST", "/api/notes", { token, body }));
}

describe("POST /api/notes", () => {
  test("creates a note with defaults applied", () => {
    const { app } = makeApp();
    const res = create(app, { title: "standup", tags: ["work"] });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.id).toMatch(/^note_/);
    expect(body.title).toBe("standup");
    expect(body.body).toBe("");
    expect(body.tags).toEqual(["work"]);
    expect(body.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("rejects a missing title", () => {
    const { app } = makeApp();
    const res = create(app, { body: "no title here" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_note");
  });

  test("rejects too many or malformed tags", () => {
    const { app } = makeApp();
    const many = create(app, { title: "t", tags: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"] });
    expect(many.status).toBe(400);
    const bad = create(app, { title: "t", tags: ["Bad Tag!"] });
    expect(bad.status).toBe(400);
  });

});

describe("GET /api/notes", () => {
  test("lists notes in creation order", () => {
    const { app } = makeApp();
    create(app, { title: "first" });
    create(app, { title: "second" });
    const res = app.handle(req("GET", "/api/notes", { token }));
    expect(res.status).toBe(200);
    const body = res.body as { items: { title: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.title)).toEqual(["first", "second"]);
  });

  test("filters by tag", () => {
    const { app } = makeApp();
    create(app, { title: "keep", tags: ["work"] });
    create(app, { title: "skip", tags: ["home"] });
    const res = app.handle(req("GET", "/api/notes", { token, query: { tag: "work" } }));
    const body = res.body as { items: { title: string }[] };
    expect(body.items.map((item) => item.title)).toEqual(["keep"]);
  });

  test("rejects a malformed tag filter", () => {
    const { app } = makeApp();
    const res = app.handle(req("GET", "/api/notes", { token, query: { tag: "NOT OK" } }));
    expect(res.status).toBe(400);
  });
});

describe("GET & DELETE /api/notes/:id", () => {
  test("fetches by id and 404s on unknown ids", () => {
    const { app } = makeApp();
    const created = create(app, { title: "target" });
    const id = (created.body as { id: string }).id;
    const hit = app.handle(req("GET", `/api/notes/${id}`, { token }));
    expect(hit.status).toBe(200);
    expect((hit.body as { title: string }).title).toBe("target");
    expect(app.handle(req("GET", "/api/notes/note_999", { token })).status).toBe(404);
  });

  test("deletes and stops listing the note", () => {
    const { app } = makeApp();
    const created = create(app, { title: "bye" });
    const id = (created.body as { id: string }).id;
    expect(app.handle(req("DELETE", `/api/notes/${id}`, { token })).status).toBe(204);
    expect(app.handle(req("GET", `/api/notes/${id}`, { token })).status).toBe(404);
    const list = app.handle(req("GET", "/api/notes", { token }));
    expect((list.body as { total: number }).total).toBe(0);
  });
});
