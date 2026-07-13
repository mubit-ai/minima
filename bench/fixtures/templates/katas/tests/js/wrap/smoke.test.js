import { expect, test } from "bun:test";
import { wordWrap } from "../../../js/wrap.js";

test("module exports wordWrap", () => {
  expect(typeof wordWrap).toBe("function");
});
