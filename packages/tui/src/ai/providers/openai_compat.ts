/**
 * OpenAI-compatible Chat Completions provider (raw fetch, no `openai` SDK).
 *
 * Port of minima_harness/ai/providers/openai_compat.py. One implementation covers
 * openai, openrouter, groq, xai, deepseek, together, and any server speaking the
 * `POST {base_url}/chat/completions` SSE protocol — selected by Model.base_url.
 *
 * Streaming deltas carry: choices[0].delta.content (text), .tool_calls (function
 * calls assembled from partial JSON), and .reasoning_content / .reasoning (thinking
 * for deepseek/openrouter-style models). The final chunk carries usage when
 * stream_options.include_usage is honoured.
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
import { envVarsForProvider } from "../provider_catalog.ts";
import { quirksFor } from "../provider_quirks.ts";
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

const DEFAULT_BASE = "https://api.openai.com/v1";
const FINISH_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
};

/** Minimal Response shape the provider consumes; real fetch Responses satisfy this. */
export interface CompatResponse {
  status: number;
  ok: boolean;
  body?: ReadableStream<Uint8Array> | null;
}

/** Injectable transport for hermetic tests; defaults to global fetch. */
export type CompatFetch = (url: string, init: RequestInit) => Promise<CompatResponse>;

export interface OpenAICompatOptions {
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class OpenAICompatProvider {
  readonly apiId = "openai-completions";

  async *stream(
    model: Model,
    context: Context,
    opts: OpenAICompatOptions = {},
  ): AsyncIterable<StreamEvent> {
    const options = (opts.options ?? {}) as Record<string, unknown>;
    const apiKeys = [...envVarsForProvider(model.provider)];
    const apiKey = resolveApiKey(options, ...apiKeys);
    const base = (model.base_url ?? DEFAULT_BASE).replace(/\/+$/, "");
    const url = `${base}/chat/completions`;
    const payload = buildPayload(model, context, options);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    Object.assign(headers, model.headers ?? {});

    const injectedFetch = options.fetch as CompatFetch | undefined;
    const fetchImpl = injectedFetch ?? fetch;

    try {
      // Fail fast with an actionable message when a key-requiring provider has no key —
      // otherwise the request goes out unauthenticated and returns a cryptic HTTP 401. Only
      // guards the real network path; an injected fetch (proxy/test) supplies its own auth.
      if (!apiKey && apiKeys.length > 0 && !injectedFetch) {
        throw new Error(
          `no API key for provider "${model.provider}" — set ${apiKeys[0]} (e.g. \`minima config set ${apiKeys[0]} <key>\`). Note: \`minima auth\` configures routing only, not model-provider keys.`,
        );
      }
      const resp = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: opts.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`openai-compat request failed: HTTP ${resp.status}`);
      }
      yield* consumeSse(resp, model);
    } catch (exc) {
      const err = new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: errText(exc),
      });
      err.model = model.id;
      yield errorEv("error", err);
    }
  }
}

function buildPayload(
  model: Model,
  context: Context,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const messages = normalizeForTarget(context.messages, "openai-completions");
  const out: Record<string, unknown>[] = [];
  if (context.system_prompt) {
    out.push({ role: "system", content: context.system_prompt });
  }
  for (const m of messages) out.push(toWire(m));
  const maxTokens = options.max_tokens ?? model.max_tokens;
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: out,
    stream: true,
    stream_options: { include_usage: true },
    // Per-provider request quirks (e.g. OpenAI GPT-5 needs max_completion_tokens).
    [quirksFor(model.provider).tokenParam]: maxTokens,
  };
  if (context.tools.length) {
    payload.tools = context.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.parameters),
      },
    }));
  }
  return payload;
}

