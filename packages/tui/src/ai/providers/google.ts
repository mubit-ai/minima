/**
 * Google Generative AI (Gemini) provider via @google/genai.
 *
 * Port of minima_harness/ai/providers/google.py. Iterates generateContentStream chunks,
 * mapping incremental text/thought/function-call parts onto PI's event taxonomy. Gemini
 * does not stream function-call arguments incrementally, so a full toolcall_end is emitted
 * when a function_call part arrives (matches PI's documented behaviour). Accepts an
 * injected client for hermetic tests.
 */

import { errText } from "../../errtext.ts";
import { normalizeForTarget } from "../compat.ts";
import {
  type StreamEvent,
  done as doneEv,
  error as errorEv,
  start as startEv,
  textDelta,
  textEnd,
  textStart,
  thinkingDelta,
  thinkingEnd,
  thinkingStart,
  toolCallEnd,
  toolCallStart,
} from "../events.ts";
import {
  AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ToolSchema,
  text,
  thinking,
  toolCall,
} from "../types.ts";
import { attachCost } from "../usage.ts";
import { resolveApiKey, toJsonSchema } from "./_common.ts";

const FINISH_MAP: Record<string, string> = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "stop" };

export interface GooglePart {
  thought?: boolean;
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  // snake_case fallback for raw API responses
  function_call?: { name?: string; args?: Record<string, unknown> };
}
export interface GoogleChunk {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  usage_metadata?: {
    prompt_token_count?: number;
    candidates_token_count?: number;
    thoughts_token_count?: number;
    cached_content_token_count?: number;
  };
  candidates?: {
    finishReason?: string;
    finish_reason?: string;
    content?: { parts?: GooglePart[] };
  }[];
}
export interface GoogleClientLike {
  models: {
    generateContentStream(opts: Record<string, unknown>): Promise<AsyncIterable<GoogleChunk>>;
  };
}

export class GoogleProvider {
  readonly apiId = "google-generative-ai";
  constructor(private readonly client?: GoogleClientLike) {}

  async *stream(
    model: Model,
    context: Context,
    opts: { options?: Record<string, unknown>; signal?: AbortSignal } = {},
  ): AsyncIterable<StreamEvent> {
    const options = (opts.options ?? {}) as Record<string, unknown>;
    const client = this.client ?? (await buildClient(options));
    const config = buildConfig(model, context, options);

    const textBuf: string[] = [];
    const thinkBuf: string[] = [];
    const toolCalls: ReturnType<typeof toolCall>[] = [];
    let seenText = false;
    let seenThink = false;
    let inTokens = 0;
    let outTokens = 0;
    let thoughtTokens = 0;
    let cacheRead = 0;
    let stopReason = "stop";

    const assistant = new AssistantMessage({ content: [], model: model.id, stop_reason: "stop" });
    yield startEv(assistant);

    try {
      const contents = toContents(context);
      const stream = await client.models.generateContentStream({
        model: model.id,
        contents,
        config,
      });
      for await (const chunk of stream) {
        const usage = chunk.usageMetadata ?? chunk.usage_metadata;
        if (usage) {
          inTokens =
            ((usage as Record<string, unknown>).promptTokenCount as number | undefined) ??
            ((usage as Record<string, unknown>).prompt_token_count as number | undefined) ??
            0;
          outTokens =
            ((usage as Record<string, unknown>).candidatesTokenCount as number | undefined) ??
            ((usage as Record<string, unknown>).candidates_token_count as number | undefined) ??
            0;
          thoughtTokens =
            ((usage as Record<string, unknown>).thoughtsTokenCount as number | undefined) ??
            ((usage as Record<string, unknown>).thoughts_token_count as number | undefined) ??
            0;
          cacheRead =
            ((usage as Record<string, unknown>).cachedContentTokenCount as number | undefined) ??
            ((usage as Record<string, unknown>).cached_content_token_count as number | undefined) ??
            0;
        }
        for (const cand of chunk.candidates ?? []) {
          const fr = cand.finishReason ?? cand.finish_reason;
          if (fr) stopReason = FINISH_MAP[fr] ?? "stop";
          for (const part of cand.content?.parts ?? []) {
            if (part.thought) {
              const t = part.text ?? "";
              if (t) {
                if (!seenThink) {
                  seenThink = true;
                  yield thinkingStart(0);
                }
                thinkBuf.push(t);
                yield thinkingDelta(t, 0);
              }
            } else if (part.functionCall ?? part.function_call) {
              const fc = part.functionCall ?? part.function_call!;
              const call = toolCall(`call_${toolCalls.length}`, fc.name ?? "", fc.args ?? {});
              toolCalls.push(call);
              const idx = toolCalls.length - 1;
              yield toolCallStart(idx);
              yield toolCallEnd(call, idx);
            } else if (part.text) {
              if (!seenText) {
                seenText = true;
                yield textStart(0);
              }
              textBuf.push(part.text);
              yield textDelta(part.text, 0);
            }
          }
        }
      }
    } catch (exc) {
      const err = new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: errText(exc),
      });
      err.model = model.id;
      yield errorEv("error", err);
      return;
    }

    // Assemble content in canonical order: thinking, text, tool calls.
    const blocks: AssistantMessage["content"] = [];
    if (seenThink) {
      const t = thinkBuf.join("");
      blocks.push(thinking(t));
      yield thinkingEnd(t, 0);
    }
    if (seenText) {
      const t = textBuf.join("");
      blocks.push(text(t));
      yield textEnd(t, 0);
    }
    blocks.push(...toolCalls);
    if (!blocks.length) blocks.push(text(""));
    if (toolCalls.length) stopReason = "toolUse";

    assistant.content = blocks;
    assistant.stop_reason = stopReason as AssistantMessage["stop_reason"];
    assistant.usage.input = inTokens;
    assistant.usage.output = outTokens + thoughtTokens;
    assistant.usage.cache_read = cacheRead;
    attachCost(model, assistant.usage);
    yield doneEv(assistant.stop_reason, assistant);
  }
}

