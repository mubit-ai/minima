/**
 * Theme picker overlay — ↑/↓ previews live (the whole UI restyles as the cursor moves),
 * ⏎ keeps the highlighted theme, Esc restores the one that was active on open.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { THEMES, THEME_NAMES, t } from "./theme.ts";

export interface ThemePickerProps {
  currentName: string;
  onPreview: (name: string) => void;
  onPick: (name: string) => void;
  onDismiss: () => void;
}

export function ThemePicker({ currentName, onPreview, onPick, onDismiss }: ThemePickerProps) {
  const [cursor, setCursor] = useState(Math.max(0, THEME_NAMES.indexOf(currentName)));
  const [closed, setClosed] = useState(false);

  const move = (delta: number) => {
    const next = (cursor + delta + THEME_NAMES.length) % THEME_NAMES.length;
    setCursor(next);
    onPreview(THEME_NAMES[next]!);
  };

  useInput((_input, key) => {
    if (closed) return;
    if (key.escape) {
      setClosed(true);
      return onDismiss();
    }
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return) {
      setClosed(true);
      return onPick(THEME_NAMES[cursor]!);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={t.plan}>
        {" theme "}
      </Text>
      {THEME_NAMES.map((name, i) => {
        const p = THEMES[name]!;
        return (
          <Text key={name} color={i === cursor ? t.accent : undefined}>
            {i === cursor ? "❯ " : "  "}
            {name.padEnd(8)}
            <Text color={p.accent}>{" ●"}</Text>
            <Text color={p.plan}>{"●"}</Text>
            <Text color={p.warn}>{"●"}</Text>
            <Text color={p.success}>{"●"}</Text>
            <Text color={p.error}>{"●"}</Text>
            {name === currentName ? <Text color={t.success}> ✓</Text> : null}
          </Text>
        );
      })}
      <Text color={t.dim}>{"↑/↓ preview · ⏎ keep · Esc revert"}</Text>
    </Box>
  );
}
