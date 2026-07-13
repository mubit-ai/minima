import { expect, test } from "bun:test";
import { digitalRoot } from "../../../js/droot.js";

test("module exports digitalRoot", () => {
  expect(typeof digitalRoot).toBe("function");
});
