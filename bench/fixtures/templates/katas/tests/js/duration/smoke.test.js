import { expect, test } from "bun:test";
import { parseDuration } from "../../../js/duration.js";

test("module exports parseDuration", () => {
  expect(typeof parseDuration).toBe("function");
});
