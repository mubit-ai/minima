import { describe, expect, test } from "bun:test";
import {
  isValidHttpUrl,
  isValidSlug,
  parseBoundedInt,
  parsePagination,
  validateLinkCreate,
  validateNoteCreate,
} from "../src/validate.ts";

describe("isValidHttpUrl", () => {
  test("accepts absolute http(s) urls only", () => {
    expect(isValidHttpUrl("https://example.com/a?b=1")).toBe(true);
    expect(isValidHttpUrl("http://example.com")).toBe(true);
    expect(isValidHttpUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpUrl("/relative/path")).toBe(false);
    expect(isValidHttpUrl(42)).toBe(false);
  });
});

describe("isValidSlug", () => {
  test("enforces length and character rules", () => {
    expect(isValidSlug("ab")).toBe(true);
    expect(isValidSlug("a".repeat(32))).toBe(true);
    expect(isValidSlug("with-dash_ok2")).toBe(true);
    expect(isValidSlug("a")).toBe(false);
    expect(isValidSlug("a".repeat(33))).toBe(false);
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
  });
});

describe("validateLinkCreate", () => {
  test("collects every problem in one pass", () => {
    const result = validateLinkCreate({ url: "nope", slug: "!" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  test("ignores unknown fields", () => {
    const result = validateLinkCreate({ url: "https://example.com", extra: true });
    expect(result.ok).toBe(true);
  });
});

describe("validateNoteCreate", () => {
  test("defaults body and tags", () => {
    const result = validateNoteCreate({ title: "  hello  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ title: "hello", body: "", tags: [] });
    }
  });
});

describe("pagination parsing", () => {
  test("applies defaults and rejects out-of-range values", () => {
    const ok = parsePagination({});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ limit: 20, offset: 0 });
    expect(parsePagination({ limit: "0" }).ok).toBe(false);
    expect(parsePagination({ limit: "101" }).ok).toBe(false);
    expect(parsePagination({ offset: "-1" }).ok).toBe(false);
    expect(parsePagination({ limit: "5x" }).ok).toBe(false);
  });

  test("parseBoundedInt falls back only when the param is absent", () => {
    expect(parseBoundedInt(undefined, { min: 1, max: 50, fallback: 5 })).toBe(5);
    expect(parseBoundedInt("7", { min: 1, max: 50, fallback: 5 })).toBe(7);
    expect(parseBoundedInt("boom", { min: 1, max: 50, fallback: 5 })).toBeNull();
  });
});
