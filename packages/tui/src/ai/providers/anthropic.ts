/**
 * Anthropic Messages API provider — wraps the @anthropic-ai/sdk async stream.
 *
 * Port of minima_harness/ai/providers/anthropic.py. Maps the SDK's raw stream events
 * onto PI's event taxonomy and assembles the final AssistantMessage with realized
 * token usage (input from message_start, output from message_delta). Accepts an
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
  toolCallDelta,
  toolCallEnd,
  toolCallStart,
} from "../events.ts";
import {
  AssistantMessage,
  type Context,
  type Message,
  type Model,
  text,
  thinking,
  toolCall,
} from "../types.ts";
import { attachCost } from "../usage.ts";
import { resolveApiKey, toJsonSchema } from "./_common.ts";

const STOP_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "toolUse",
};

const EPHEMERAL = { type: "ephemeral" };

/** Minimal client shape this provider consumes; the real SDK client satisfies it. */
export interface AnthropicClientLike {
  messages: {
    stream(opts: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent>;
  };
}
export interface AnthropicStreamEvent {
  type: string;
  [k: string]: unknown;
}

export interface AnthropicProviderOptions {
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class AnthropicProvider {
  readonly apiId = "anthropic-messages";
  constructor(private readonly client?: AnthropicClientLike) {}

  async *stream(
    model: Model,
    context: Context,
    opts: AnthropicProviderOptions = {},
  ): AsyncIterable<StreamEvent> {
    const options = (opts.options ?? {}) as Record<string, unknown>;
    const client = this.client ?? (await buildClient(options));
    const kwargs = buildKwargs(model, context, options);
    const assistant = new AssistantMessage({ content: [], model: model.id, stop_reason: "stop" });
    const textBuf = new Map<number, string[]>();
    const thinkBuf = new Map<number, string[]>();
    const sigBuf = new Map<number, string[]>();
    const toolsAcc = new Map<number, { id: string; name: string; args: string }>();
    let inTokens = 0;
    let outTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    yield startEv(assistant);
    try {
      const s = client.messages.stream(kwargs);
      for await (const ev of s) {
        const etype = ev.type;
        if (etype === "message_start") {
          const usage = (ev as { message?: { usage?: Record<string, number> } }).message?.usage;
          if (usage) {
            inTokens = usage.input_tokens ?? 0;
            cacheRead = usage.cache_read_input_tokens ?? 0;
            cacheWrite = usage.cache_creation_input_tokens ?? 0;
          }
        } else if (etype === "content_block_start") {
          const idx = (ev.index as number) ?? 0;
          const block = (ev.content_block as { type?: string; id?: string; name?: string }) ?? {};
          const btype = block.type ?? "";
          if (btype === "text") yield textStart(idx);
          else if (btype === "thinking") yield thinkingStart(idx);
          else if (btype === "tool_use") {
            toolsAcc.set(idx, { id: block.id || `call_${idx}`, name: block.name ?? "", args: "" });
            yield toolCallStart(idx);
          }
        } else if (etype === "content_block_delta") {
          const idx = (ev.index as number) ?? 0;
          const delta =
            (ev.delta as {
              type?: string;
              text?: string;
              thinking?: string;
              signature?: string;
              partial_json?: string;
            }) ?? {};
          const dtype = delta.type ?? "";
          if (dtype === "text_delta") {
            const t = delta.text ?? "";
            (textBuf.get(idx) ?? textBuf.set(idx, []).get(idx))!.push(t);
            yield textDelta(t, idx);
          } else if (dtype === "thinking_delta") {
            const t = delta.thinking ?? "";
            (thinkBuf.get(idx) ?? thinkBuf.set(idx, []).get(idx))!.push(t);
            yield thinkingDelta(t, idx);
          } else if (dtype === "signature_delta") {
            (sigBuf.get(idx) ?? sigBuf.set(idx, []).get(idx))!.push(delta.signature ?? "");
          } else if (dtype === "input_json_delta") {
            const partial = delta.partial_json ?? "";
            toolsAcc.get(idx)!.args += partial;
            yield toolCallDelta(partial, idx);
          }
        } else if (etype === "content_block_stop") {
          const idx = (ev.index as number) ?? 0;
          if (toolsAcc.has(idx)) {
            const slot = toolsAcc.get(idx)!;
            let args: Record<string, unknown>;
            try {
              args = slot.args.trim() ? JSON.parse(slot.args) : {};
            } catch {
              args = { _raw: slot.args };
            }
            const call = toolCall(slot.id, slot.name, args);
            assistant.content.push(call);
            yield toolCallEnd(call, idx);
          } else if (thinkBuf.has(idx)) {
            const t = (thinkBuf.get(idx) ?? []).join("");
            const signature = (sigBuf.get(idx) ?? []).join("");
            assistant.content.push(thinking(t, signature));
            yield thinkingEnd(t, idx);
          } else if (textBuf.has(idx)) {
            const t = (textBuf.get(idx) ?? []).join("");
            assistant.content.push(text(t));
            yield textEnd(t, idx);
          }
        } else if (etype === "message_delta") {
          const delta = (ev.delta as { stop_reason?: string }) ?? {};
          if (delta.stop_reason) {
            assistant.stop_reason = (STOP_MAP[delta.stop_reason] ??
              "stop") as AssistantMessage["stop_reason"];
          }
          const usage = ev.usage as { output_tokens?: number } | undefined;
          if (usage) outTokens = usage.output_tokens ?? 0;
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

    if (!assistant.content.length) assistant.content.push(text(""));
    assistant.usage.input = inTokens;
    assistant.usage.output = outTokens;
    assistant.usage.cache_read = cacheRead;
    assistant.usage.cache_write = cacheWrite;
    attachCost(model, assistant.usage);
    yield doneEv(assistant.stop_reason, assistant);
  }
}

async function buildClient(options: Record<string, unknown>): Promise<AnthropicClientLike> {
  const apiKey = resolveApiKey(options, "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: (options.timeout as number) ?? 60 });
  // The SDK's messages.stream() returns a MessageStream (async iterable); cast to our shape.
  return client as unknown as AnthropicClientLike;
}

function buildKwargs(
  model: Model,
  context: Context,
  options: Record<string, unknown>,
): Record<string, unknown> {
  // Prompt caching ON by default — the agent re-sends the stable prefix every turn.
  const cache = options.prompt_cache !== false;
  const messages = normalizeForTarget(context.messages, "anthropic-messages");
  const wire = messages.map(toWire);
  const kwargs: Record<string, unknown> = {
    model: model.id,
    max_tokens: options.max_tokens ?? model.max_tokens,
    messages: wire,
  };
  if (context.system_prompt) {
    kwargs.system = cache
      ? [{ type: "text", text: context.system_prompt, cache_control: EPHEMERAL }]
      : context.system_prompt;
  }
  if (context.tools.length) {
    const tools: Record<string, unknown>[] = context.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toJsonSchema(t.parameters),
    }));
    if (cache) tools[tools.length - 1] = { ...tools[tools.length - 1]!, cache_control: EPHEMERAL };
    kwargs.tools = tools;
  }
  if (cache && wire.length) markLastBlock(wire[wire.length - 1] as Record<string, unknown>);
  if (options.thinking && model.reasoning) {
    kwargs.thinking = { type: "enabled", budget_tokens: Number(options.thinking_budget ?? 1024) };
  }
  return kwargs;
}

function markLastBlock(wireMsg: Record<string, unknown>): void {
  const content = wireMsg.content;
  if (Array.isArray(content) && content.length && typeof content[content.length - 1] === "object") {
    content[content.length - 1] = {
      ...(content[content.length - 1] as object),
      cache_control: EPHEMERAL,
    };
  }
}

function toWire(m: Message): Record<string, unknown> {
  if (m.role === "toolResult") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: flattenText(m),
          is_error: m.is_error,
        },
      ],
    };
  }
  const content: Record<string, unknown>[] = [];
  for (const b of m.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "image")
      content.push({
        type: "image",
        source: { type: "base64", media_type: b.mime_type ?? "image/png", data: b.data },
      });
    else if (b.type === "thinking") {
      // Only replay signed thinking (Anthropic 400s on a missing signature).
      if (b.signature)
        content.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "toolCall")
      content.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
  }
  return { role: m.role, content };
}

function flattenText(m: Message): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
