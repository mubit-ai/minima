import { describe, expect, test } from "bun:test";
import { Store } from "../src/store.ts";

const NOW = 1_767_225_600_000; // 2026-01-01T00:00:00Z

function makeStore(): Store {
  return new Store({ now: () => NOW });
}

describe("Store links", () => {
  test("generated slugs are distinct and well-formed", () => {
    const store = makeStore();
    const slugs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      slugs.add(store.createLink({ url: `https://example.com/${i}` }).slug);
    }
    expect(slugs.size).toBe(25);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]{6}$/);
  });

  test("counts links and aggregates clicks", () => {
    const store = makeStore();
    store.createLink({ url: "https://example.com/a", slug: "aa" });
    store.createLink({ url: "https://example.com/b", slug: "bb" });
    store.recordClick("aa");
    store.recordClick("aa");
    store.recordClick("bb");
    expect(store.countLinks()).toBe(2);
    expect(store.getClicks("aa")).toBe(2);
    expect(store.totalClicks()).toBe(3);
  });

  test("deleting a link clears its click ledger entry", () => {
    const store = makeStore();
    store.createLink({ url: "https://example.com", slug: "tmp" });
    store.recordClick("tmp");
    expect(store.deleteLink("tmp")).toBe(true);
    expect(store.deleteLink("tmp")).toBe(false);
    expect(store.totalClicks()).toBe(0);
  });

  test("updateLink returns undefined for unknown slugs", () => {
    const store = makeStore();
    expect(store.updateLink("ghost", { url: "https://example.com" })).toBeUndefined();
  });
});

describe("Store notes", () => {
  test("tagCounts sorts by count then tag", () => {
    const store = makeStore();
    store.createNote({ title: "a", body: "", tags: ["beta", "alpha"] });
    store.createNote({ title: "b", body: "", tags: ["beta"] });
    expect(store.tagCounts()).toEqual([
      { tag: "beta", count: 2 },
      { tag: "alpha", count: 1 },
    ]);
  });
});

describe("Store dump/load", () => {
  test("round-trips links, notes, clicks and counters", () => {
    const store = makeStore();
    store.createLink({ url: "https://example.com/a", slug: "aa" });
    store.recordClick("aa");
    store.createNote({ title: "n", body: "b", tags: ["t1"] });

    const clone = makeStore();
    clone.load(store.dump());
    expect(clone.getLinkBySlug("aa")?.url).toBe("https://example.com/a");
    expect(clone.getClicks("aa")).toBe(1);
    expect(clone.countNotes()).toBe(1);
    const next = clone.createLink({ url: "https://example.com/b" });
    expect(next.id).toBe("lnk_2");
  });
});
