import { describe, expect, test } from "bun:test";

import {
  GUI_EDITOR_MS,
  NOTICE,
  decideEditorOutcome,
  normalizeEditedText,
} from "../src/tui/editor.ts";

const base = { seed: "hello", raw: "hello", exitCode: 0, spawnError: null, elapsedMs: 5000 };

describe("decideEditorOutcome — the decision table", () => {
  test("exit 0 with changed text APPLIES", () => {
    const out = decideEditorOutcome({ ...base, raw: "a new prompt\n" });
    expect(out.apply).toBe(true);
    expect(out.text).toBe("a new prompt");
    expect(out.notice).toBe(NOTICE.applied);
    expect(out.isError).toBe(false);
  });

  test("exit 0 with identical text KEEPS (no remount, so the cursor never jumps)", () => {
    const out = decideEditorOutcome({ ...base, raw: "hello\n" });
    expect(out.apply).toBe(false);
    expect(out.text).toBeNull();
    expect(out.notice).toBe(NOTICE.noChanges);
  });

  test("exit 0 with an EMPTIED buffer and a non-empty seed KEEPS (git's abort rule)", () => {
    const out = decideEditorOutcome({ ...base, seed: "a long prompt", raw: "" });
    expect(out.apply).toBe(false);
    expect(out.text).toBeNull();
    expect(out.notice).toBe(NOTICE.emptied);
    expect(out.isError).toBe(false);
  });

  test("an empty seed left empty is 'no changes', not 'emptied'", () => {
    const out = decideEditorOutcome({ ...base, seed: "", raw: "" });
    expect(out.apply).toBe(false);
    expect(out.notice).toBe(NOTICE.noChanges);
  });

  test("an EMPTY seed filled in APPLIES (the /editor path)", () => {
    const out = decideEditorOutcome({ ...base, seed: "", raw: "typed in the editor\n" });
    expect(out.apply).toBe(true);
    expect(out.text).toBe("typed in the editor");
  });

  test("a NON-ZERO exit KEEPS — vim's :cq is a deliberate cancel, not an error", () => {
    const out = decideEditorOutcome({ ...base, raw: "totally different", exitCode: 1 });
    expect(out.apply).toBe(false);
    expect(out.text).toBeNull();
    expect(out.notice).toBe(NOTICE.cancelled);
    expect(out.isError).toBe(false);
  });

  test("a non-zero exit outranks changed content — the abort wins", () => {
    expect(decideEditorOutcome({ ...base, raw: "new text", exitCode: 130 }).apply).toBe(false);
  });

  test("a spawn error (ENOENT) KEEPS and flags isError", () => {
    const out = decideEditorOutcome({
      ...base,
      raw: null,
      exitCode: null,
      spawnError: "ENOENT: no such file or directory, posix_spawn 'nope'",
    });
    expect(out.apply).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.notice).toContain("ENOENT");
  });

  test("a spawn error outranks the exit code", () => {
    const out = decideEditorOutcome({ ...base, exitCode: 0, spawnError: "boom" });
    expect(out.notice).toBe("editor: boom");
    expect(out.isError).toBe(true);
  });

  test("an unreadable file KEEPS and flags isError", () => {
    const out = decideEditorOutcome({ ...base, raw: null });
    expect(out.apply).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.notice).toBe(NOTICE.unreadable);
  });
});

describe("the GUI wait-flag hint", () => {
  test("fires when the editor exits fast AND changed nothing", () => {
    const out = decideEditorOutcome({ ...base, raw: "hello", elapsedMs: GUI_EDITOR_MS - 1 });
    expect(out.notice).toBe(NOTICE.guiHint);
    expect(out.notice).toContain("--wait");
  });

  test("does NOT fire when a fast exit actually changed the text", () => {
    const out = decideEditorOutcome({ ...base, raw: "changed", elapsedMs: 10 });
    expect(out.apply).toBe(true);
    expect(out.notice).toBe(NOTICE.applied);
  });

  test("does NOT fire for a slow unchanged edit — that is a real 'no changes'", () => {
    const out = decideEditorOutcome({ ...base, raw: "hello", elapsedMs: GUI_EDITOR_MS });
    expect(out.notice).toBe(NOTICE.noChanges);
  });
});

describe("normalizeEditedText", () => {
  test("CRLF becomes LF", () => {
    expect(normalizeEditedText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  test("a lone CR (classic Mac) becomes LF", () => {
    expect(normalizeEditedText("a\rb")).toBe("a\nb");
  });

  test("a UTF-8 BOM is stripped", () => {
    expect(normalizeEditedText("﻿hello")).toBe("hello");
    expect(normalizeEditedText("﻿hello").charCodeAt(0)).toBe(104);
  });

  test("trailing newlines are stripped — every editor adds one", () => {
    expect(normalizeEditedText("body\n")).toBe("body");
    expect(normalizeEditedText("body\n\n\n")).toBe("body");
    expect(normalizeEditedText("body\r\n\r\n")).toBe("body");
  });

  test("INTERIOR blank lines are preserved (paragraphs survive)", () => {
    expect(normalizeEditedText("para one\n\npara two\n")).toBe("para one\n\npara two");
  });

  test("leading blank lines and interior whitespace are untouched", () => {
    expect(normalizeEditedText("\n  indented\ttab\n")).toBe("\n  indented\ttab");
  });

  test("a file of only newlines normalizes to empty (the 'emptied' path)", () => {
    expect(normalizeEditedText("\n\n\n")).toBe("");
  });

  test("a BOM-only file normalizes to empty", () => {
    expect(normalizeEditedText("﻿")).toBe("");
  });
});
