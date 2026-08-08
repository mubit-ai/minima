import { describe, expect, test } from "bun:test";

import { EDITOR_FALLBACKS, resolveEditor, splitEditorArgv } from "../src/tui/editor.ts";

const none = () => null;
const all = (bin: string) => `/usr/bin/${bin}`;

describe("resolveEditor precedence", () => {
  test("$VISUAL wins over $EDITOR (the POSIX/git convention)", () => {
    const r = resolveEditor({ VISUAL: "emacs", EDITOR: "vi" }, none);
    expect(r).toEqual({ argv: ["emacs"], source: "VISUAL" });
  });

  test("$EDITOR is used when $VISUAL is unset", () => {
    expect(resolveEditor({ EDITOR: "vi" }, none)).toEqual({ argv: ["vi"], source: "EDITOR" });
  });

  test("an EMPTY $VISUAL is treated as absent and falls through to $EDITOR", () => {
    expect(resolveEditor({ VISUAL: "", EDITOR: "vi" }, none)?.source).toBe("EDITOR");
  });

  test("a WHITESPACE-ONLY $EDITOR is treated as absent and falls through to the probe", () => {
    const r = resolveEditor({ EDITOR: "   \t " }, all);
    expect(r).toEqual({ argv: ["nano"], source: "fallback" });
  });

  test("the fallback probe order is nano, vi, vim", () => {
    expect([...EDITOR_FALLBACKS]).toEqual(["nano", "vi", "vim"]);
  });

  test("nano is preferred — a user with no $EDITOR is by definition not a vi user", () => {
    expect(resolveEditor({}, all)).toEqual({ argv: ["nano"], source: "fallback" });
  });

  test("the probe skips to vi when nano is not installed", () => {
    const which = (bin: string) => (bin === "nano" ? null : `/usr/bin/${bin}`);
    expect(resolveEditor({}, which)).toEqual({ argv: ["vi"], source: "fallback" });
  });

  test("the probe reaches vim when only vim exists", () => {
    const which = (bin: string) => (bin === "vim" ? "/usr/bin/vim" : null);
    expect(resolveEditor({}, which)).toEqual({ argv: ["vim"], source: "fallback" });
  });

  test("nothing set and nothing on PATH resolves to null", () => {
    expect(resolveEditor({}, none)).toBeNull();
  });

  test("$EDITOR that splits to nothing (bare quotes) falls through", () => {
    expect(resolveEditor({ EDITOR: '""' }, all)?.source).toBe("EDITOR");
    expect(resolveEditor({ EDITOR: '""' }, all)?.argv).toEqual([""]);
  });

  test("$EDITOR carrying flags keeps them as separate argv elements", () => {
    expect(resolveEditor({ EDITOR: "code --wait" }, none)?.argv).toEqual(["code", "--wait"]);
  });
});

describe("splitEditorArgv", () => {
  test("a bare command is one argument", () => {
    expect(splitEditorArgv("vim")).toEqual(["vim"]);
  });

  test("flags split on whitespace", () => {
    expect(splitEditorArgv("vim -u NONE")).toEqual(["vim", "-u", "NONE"]);
    expect(splitEditorArgv("code --wait")).toEqual(["code", "--wait"]);
  });

  test("runs of whitespace collapse, and leading/trailing whitespace is dropped", () => {
    expect(splitEditorArgv("  vim   -u\tNONE  ")).toEqual(["vim", "-u", "NONE"]);
  });

  test("double quotes group a path with spaces", () => {
    expect(splitEditorArgv('"/Applications/My Editor" --wait')).toEqual([
      "/Applications/My Editor",
      "--wait",
    ]);
  });

  test("single quotes group and take everything literally", () => {
    expect(splitEditorArgv("'/opt/my editor' -f")).toEqual(["/opt/my editor", "-f"]);
    expect(splitEditorArgv(`'a"b'`)).toEqual(['a"b']);
  });

  test("backslash escapes a space outside quotes", () => {
    expect(splitEditorArgv("/opt/my\\ editor -f")).toEqual(["/opt/my editor", "-f"]);
  });

  test("backslash escapes a quote inside double quotes", () => {
    expect(splitEditorArgv('"a\\"b"')).toEqual(['a"b']);
  });

  test("quotes may be adjacent to unquoted text in one argument", () => {
    expect(splitEditorArgv('--flag="a b"')).toEqual(["--flag=a b"]);
  });

  test("an UNQUOTED path with spaces splits — POSIX behavior, pinned so nobody 'fixes' it", () => {
    // This is what a shell does. A user with such a path must quote it, exactly as they
    // would anywhere else; silently rejoining would break `code --wait`.
    expect(splitEditorArgv("/Applications/My Editor")).toEqual(["/Applications/My", "Editor"]);
  });

  test("an empty or whitespace-only value yields no arguments", () => {
    expect(splitEditorArgv("")).toEqual([]);
    expect(splitEditorArgv("   \t\n ")).toEqual([]);
  });

  test("an explicitly empty quoted argument is preserved", () => {
    expect(splitEditorArgv('vim ""')).toEqual(["vim", ""]);
  });

  test("an unterminated quote consumes the rest rather than throwing", () => {
    expect(splitEditorArgv('vim "unclosed arg')).toEqual(["vim", "unclosed arg"]);
  });
});
