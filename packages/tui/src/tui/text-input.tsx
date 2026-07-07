/**
 * A minimal single-line text input built on Ink's useInput (no ink-text-input dep,
 * keeping the package lean). Handles printable chars, backspace/delete, and Enter.
 */

import { Text, useInput } from "ink";
import React, { useState } from "react";

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
  showPrefix?: boolean;
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
  showPrefix = true,
}: TextInputProps) {
  const [value, setValue] = useState("");

  const updateValue = (newValue: string) => {
    setValue(newValue);
    if (onChange) {
      onChange(newValue);
    }
  };

  useInput((input, key) => {
    if (disabled) return;
    // key.return fires for '\r' (standard interactive path).
    // The ICRNL PTY path: '\r' is translated to '\n' on the slave, and may arrive
    // batched with preceding text (e.g. "hello\n"). Strip the trailing '\n' and
    // include the preceding text in the submitted value.
    const endsWithLF = !key.return && input.length > 0 && input[input.length - 1] === "\n";
    if (key.return || endsWithLF) {
      const extra = endsWithLF ? input.slice(0, -1) : "";
      const trimmed = (value + extra).trim();
      if (trimmed) {
        onSubmit(trimmed);
        updateValue("");
      }
      return;
    }
    if (key.upArrow) {
      if (onUp) {
        const recalled = onUp(value);
        if (recalled !== undefined) {
          updateValue(recalled);
        }
      }
      return;
    }
    if (key.downArrow) {
      if (onDown) {
        const recalled = onDown(value);
        if (recalled !== undefined) {
          updateValue(recalled);
        }
      }
      return;
    }
    if (key.tab) {
      if (key.shift) {
        if (onShiftTab) {
          onShiftTab();
        }
      } else {
        if (onTab) {
          const completed = onTab(value);
          if (completed !== undefined) {
            updateValue(completed);
          }
        }
      }
      return;
    }
    if (key.backspace || key.delete) {
      updateValue(value.slice(0, -1));
      return;
    }
    // Ctrl/Meta combos are handled at the app level (quit, abort, etc.).
    if (key.ctrl || key.meta) return;
    if (input && !key.escape) {
      updateValue(value + input);
    }
  });

  const shown = disabled ? "(busy…)" : value;
  return (
    <Text>
      {showPrefix && <Text color="cyan">{"›"}</Text>} {shown}
      {!disabled && <Text color="gray">{"▋"}</Text>}
      {!value && !disabled && placeholder ? <Text color="gray"> {placeholder}</Text> : null}
    </Text>
  );
}
