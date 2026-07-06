import { describe, expect, test } from "bun:test";
import { formatActionLabel, formatToolArgs } from "../src/tui/permissions.ts";

describe("formatToolArgs", () => {
  test("summarizes each builtin tool by its primary arg", () => {
    expect(formatToolArgs("bash", { command: "git diff --stat" })).toBe("git diff --stat");
    expect(formatToolArgs("read", { path: "src/app.tsx" })).toBe("src/app.tsx");
    expect(formatToolArgs("ls", {})).toBe(".");
    expect(formatToolArgs("write", { path: "out.txt" })).toBe("out.txt");
    expect(formatToolArgs("edit", { path: "a.ts" })).toBe("a.ts");
  });

  test("covers grep and glob via their pattern arg", () => {
    expect(formatToolArgs("grep", { pattern: "TODO", path: "src" })).toBe("TODO");
    expect(formatToolArgs("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  test("falls back to JSON for unknown tools", () => {
    expect(formatToolArgs("mystery", { a: 1 })).toBe('{"a":1}');
  });
});

describe("formatActionLabel", () => {
  test("prefixes the tool name and a compact arg summary", () => {
    expect(formatActionLabel("bash", { command: "git diff --stat" })).toBe(
      "bash: git diff --stat",
    );
    expect(formatActionLabel("grep", { pattern: "needle" })).toBe("grep: needle");
  });

  test("falls back to the bare tool name when args are null (unknown/invalid tool)", () => {
    expect(formatActionLabel("bash", null)).toBe("bash");
    expect(formatActionLabel("whatever", undefined)).toBe("whatever");
  });

  test("uses the bare tool name when the arg summary is empty", () => {
    expect(formatActionLabel("bash", { command: "" })).toBe("bash");
  });
});
