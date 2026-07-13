import { expect, test } from "bun:test";
import { driftEncode } from "../../../ts/drift.ts";

test("module exports driftEncode", () => {
  expect(typeof driftEncode).toBe("function");
});
