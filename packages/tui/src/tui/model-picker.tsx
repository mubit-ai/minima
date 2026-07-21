/**
 * Model picker overlay — scrollable + filterable.
 *
 * The registry can hold hundreds of models (OpenRouter + Minima catalog), so this is a
 * type-to-filter list over a scrolling viewport: type to narrow (matches name/provider/id,
 * space-separated AND tokens), ↑/↓ to move, ⏎ to run ONCE (a one-turn pin — the pick
 * serves exactly the next prompt, then routing resumes), Tab to pin persistently (bypass
 * routing until unpinned), Esc to cancel.
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

const WINDOW = 12; // visible rows

/**
 * Max rows the picker can occupy — the anchor ledger's reservation for it (colocated with
 * WINDOW so the pin can't drift): border(2) + title(1) + filter(1) + ↑marker(1) + rows(<=
 * WINDOW, >=1 for the no-match line) + ↓marker(1) + hint(1).
 */
export const MODEL_PICKER_MAX_ROWS = WINDOW + 7;

export function matches(model: Model, filter: string): boolean {
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = `${model.name} ${model.provider} ${model.id}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function ModelPicker({ models, currentId, onPick, onDismiss }: ModelPickerProps) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [closed, setClosed] = useState(false);

  const filtered = models.filter((m) => matches(m, filter));
  // Keep the cursor in range as the filter narrows/widens the list.
  const cur = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  const safePick = (model: Model | undefined, pinned: boolean) => {
    if (closed || !model) return;
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
    if (key.upArrow) return setCursor(() => Math.max(0, cur - 1));
    if (key.downArrow) return setCursor(() => Math.min(filtered.length - 1, cur + 1));
    if (key.return) return safePick(filtered[cur], false);
    if (key.tab) return safePick(filtered[cur], true);
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setCursor(0);
      return;
    }
    // Printable character → extend the filter (ignore control/meta chords).
    if (input && input.length === 1 && !key.ctrl && !key.meta && input >= " ") {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  // Scroll so the cursor stays visible.
  const start = Math.max(
    0,
    Math.min(cur - Math.floor(WINDOW / 2), Math.max(0, filtered.length - WINDOW)),
  );
  const view = filtered.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="magenta">
        {" model "}
      </Text>
      <Text color="gray">
        {"filter: "}
        <Text color="white">{filter || " "}</Text>
        <Text color="gray">{`  (${filtered.length}/${models.length})`}</Text>
      </Text>
      {start > 0 ? <Text color="gray">{`  ↑ ${start} more`}</Text> : null}
      {view.length === 0 ? (
        <Text color="gray">{"  (no models match)"}</Text>
      ) : (
        view.map((m, i) => {
          const idx = start + i;
          return (
            <Text key={`${m.provider}:${m.id}`} color={idx === cur ? "cyan" : undefined}>
              {idx === cur ? "❯ " : "  "}
              {m.name} <Text color="gray">{`(${m.provider}/${m.id})`}</Text>
              {m.id === currentId ? <Text color="green"> ✓</Text> : null}
            </Text>
          );
        })
      )}
      {start + WINDOW < filtered.length ? (
        <Text color="gray">{`  ↓ ${filtered.length - start - WINDOW} more`}</Text>
      ) : null}
      <Text color="gray">{"↑/↓ select · ⏎ run once · Tab pin · type to filter · Esc cancel"}</Text>
    </Box>
  );
}
