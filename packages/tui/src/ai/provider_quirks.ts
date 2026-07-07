/**
 * Per-provider request quirks for the OpenAI-compatible provider, as DATA not control flow.
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
