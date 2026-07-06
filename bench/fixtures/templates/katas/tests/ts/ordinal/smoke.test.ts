import { expect, test } from "bun:test";
import { ordinal } from "../../../ts/ordinal.ts";

test("module exports ordinal", () => {
  expect(typeof ordinal).toBe("function");
});
