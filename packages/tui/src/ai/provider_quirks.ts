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
}

const DEFAULT_QUIRKS: ProviderQuirks = { tokenParam: "max_tokens" };

// Keyed by harness provider id. Only providers that DIVERGE from the baseline appear here.
const QUIRKS: Record<string, ProviderQuirks> = {
  openai: { tokenParam: "max_completion_tokens" },
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

// Model-id patterns that REQUIRE the adaptive shape (budget_tokens is rejected with a 400):
// Opus 4.7+, Sonnet 5+, Fable 5, Mythos 5. Conservative on purpose — anything unmatched
// keeps the classic shape so unknown/older models never regress. Extend with one line.
const ADAPTIVE_THINKING_MODELS: readonly RegExp[] = [
  /^(?:[\w.:-]+\/)?claude-opus-4-[7-9]/,
  /^(?:[\w.:-]+\/)?claude-sonnet-[5-9]/,
  /^(?:[\w.:-]+\/)?claude-fable-[0-9]/,
  /^(?:[\w.:-]+\/)?claude-mythos-[0-9]/,
];

/** Thinking API shape for `model` ("none" when the model cannot reason at all). */
export function thinkingFormatFor(model: { id: string; reasoning?: boolean }): ThinkingFormat {
  if (!model.reasoning) return "none";
  return ADAPTIVE_THINKING_MODELS.some((re) => re.test(model.id)) ? "adaptive" : "enabled";
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
