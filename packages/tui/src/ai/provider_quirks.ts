/**
 * Per-provider and per-model request quirks, as DATA not control flow.
 *
 * Port of the Python harness's ai/provider_quirks.py. Most OpenAI-compatible hosts speak the
 * identical wire protocol; a few diverge on small details (e.g. OpenAI GPT-5/o-series
 * reject `max_tokens` and require `max_completion_tokens`). Encoded as a lookup table so
 * the next quirk is a one-line data entry, not a new branch in the provider.
 */

export interface ProviderQuirks {
  /** Name of the max-output-tokens param. */
  readonly tokenParam: string;
  /**
   * Wire shape of "reasoning off" on this host, for the models that have to say it out
   * loud. OpenAI's chat/completions applies a server-side DEFAULT effort, so client silence
   * is not "off"; OpenRouter's documented switch is `reasoning.enabled=false`. Absent for
   * hosts (xai, groq, deepseek) that 400 on the param for models that do not take it —
   * there, sending nothing already IS off.
   *
   * The SHAPE is a per-provider fact; WHETHER to send it is per-model registry data
   * (`Model.tools_require_effort_none`). Keying the trigger per-provider instead would
   * break gpt-4o, which 400s on the parameter on the very host that requires it for
   * gpt-5.6-* — see effortNoneWithTools below.
   */
  readonly reasoningOff?: Readonly<Record<string, unknown>>;
}

const DEFAULT_QUIRKS: ProviderQuirks = { tokenParam: "max_tokens" };

// Keyed by harness provider id. Only providers that DIVERGE from the baseline appear here.
const QUIRKS: Record<string, ProviderQuirks> = {
  openai: { tokenParam: "max_completion_tokens", reasoningOff: { reasoning_effort: "none" } },
  openrouter: { tokenParam: "max_tokens", reasoningOff: { reasoning: { enabled: false } } },
};

/** Quirks for `provider` (the baseline OpenAI-compatible behavior if it has none). */
export function quirksFor(provider: string): ProviderQuirks {
  return QUIRKS[provider] ?? DEFAULT_QUIRKS;
}

/**
 * Anthropic thinking API shape a model needs (MUB-182):
 *   - "enabled":  classic `thinking: {type: "enabled", budget_tokens}` (pre-4.7 models;
 *     still functional on Opus 4.6 / Sonnet 4.6).
 *   - "adaptive": `thinking: {type: "adaptive"}` + `output_config: {effort}` — models that
 *     400 on "enabled" ("thinking.type.enabled is not supported for this model").
 *   - "none":     no reasoning capability; never send thinking kwargs.
 */
export type ThinkingFormat = "enabled" | "adaptive" | "none";

/**
 * Thinking API shape for `model` ("none" when the model cannot reason at all).
 *
 * Which models require the adaptive shape is DATA on the model registry — the
 * `Model.adaptive_thinking` flag (set in the seed catalog / at registration) is the single
 * source of truth; there is no id-pattern list here. Unflagged reasoning models keep the
 * classic shape so unknown/older models never regress.
 */
export function thinkingFormatFor(model: {
  reasoning?: boolean;
  adaptive_thinking?: boolean;
}): ThinkingFormat {
  if (!model.reasoning) return "none";
  return model.adaptive_thinking ? "adaptive" : "enabled";
}

/**
 * Whether `model` accepts image input. Same doctrine as thinkingFormatFor: the capability
 * is DATA on the registry (`Model.input`), not an id-pattern list here.
 *
 * FAIL-CLOSED — an absent `input` means UNKNOWN, and unknown must mean no. A text-only
 * model 400s on an image block, and models synthesized from the service catalog or
 * OpenRouter carry no modality until someone teaches them one. So a missing declaration
 * costs a refused image, never a broken run.
 */
export function supportsImageInput(model: { input?: readonly string[] } | null): boolean {
  return model?.input?.includes("image") === true;
}

/**
 * Whether this request must pin `reasoning_effort: "none"`. Same doctrine as the two above:
 * the capability is DATA on the registry (`Model.tools_require_effort_none`), not an
 * id-pattern list here — and never a per-provider rule, since gpt-4o on the same provider
 * 400s on the parameter itself.
 *
 * `hasTools` is load-bearing. The API refuses only the TOOLS + effort combination, so a
 * tool-less call (judge, classifier, --no-tools) keeps the model's own default effort and
 * still reasons; pinning it unconditionally would silently downgrade those too.
 */
export function effortNoneWithTools(
  model: { tools_require_effort_none?: boolean },
  hasTools: boolean,
): boolean {
  return hasTools && model.tools_require_effort_none === true;
}

// Harness ThinkingLevel -> wire `output_config.effort`. "off" (and anything unknown)
// deliberately maps to nothing: no effort param is sent.
const EFFORT_BY_LEVEL: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** Wire effort for a harness thinking level; undefined when none applies. */
export function effortForLevel(level: unknown): string | undefined {
  return typeof level === "string" ? EFFORT_BY_LEVEL[level] : undefined;
}
