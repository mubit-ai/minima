/**
 * OpenAI-compatible Chat Completions provider (raw fetch, no `openai` SDK).
 *
 * Port of the Python harness's ai/providers/openai_compat.py. One implementation covers
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
import { effectiveEffort, quirksFor, reasoningPayload } from "../provider_quirks.ts";
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
import { resolveApiKey, sdkTimeoutMs, toJsonSchema } from "./_common.ts";

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
  /** Optional so existing test fakes stay valid; real Responses always have it. Read only
   *  on the error path, to recover the provider's own message. */
  text?(): Promise<string>;
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
        signal: requestSignal(options, opts.signal),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(
          `openai-compat request failed: HTTP ${resp.status}${await errorDetail(resp)}`,
        );
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

/**
 * The signal governing the request, honouring the caller's `options.timeout` (seconds).
 *
 * Unlike anthropic/google — whose SDKs impose a 60s default — an absent timeout stays
 * unbounded here: agent-loop turns pass no timeout and a total-request deadline would
 * guillotine a long generation mid-stream (the stream-idle watchdog in agent/loop.ts
 * covers those). The deadline exists for the one-shot side-channel calls (judge, critic,
 * scribe, classify) that DO pass one and previously had it silently dropped, leaving a
 * hung request to hang forever — Bun's fetch has no default deadline.
 */
function requestSignal(
  options: Record<string, unknown>,
  callerSignal?: AbortSignal,
): AbortSignal | undefined {
  if (options.timeout === undefined) return callerSignal;
  const deadline = AbortSignal.timeout(sdkTimeoutMs(options));
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

/** Cap on the quoted provider message — enough to diagnose, not enough to flood the TUI. */
const ERROR_DETAIL_CAP = 400;

/**
 * The provider's own explanation of a failed request. Without it a bare "HTTP 400" is
 * undiagnosable — the body is where OpenAI-compatible servers put "this model does not
 * exist", "context_length_exceeded", "insufficient_quota", "rate limit reached, try again
 * in 20s". Prefers the standard {"error":{"message":...}} envelope and falls back to raw
 * text. Never throws: a body that is unreadable, empty, or already consumed just yields
 * the bare status, which is what the caller had before.
 */
async function errorDetail(resp: CompatResponse): Promise<string> {
  try {
    const raw = (await resp.text?.())?.trim();
    if (!raw) return "";
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const found = parsed?.error?.message ?? parsed?.message;
      if (typeof found === "string" && found.trim()) message = found.trim();
    } catch {
      // Not JSON (an HTML error page from a proxy) — quote the raw text.
    }
    return ` — ${message.slice(0, ERROR_DETAIL_CAP)}${message.length > ERROR_DETAIL_CAP ? "…" : ""}`;
  } catch {
    return "";
  }
}

function buildPayload(
  model: Model,
  context: Context,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  if (context.system_prompt) {
    out.push({ role: "system", content: context.system_prompt });
  }
  for (const m of normalizeForTarget(context.messages, "openai-completions")) out.push(toWire(m));
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
  // The reasoning effort this request carries, decided in exactly one place (MUB-229) and
  // spelled the way this host spells it. The status bar renders the same decision, so the
  // indicator cannot claim a level the payload does not carry. A model that declares no
  // capability adds no key here at all.
  const effort = effectiveEffort(model, context.tools.length > 0, options.thinking_level);
  Object.assign(payload, reasoningPayload(model.provider, effort.send));
  return payload;
}

function toWire(m: Message): Record<string, unknown> {
  if (m.role === "toolResult") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.textContent };
  }
  const toolCalls = m.content.filter((b) => b.type === "toolCall");
  const entry: Record<string, unknown> = { role: m.role };
  const textStr = m.textContent;
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

async function* consumeSse(resp: CompatResponse, model: Model): AsyncIterable<StreamEvent> {
  // Chat Completions carries a single text and a single thinking channel per choice; both
  // always land at block index 0.
  const textBuf: string[] = [];
  const thinkBuf: string[] = [];
  // tool index -> { id, name, args }
  const tools = new Map<number, { id: string; name: string; args: string }>();
  let seenText = false;
  let seenThink = false;
  let finishReason = "stop";
  let usageInput = 0;
  let usageOutput = 0;
  let usageCacheRead = 0;
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
    if (typeof chunk.model === "string" && chunk.model) assistant.provider_model = chunk.model;
    const usage = chunk.usage as Record<string, unknown> | undefined;
    if (usage) {
      usageInput = (usage.prompt_tokens as number) ?? usageInput;
      usageOutput = (usage.completion_tokens as number) ?? usageOutput;
      const details = usage.prompt_tokens_details as Record<string, number> | undefined;
      usageCacheRead = details?.cached_tokens ?? usageCacheRead;
    }
    const choices = (chunk.choices as Record<string, unknown>[] | undefined) ?? [];
    if (!choices.length) continue;
    const choice = choices[0]!;
    const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
    const fr = choice.finish_reason as string | undefined;
    if (fr) finishReason = FINISH_MAP[fr] ?? "stop";

    // deepseek names it reasoning_content, openrouter reasoning. Coalesce rather than
    // handling each: a proxy that echoes BOTH used to emit the thinking block twice.
    const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
    if (reasoning) {
      thinkBuf.push(reasoning);
      if (!seenThink) {
        seenThink = true;
        yield thinkingStart(0);
      }
      yield thinkingDelta(reasoning, 0);
    }

    const content = delta.content as string | undefined;
    if (content) {
      textBuf.push(content);
      if (!seenText) {
        seenText = true;
        yield textStart(0);
      }
      yield textDelta(content, 0);
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
    const t = thinkBuf.join("");
    assistant.content.push(thinking(t));
    yield thinkingEnd(t, 0);
  }
  if (seenText) {
    const t = textBuf.join("");
    assistant.content.push(text(t));
    yield textEnd(t, 0);
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
  // prompt_tokens is INCLUSIVE of prompt_tokens_details.cached_tokens (as Gemini's
  // promptTokenCount is of its cache, and unlike Anthropic's exclusive input_tokens).
  // Reporting it raw billed every cached token at the full input rate — 10x over for
  // gpt-class models, 50x for deepseek — and that inflated total is the realized
  // actual_cost_usd fed to the meter and to /v1/feedback, so it skewed the observed cost
  // basis for every OpenAI-compatible model and pinned the cache-hit rate at zero.
  assistant.usage.input = Math.max(0, usageInput - usageCacheRead);
  assistant.usage.output = usageOutput;
  assistant.usage.cache_read = usageCacheRead;
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
