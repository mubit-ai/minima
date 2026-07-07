import { expect, test } from "bun:test";
import { chunk } from "../../../js/chunk.js";

test("module exports chunk", () => {
  expect(typeof chunk).toBe("function");
});
