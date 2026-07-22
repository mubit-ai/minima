/**
 * Core LLM types — TypeScript port of the Python harness's ai/types.ts (itself a port of
 * @earendil-works/pi-ai's data model).
 *
 * Wire-contract discriminator values (`type` / `role` / `stopReason`) are kept
 * identical to PI's so the shapes stay recognizable across the ecosystem.
 */

// ---------------------------------------------------------------------------
// Cost / usage
// ---------------------------------------------------------------------------

export interface Cost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

/** Token accounting; mirrors PI's AssistantMessage.usage. Mutable: cost is attached post-gen. */
export class Usage {
  input = 0;
  output = 0;
  cache_read = 0;
  cache_write = 0;
  cost: Cost = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };

  constructor(init?: Partial<Pick<Usage, "input" | "output" | "cache_read" | "cache_write">>) {
    if (init) Object.assign(this, init);
  }
}

// ---------------------------------------------------------------------------
// Modalities & model descriptor
// ---------------------------------------------------------------------------

export type Modality = "text" | "image";

/** API ids match PI's registry so provider dispatch is recognizable. */
export type ApiId = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "faux";

export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface Model {
  id: string;
  provider: string;
  api: ApiId;
  name: string;
  cost: ModelCost;
  context_window: number;
  max_tokens: number;
  input?: Modality[];
  reasoning?: boolean;
  // Requires the adaptive thinking shape (claude-fable-5, claude-sonnet-5, opus-4.7+):
  // the API 400s on thinking:{type:"enabled", budget_tokens}; providers send
  // thinking:{type:"adaptive"} (+ output_config.effort) instead. Source of truth for
  // ai/provider_quirks.thinkingFormatFor.
  adaptive_thinking?: boolean;
  base_url?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Content blocks (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mime_type?: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  // Anthropic signs every thinking block; the signature MUST be echoed back verbatim when
  // replayed in history, or the API 400s. Empty for providers that don't sign (e.g. Gemini).
  signature?: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  // May be partial during streaming; defaults to {}, never null (matches PI).
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCall;

// Factories — terse construction for the common cases.
export const text = (t: string): TextContent => ({ type: "text", text: t });
export const image = (data: string, mime_type = "image/png"): ImageContent => ({
  type: "image",
  data,
  mime_type,
});
export const thinking = (t: string, signature = ""): ThinkingContent => ({
  type: "thinking",
  thinking: t,
  signature,
});
export const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCall => ({ type: "toolCall", id, name, arguments: args });

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant" | "toolResult";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface MessageInit {
  role: Role;
  content: ContentBlock[] | string;
  timestamp?: number;
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
}

export class Message {
  role: Role;
  content: ContentBlock[];
  timestamp?: number;
  tool_call_id?: string;
  tool_name?: string;
  is_error: boolean;

  constructor(init: MessageInit) {
    this.role = init.role;
    this.content = typeof init.content === "string" ? [text(init.content)] : init.content;
    this.timestamp = init.timestamp;
    this.tool_call_id = init.tool_call_id;
    this.tool_name = init.tool_name;
    this.is_error = init.is_error ?? false;
  }

  /** Concatenated text across all TextContent blocks (empty for non-text). */
  get textContent(): string {
    return this.content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}

export interface AssistantMessageInit {
  content: ContentBlock[] | string;
  model?: string;
  stop_reason?: StopReason;
  usage?: Usage;
  error_message?: string;
  response_id?: string;
  timestamp?: number;
}

export class AssistantMessage extends Message {
  declare role: "assistant";
  model: string;
  stop_reason: StopReason;
  usage: Usage;
  error_message?: string;
  response_id?: string;

  constructor(init: AssistantMessageInit) {
    super({ role: "assistant", content: init.content, timestamp: init.timestamp });
    this.model = init.model ?? "";
    this.stop_reason = init.stop_reason ?? "stop";
    this.usage = init.usage ?? new Usage();
    this.error_message = init.error_message;
    this.response_id = init.response_id;
  }

  get toolCalls(): ToolCall[] {
    return this.content.filter((b): b is ToolCall => b.type === "toolCall");
  }
}

export function isAssistant(m: Message): m is AssistantMessage {
  return m.role === "assistant";
}

// ---------------------------------------------------------------------------
// Tools (declared here to avoid an import cycle; executable form lives in agent/tools.ts)
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A tool's parameter schema. The harness uses `validate()` to check model-supplied args. */
export interface ToolSchema {
  readonly jsonSchema: Record<string, unknown>;
  validate(value: unknown): ParseResult<Record<string, unknown>>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema;
}

export interface Context {
  system_prompt?: string;
  messages: Message[];
  tools: Tool[];
}

export function context(init: {
  system_prompt?: string;
  messages?: Message[];
  tools?: Tool[];
}): Context {
  return {
    system_prompt: init.system_prompt,
    messages: init.messages ?? [],
    tools: init.tools ?? [],
  };
}
