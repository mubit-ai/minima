import { expect, test } from "bun:test";
import { isBalanced } from "../../../ts/brackets.ts";

test("module exports isBalanced", () => {
  expect(typeof isBalanced).toBe("function");
});
