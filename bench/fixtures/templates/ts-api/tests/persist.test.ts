import { describe, expect, test } from "bun:test";
import { parseSnapshot, serializeSnapshot, takeSnapshot } from "../src/persist.ts";
import { SnapshotError } from "../src/errors.ts";
import { Store } from "../src/store.ts";
import { TOKENS, makeApp, req } from "./helpers.ts";

const admin = TOKENS.root;

function seed(app: ReturnType<typeof makeApp>["app"]) {
  app.handle(
    req("POST", "/api/links", { token: admin, body: { url: "https://example.com/1", slug: "one" } }),
  );
  app.handle(
    req("POST", "/api/links", { token: admin, body: { url: "https://example.com/2", slug: "two" } }),
  );
  app.handle(req("GET", "/r/one"));
  app.handle(req("GET", "/r/one"));
  app.handle(req("POST", "/api/notes", { token: admin, body: { title: "note", tags: ["ops"] } }));
}

describe("POST /api/admin/snapshot", () => {
  test("captures records, click ledger and counters", () => {
    const { app } = makeApp();
    seed(app);
    const res = app.handle(req("POST", "/api/admin/snapshot", { token: admin }));
    expect(res.status).toBe(200);
    const snap = res.body as {
      version: number;
      data: { links: unknown[]; notes: unknown[]; clicks: Record<string, number> };
    };
    expect(snap.version).toBe(1);
    expect(snap.data.links).toHaveLength(2);
    expect(snap.data.notes).toHaveLength(1);
    expect(snap.data.clicks.one).toBe(2);
  });
});

describe("POST /api/admin/restore", () => {
  test("round-trips the dataset into a fresh instance", () => {
    const { app: source } = makeApp();
    seed(source);
    const snapshot = source.handle(req("POST", "/api/admin/snapshot", { token: admin })).body;

    const { app: target } = makeApp();
    const restored = target.handle(
      req("POST", "/api/admin/restore", { token: admin, body: snapshot }),
    );
    expect(restored.status).toBe(200);
    expect((restored.body as { restored: unknown }).restored).toEqual({ links: 2, notes: 1 });

    const follow = target.handle(req("GET", "/r/two"));
    expect(follow.status).toBe(302);
    expect(follow.headers?.location).toBe("https://example.com/2");
    const record = target.handle(req("GET", "/api/links/one", { token: admin }));
    expect((record.body as { clicks: number }).clicks).toBe(2);
    const notes = target.handle(req("GET", "/api/notes", { token: admin }));
    expect((notes.body as { total: number }).total).toBe(1);
  });

  test("restored counters keep new ids unique", () => {
    const { app: source } = makeApp();
    seed(source);
    const snapshot = source.handle(req("POST", "/api/admin/snapshot", { token: admin })).body;
    const { app: target } = makeApp();
    target.handle(req("POST", "/api/admin/restore", { token: admin, body: snapshot }));
    const created = target.handle(
      req("POST", "/api/links", { token: admin, body: { url: "https://example.com/3" } }),
    );
    expect(created.status).toBe(201);
    expect((created.body as { id: string }).id).toBe("lnk_3");
  });

  test("rejects malformed snapshots without applying anything", () => {
    const { app } = makeApp();
    seed(app);
    const bad = app.handle(
      req("POST", "/api/admin/restore", { token: admin, body: { version: 99 } }),
    );
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toBe("invalid_snapshot");
    const list = app.handle(req("GET", "/api/links", { token: admin }));
    expect((list.body as { total: number }).total).toBe(2);
  });
});

describe("snapshot serialisation", () => {
  test("serialize/parse round-trips and garbage is refused", () => {
    const store = new Store({ now: () => 1_700_000_000_000 });
    store.createLink({ url: "https://example.com", slug: "pin" });
    const snap = takeSnapshot(store, 1_700_000_000_000);
    expect(parseSnapshot(serializeSnapshot(snap))).toEqual(snap);
    expect(() => parseSnapshot("{ not json")).toThrow(SnapshotError);
    expect(() => parseSnapshot('{"version":1}')).toThrow(SnapshotError);
  });
});
