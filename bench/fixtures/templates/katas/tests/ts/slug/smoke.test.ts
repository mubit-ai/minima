import { expect, test } from "bun:test";
import { slugify } from "../../../ts/slug.ts";

test("module exports slugify", () => {
  expect(typeof slugify).toBe("function");
});
