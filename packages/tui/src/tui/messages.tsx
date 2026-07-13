/**
 * Conversation rendering for the TUI.
 *
 * The finalized transcript is rendered via Ink's <Static> (see app.tsx): each message is an
 * independent, append-only item printed ONCE into the terminal's scrollback and never re-diffed.
 * That is what makes long transcripts render cleanly — Ink's cursor-relative diff only ever manages
 * the small live region (streaming reply + input + status), never content taller than the screen.
 * So this module exposes a per-MESSAGE row (not a per-turn box, which would have to grow and thus
 * couldn't be a stable Static item) plus the live streaming blocks.
 */

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import { type ChatMessage, clampToolText } from "./layout.ts";

// Re-exported so app.tsx keeps a single import site.
export type { ChatMessage };

function renderInlineMarkdown(text: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  const currentText = text;

  const regex = /(\*\*|`)/g;
  let match = regex.exec(currentText);
  let lastIndex = 0;
  let boldActive = false;
  let codeActive = false;

  while (match) {
    const tag = match[0];
    const index = match.index;

    if (index > lastIndex) {
      const segment = currentText.slice(lastIndex, index);
      tokens.push(
        <Text key={lastIndex} bold={boldActive} color={codeActive ? "cyan" : undefined}>
          {segment}
        </Text>,
      );
    }

    if (tag === "**") {
      boldActive = !boldActive;
    } else if (tag === "`") {
      codeActive = !codeActive;
    }

    lastIndex = index + tag.length;
    match = regex.exec(currentText);
  }

  if (lastIndex < currentText.length) {
    const segment = currentText.slice(lastIndex);
    tokens.push(
      <Text key={lastIndex} bold={boldActive} color={codeActive ? "cyan" : undefined}>
        {segment}
      </Text>,
    );
  }

  return <>{tokens}</>;
}

export function MarkdownRenderer({ text }: { text: string }) {
  const lines = text.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => {
        const trimmed = line.trim();

        // Header 1-6
        if (trimmed.startsWith("#")) {
          const depth = (trimmed.match(/^#+/) || [""])[0].length;
          const headerText = trimmed.slice(depth).trim();

          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
              marginTop={1}
              marginBottom={0}
            >
              <Text bold color="cyan">
                {headerText}
              </Text>
            </Box>
          );
        }

        // List item with bullet point or hyphen
        if (trimmed.startsWith("-") || trimmed.startsWith("* ")) {
          const bullet = trimmed.startsWith("-") ? "-" : "•";
          const body = trimmed.slice(1).trim();
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
              key={idx}
              marginLeft={2}
              flexDirection="row"
            >
              <Text color="yellow">{`${bullet} `}</Text>
              <Text>{renderInlineMarkdown(body)}</Text>
            </Box>
          );
        }

        // Regular line
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of text are stable
            key={idx}
          >
            <Text>{renderInlineMarkdown(line)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * One finalized message, rendered inline (no per-turn box). Used as a <Static> item — printed once
 * into scrollback. A `marginTop` gives visual separation between messages.
 */
function MessageRowImpl({ msg, cols }: { msg: ChatMessage; cols: number }) {
  if (msg.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="green">{"▸ you"}</Text>
        <Text backgroundColor="#2a2a35" color="white">
          {` ${msg.text} `}
        </Text>
      </Box>
    );
  }

  if (msg.role === "tool") {
    const { text: body, hiddenLines } = clampToolText(msg.text, cols);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={msg.isError ? "red" : "yellow"}>{`  ⚙ ${msg.toolName ?? "tool"}:`}</Text>
        {/* default fg (no hardcoded white — invisible on light themes); body is clipped */}
        <Text color={msg.isError ? "red" : undefined}>{body}</Text>
        {hiddenLines > 0 && <Text color="gray">{`  … +${hiddenLines} more lines`}</Text>}
      </Box>
    );
  }

  if (msg.role === "thinking") {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        paddingLeft={2}
        borderStyle="single"
        borderColor="gray"
      >
        <Text color="gray" italic>
          {`🧠 reasoning (${msg.thoughtDurationSecs?.toFixed(1) ?? "0.0"}s)`}
        </Text>
        <Text color="gray" italic>
          {msg.text}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta">{"◆ assistant"}</Text>
      <MarkdownRenderer text={msg.text} />
    </Box>
  );
}

/**
 * Memoized: message objects are immutable (append/replace-only transcript), so identity equality
 * on `msg` + `cols` skips re-tokenizing markdown for every unchanged row on every render — the
 * fullscreen viewport re-renders its whole window on each commit otherwise.
 */
export const MessageRow = memo(MessageRowImpl);

/** The live streaming assistant reply (dynamic region; finalizes into a MessageRow when done). */
export function StreamingReply({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta">{"◆ assistant"}</Text>
      <MarkdownRenderer text={text} />
    </Box>
  );
}

/** The live reasoning peek (dynamic region); truncated so it never grows past a couple of rows. */
export function StreamingThoughts({ text }: { text: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} width="100%">
      <Box flexDirection="column">
        <Text color="cyan">{"🧠 reasoning..."}</Text>
        <Text color="gray" wrap="truncate">
          {text.slice(-300)}
        </Text>
      </Box>
    </Box>
  );
}
