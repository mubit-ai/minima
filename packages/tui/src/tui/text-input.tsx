/**
 * The prompt input built on Ink's useInput (no ink-text-input dep, keeping the package lean).
 *
 * A draft is { value, cursor }: printable keys insert at the cursor, ←/→ move it, and the
 * readline core works — Ctrl+A (line start), Ctrl+U (kill to start), Ctrl+K (kill to end),
 * Ctrl+W (kill word back). Ctrl+E stays an app-level binding (thinking cycle), and other
 * Ctrl/Meta combos fall through to the app handlers.
 *
 * Paste lands here on two paths, both inserting at the cursor WITHOUT submitting:
 *  - bracketed paste (the terminal's Cmd+V): captured whole by input-filter.ts and delivered
 *    via setPasteCallback — embedded newlines and ESC bytes are data, never keypresses;
 *  - Ctrl+V: reads the system clipboard directly (pbpaste / wl-paste / xclip).
 * Multi-line drafts render as-is; the box grows via the app's wrappedLineCount reserve.
 */

import { Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { readClipboard } from "./clipboard.ts";
import { setPasteCallback } from "./input-filter.ts";

export interface TextInputProps {
  /** Called when the user hits Enter with a non-empty line. */
  onSubmit: (value: string) => void;
  onChange?: (value: string) => void;
  onTab?: (value: string) => string | undefined;
  onShiftTab?: () => void;
  onUp?: (value: string) => string | undefined;
  onDown?: (value: string) => string | undefined;
  placeholder?: string;
  disabled?: boolean;
  /**
   * U2: an overlay (ToC sidebar) owns the keyboard — stop consuming input but STAY
   * MOUNTED, so the in-progress draft (internal state) survives. Unmounting would
   * lose it; `disabled` alone changes the rendered text to "(busy…)".
   */
  suspended?: boolean;
  /** Shown instead of the value while disabled (defaults to "(busy…)"); renders as one truncated row. */
  disabledLabel?: string;
  showPrefix?: boolean;
}

interface Draft {
  value: string;
  cursor: number; // code-unit offset into value, 0..value.length
}

/** Start of the word before `cursor` (readline Ctrl+W semantics: skip spaces, then the word). */
function wordStartBefore(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && value[i - 1] === " ") i--;
  while (i > 0 && value[i - 1] !== " ") i--;
  return i;
}

export function TextInput({
  onSubmit,
  onChange,
  onTab,
  onShiftTab,
  onUp,
  onDown,
  placeholder,
  disabled,
  suspended,
  disabledLabel,
  showPrefix = true,
}: TextInputProps) {
  // The REF is the source of truth; state only triggers re-render. Ink dispatches every
  // keypress of one stdin chunk synchronously (no re-render in between), so a handler that
  // reads draft from the render closure would apply N same-chunk keypresses to the SAME
  // stale snapshot — two ←← would move the cursor once. Mutations go through the ref
  // immediately; the state copy just mirrors it for the next paint.
  const draftRef = useRef<Draft>({ value: "", cursor: 0 });
  const [, setPaintGen] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const update = useCallback((value: string, cursor: number) => {
    draftRef.current = { value, cursor: Math.max(0, Math.min(cursor, value.length)) };
    onChangeRef.current?.(value);
    setPaintGen((n) => n + 1);
  }, []);

  const insertAt = useCallback(
    (text: string) => {
      const d = draftRef.current;
      update(d.value.slice(0, d.cursor) + text + d.value.slice(d.cursor), d.cursor + text.length);
    },
    [update],
  );

  // Bracketed pastes (input-filter.ts) insert into the draft — never submit, never leak
  // keypresses. Registered while this input could receive text; the ToC overlay keeps the
  // input mounted+suspended, and a paste landing in the draft then is still the right home.
  const acceptPaste = !disabled;
  useEffect(() => {
    if (!acceptPaste) return;
    setPasteCallback((text) => insertAt(text.replace(/\r\n?/g, "\n")));
    return () => setPasteCallback(null);
  }, [acceptPaste, insertAt]);

  useInput((input, key) => {
    if (disabled || suspended) return;
    const { value, cursor } = draftRef.current;
    // key.return fires for '\r' (standard interactive path).
    // The ICRNL PTY path: '\r' is translated to '\n' on the slave, and may arrive
    // batched with preceding text (e.g. "hello\n"). Strip the trailing '\n' and
    // include the preceding text in the submitted value. (A PASTED trailing newline
    // no longer lands here — bracketed paste captures it as data.)
    const endsWithLF = !key.return && input.length > 0 && input[input.length - 1] === "\n";
    if (key.return || endsWithLF) {
      const extra = endsWithLF ? input.slice(0, -1) : "";
      const trimmed = (value + extra).trim();
      if (trimmed) {
        onSubmit(trimmed);
        update("", 0);
      }
      return;
    }
    if (key.upArrow) {
      const recalled = onUp?.(value);
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.downArrow) {
      const recalled = onDown?.(value);
      if (recalled !== undefined) update(recalled, recalled.length);
      return;
    }
    if (key.leftArrow) {
      update(value, cursor - 1);
      return;
    }
    if (key.rightArrow) {
      update(value, cursor + 1);
      return;
    }
    if (key.tab) {
      if (key.shift) {
        onShiftTab?.();
      } else {
        const completed = onTab?.(value);
        if (completed !== undefined) update(completed, completed.length);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) update(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl) {
      // The readline core. Ctrl+E (end-of-line in readline) is deliberately NOT bound —
      // it cycles thinking at the app level (B2). Unhandled combos stay app-level too.
      if (input === "a") update(value, 0);
      else if (input === "u") update(value.slice(cursor), 0);
      else if (input === "k") update(value.slice(0, cursor), cursor);
      else if (input === "w") {
        const start = wordStartBefore(value, cursor);
        update(value.slice(0, start) + value.slice(cursor), start);
      } else if (input === "v") {
        const clip = readClipboard();
        if (clip) insertAt(clip.replace(/\r\n?/g, "\n"));
      }
      return;
    }
    if (key.meta) return;
    if (input && !key.escape) {
      insertAt(input);
    }
  });

  const { value, cursor } = draftRef.current;
  if (disabled) {
    return (
      <Text wrap="truncate">
        {showPrefix && <Text color="cyan">{"›"}</Text>} {disabledLabel ?? "(busy…)"}
      </Text>
    );
  }
  // Cursor block: inverse of the char under it (a space at end-of-line). Rendering the
  // draft in three spans keeps multi-line pastes visible as-is.
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? "▋";
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {showPrefix && <Text color="cyan">{"›"}</Text>} {before}
      {value[cursor] !== undefined ? <Text inverse>{at}</Text> : <Text color="gray">{"▋"}</Text>}
      {after}
      {!value && placeholder ? <Text color="gray"> {placeholder}</Text> : null}
    </Text>
  );
}