async function buildClient(options: Record<string, unknown>): Promise<GoogleClientLike> {
  const apiKey = resolveApiKey(options, "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY");
  const { GoogleGenAI } = await import("@google/genai");
  const timeout = Math.round(Number(options.timeout ?? 60) * 1000);
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout } });
  return client as unknown as GoogleClientLike;
}

function buildConfig(
  model: Model,
  context: Context,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    maxOutputTokens: options.max_tokens ?? model.max_tokens,
  };
  if (context.system_prompt) config.systemInstruction = context.system_prompt;
  if (context.tools.length) {
    config.tools = [
      {
        functionDeclarations: context.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.parameters),
        })),
      },
    ];
  }
  if (options.thinking && model.reasoning) config.thinkingConfig = { includeThoughts: true };
  return config;
}

function toContents(context: Context): Record<string, unknown>[] {
  const messages = normalizeForTarget(context.messages, "google-generative-ai");
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [];
    if (m.role === "toolResult") {
      parts.push({
        functionResponse: { name: m.tool_name ?? "", response: { result: flattenText(m) } },
      });
    } else {
      for (const b of m.content) {
        if (b.type === "text") parts.push({ text: b.text });
        else if (b.type === "image")
          parts.push({ inlineData: { mimeType: b.mime_type ?? "image/png", data: b.data } });
        else if (b.type === "toolCall")
          parts.push({ functionCall: { name: b.name, args: b.arguments } });
      }
    }
    out.push({ role, parts });
  }
  return out;
}

function flattenText(m: Message): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

const TYPE_MAP: Record<string, string> = {
  string: "STRING",
  integer: "INTEGER",
  number: "NUMBER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY",
  null: "TYPE_UNSPECIFIED",
};

function toGeminiSchema(schema: ToolSchema): Record<string, unknown> {
  const raw = toJsonSchema(schema);
  return convertSchema(raw);
}

function convertSchema(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (node.type) {
    out.type = TYPE_MAP[node.type as string] ?? "TYPE_UNSPECIFIED";
  }
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;
  if (node.default !== undefined) out.default = node.default;
  if (node.required && Array.isArray(node.required)) out.required = node.required;
  if (node.properties && typeof node.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.properties)) {
      if (v && typeof v === "object") {
        props[k] = convertSchema(v as Record<string, unknown>);
      }
    }
    out.properties = props;
  }
  return out;
}
