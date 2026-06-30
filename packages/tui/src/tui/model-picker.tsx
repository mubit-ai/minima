/**
 * Model picker overlay — port of the Python tui/overlays.py ModelPicker (focused).
 *
 * Lists the registered harness models; pick with ↑/↓ + Enter (or a number key), pin with
 * P, dismiss with Esc. Pinning sets MinimaAgent.config.pinned so routing is bypassed and
 * the chosen model runs directly.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { Model } from "../ai/types.ts";

export interface ModelPickerProps {
  models: Model[];
  currentId: string;
  onPick: (model: Model, pinned: boolean) => void;
  onDismiss: () => void;
}

export function ModelPicker({ models, currentId, onPick, onDismiss }: ModelPickerProps) {
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      models.findIndex((m) => m.id === currentId),
    ),
  );
  const [closed, setClosed] = useState(false);

  const safePick = (model: Model, pinned: boolean) => {
    if (closed) return;
    setClosed(true);
    onPick(model, pinned);
  };
  const safeDismiss = () => {
    if (closed) return;
    setClosed(true);
    onDismiss();
  };

  useInput((input, key) => {
    if (key.escape) return safeDismiss();
    if (models.length === 0) return;
    if (key.upArrow) return setCursor((c) => (c - 1 + models.length) % models.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % models.length);
    if (key.return) return safePick(models[cursor]!, false);
    if (input === "p" || input === "P") return safePick(models[cursor]!, true);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= models.length) return safePick(models[n - 1]!, false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="magenta">
        {" model "}
      </Text>
      {models.slice(0, 20).map((m, i) => (
        <Text key={m.id} color={i === cursor ? "cyan" : undefined}>
          {i === cursor ? "❯" : " "} {i < 9 ? `${i + 1} ` : "  "}
          {m.name} <Text color="gray">{`(${m.provider}/${m.id})`}</Text>
          {m.id === currentId ? <Text color="green"> ✓</Text> : null}
        </Text>
      ))}
      <Text color="gray">{"↑/↓ select · ⏎ run · P pin · Esc cancel"}</Text>
    </Box>
  );
}
