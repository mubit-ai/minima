/**
 * Conversation rendering for the TUI — user prompts, assistant replies (incl. live
 * streaming text), and terse tool-call lines.
 */

import { Box, Text } from "ink";
import type React from "react";
import { type ChatMessage, type Turn, groupMessagesIntoTurns } from "./layout.ts";

// Re-exported so existing importers (app.tsx) keep a single import site; the definitions and the
// pure grouping logic now live in the React/Ink-free layout module (also unit-tested there).
export { type ChatMessage, type Turn, groupMessagesIntoTurns };

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

export function Messages({
  messages,
  streaming,
  streamingThoughts,
}: {
  messages: ChatMessage[];
  streaming: string;
  streamingThoughts?: string;
}) {
  const turns = groupMessagesIntoTurns(messages);

  return (
    // No flexGrow: the parent chat region is bottom-aligned (justifyContent="flex-end") and clips
    // overflow, so this must be content-sized (not stretched) for the newest turn to sit at the fold.
    <Box flexDirection="column">
      {turns.map((turn, i) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: grouping stable lists
          key={i}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          width="100%"
        >
          {/* User Section */}
          {turn.user.text ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="green">{"▸ you"}</Text>
              <Text backgroundColor="#2a2a35" color="white">
                {` ${turn.user.text} `}
              </Text>
            </Box>
          ) : null}

          {/* Subsequent tool calls and assistant answers */}
          {turn.subsequent.map((sub, sIdx) => {
            if (sub.role === "tool") {
              return (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: grouping stable lists
                  key={sIdx}
                  flexDirection="column"
                  marginY={0}
                >
                  <Text color={sub.isError ? "red" : "yellow"}>
                    {`  ⚙ ${sub.toolName ?? "tool"}:`}
                  </Text>
                  <Text color={sub.isError ? "red" : "white"}>{sub.text}</Text>
                </Box>
              );
            }

            if (sub.role === "thinking") {
              return (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: grouping stable lists
                  key={sIdx}
                  flexDirection="column"
                  marginTop={1}
                  marginBottom={1}
                  paddingLeft={2}
                  borderStyle="single"
                  borderColor="gray"
                >
                  <Text color="gray" italic>
                    {`💭 thought for ${sub.thoughtDurationSecs?.toFixed(1) ?? "0.0"}s`}
                  </Text>
                  <Text color="gray" italic>
                    {sub.text}
                  </Text>
                </Box>
              );
            }

            return (
              <Box
                // biome-ignore lint/suspicious/noArrayIndexKey: grouping stable lists
                key={sIdx}
                flexDirection="column"
                marginTop={1}
                marginBottom={1}
              >
                <Text color="magenta">{"◆ assistant"}</Text>
                <MarkdownRenderer text={sub.text} />
              </Box>
            );
          })}
        </Box>
      ))}

      {/* Streaming Active Thoughts */}
      {streamingThoughts ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={0} width="100%">
          <Box flexDirection="column">
            <Text color="cyan">{"💭 thinking..."}</Text>
            <Text color="gray" wrap="truncate">
              {streamingThoughts.slice(-300)}
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* Streaming Active Turn */}
      {streaming ? (
        <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1} width="100%">
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text color="magenta">{"◆ assistant"}</Text>
            <MarkdownRenderer text={streaming} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