function toWire(m: Message): Record<string, unknown> {
  if (m.role === "toolResult") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: flattenText(m) };
  }
  const toolCalls = m.content.filter((b) => b.type === "toolCall");
  const entry: Record<string, unknown> = { role: m.role };
  const textStr = m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const images = m.content.filter((b) => b.type === "image");
  const parts: Record<string, unknown>[] = [];
  if (textStr) parts.push({ type: "text", text: textStr });
  for (const img of images) {
    if (img.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.mime_type ?? "image/png"};base64,${img.data}` },
      });
    }
  }
  entry.content = images.length ? (parts.length ? parts : textStr) : textStr;
  if (toolCalls.length) {
    entry.tool_calls = toolCalls.map((tc) =>
      tc.type === "toolCall"
        ? {
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }
        : null,
    );
  }
  return entry;
}

function flattenText(m: Message): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function* consumeSse(resp: CompatResponse, model: Model): AsyncIterable<StreamEvent> {
  const textBuf = new Map<number, string[]>();
  const thinkBuf = new Map<number, string[]>();
  // tool index -> { id, name, args }
  const tools = new Map<number, { id: string; name: string; args: string }>();
  let seenText = false;
  let seenThink = false;
  let finishReason = "stop";
  let usageInput = 0;
  let usageOutput = 0;
  const assistant = new AssistantMessage({ content: [], model: model.id, stop_reason: "stop" });
  yield startEv(assistant);

  for await (const line of readLines(resp)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const usage = chunk.usage as Record<string, number> | undefined;
    if (usage) {
      usageInput = usage.prompt_tokens ?? usageInput;
      usageOutput = usage.completion_tokens ?? usageOutput;
    }
    const choices = (chunk.choices as Record<string, unknown>[] | undefined) ?? [];
    if (!choices.length) continue;
    const choice = choices[0]!;
    const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
    const fr = choice.finish_reason as string | undefined;
    if (fr) finishReason = FINISH_MAP[fr] ?? "stop";

    const reasoningContent = delta.reasoning_content as string | undefined;
    if (reasoningContent) {
      const idx = 0;
      (thinkBuf.get(idx) ?? thinkBuf.set(idx, []).get(idx))!.push(reasoningContent);
      if (!seenThink) {
        seenThink = true;
        yield thinkingStart(idx);
      }
      yield thinkingDelta(reasoningContent, idx);
    }
    const reasoning = delta.reasoning as string | undefined;
    if (reasoning) {
      const idx = 0;
      (thinkBuf.get(idx) ?? thinkBuf.set(idx, []).get(idx))!.push(reasoning);
      if (!seenThink) {
        seenThink = true;
        yield thinkingStart(idx);
      }
      yield thinkingDelta(reasoning, idx);
    }

    const content = delta.content as string | undefined;
    if (content) {
      const idx = 0;
      (textBuf.get(idx) ?? textBuf.set(idx, []).get(idx))!.push(content);
      if (!seenText) {
        seenText = true;
        yield textStart(idx);
      }
      yield textDelta(content, idx);
    }

    const tcDelta = (delta.tool_calls as Record<string, unknown>[] | undefined) ?? [];
    for (const tc of tcDelta) {
      const idx = (tc.index as number | undefined) ?? 0;
      const slot = tools.get(idx) ?? tools.set(idx, { id: "", name: "", args: "" }).get(idx)!;
      const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
      if (tc.id && !slot.id) slot.id = tc.id as string;
      if (fn.name && !slot.name) slot.name = fn.name as string;
      const argsDelta = fn.arguments as string | undefined;
      if (argsDelta) {
        slot.args += argsDelta;
        yield toolCallDelta(argsDelta, idx);
      }
    }
  }

  // finalize blocks in stable index order: thinking(0) -> text(0) -> tools
  if (seenThink) {
    const idx = 0;
    const t = (thinkBuf.get(idx) ?? []).join("");
    assistant.content.push(thinking(t));
    yield thinkingEnd(t, idx);
  }
  if (seenText) {
    const idx = 0;
    const t = (textBuf.get(idx) ?? []).join("");
    assistant.content.push(text(t));
    yield textEnd(t, idx);
  }
  for (const idx of [...tools.keys()].sort((a, b) => a - b)) {
    const slot = tools.get(idx)!;
    const rawArgs = slot.args || "{}";
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      args = { _raw: rawArgs };
    }
    const call = toolCall(slot.id || `call_${idx}`, slot.name, args);
    assistant.content.push(call);
    yield toolCallStart(idx);
    yield toolCallEnd(call, idx);
  }

  assistant.stop_reason = finishReason as AssistantMessage["stop_reason"];
  if (!assistant.content.length) assistant.content.push(text(""));
  assistant.usage.input = usageInput;
  assistant.usage.output = usageOutput;
  attachCost(model, assistant.usage);
  yield doneEv(assistant.stop_reason, assistant);
}

/** Iterate SSE `data:` lines from a Response body stream. */
async function* readLines(resp: CompatResponse): AsyncIterable<string> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
