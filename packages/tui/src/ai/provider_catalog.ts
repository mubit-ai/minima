/**
 * Provider catalog: env-var mapping for each provider's API key.
 *
 * Lean port of the Python harness's ai/provider_catalog.py — only the parts the
 * openai_compat provider + offline gating need (envVarsForProvider). The full
 * curated model catalog (register_catalog_models) lands when the harness runtime
 * does. env_var order = resolution order (first set wins).
 */

export type ApiId = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "faux";

export interface ProviderSpec {
  readonly name: string;
  readonly displayName: string;
  readonly category: string;
  readonly api: ApiId;
  readonly envVars: readonly string[];
  readonly baseUrl?: string;
  readonly requiresKey: boolean;
  readonly showInConfig: boolean;
  readonly blurb: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: "anthropic",
    displayName: "Anthropic (Claude)",
    category: "closed-native",
    api: "anthropic-messages",
    envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
    requiresKey: true,
    showInConfig: true,
    blurb: "Claude — Opus / Sonnet / Haiku",
  },
  {
    name: "openai",
    displayName: "OpenAI",
    category: "closed-native",
    api: "openai-completions",
    envVars: ["OPENAI_API_KEY"],
    requiresKey: true,
    showInConfig: true,
    blurb: "GPT-5.x / GPT-4o",
  },
  {
    name: "google",
    displayName: "Google Gemini",
    category: "closed-native",
    api: "google-generative-ai",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    requiresKey: true,
    showInConfig: true,
    blurb: "Gemini 2.5 / 3.5",
  },
  {
    name: "xai",
    displayName: "xAI (Grok)",
    category: "closed-native",
    api: "openai-completions",
    envVars: ["XAI_API_KEY"],
    baseUrl: "https://api.x.ai/v1",
    requiresKey: true,
    showInConfig: true,
    blurb: "Grok 4.x",
  },
  {
    name: "deepseek",
    displayName: "DeepSeek",
    category: "closed-native",
    api: "openai-completions",
    envVars: ["DEEPSEEK_API_KEY"],
    baseUrl: "https://api.deepseek.com",
    requiresKey: true,
    showInConfig: true,
    blurb: "DeepSeek V4 (open-weight, cheap)",
  },
  {
    name: "openrouter",
    displayName: "OpenRouter",
    category: "aggregator",
    api: "openai-completions",
    envVars: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    showInConfig: true,
    blurb: "Aggregator — any model, one key",
  },
  {
    name: "groq",
    displayName: "Groq",
    category: "open-source-host",
    api: "openai-completions",
    envVars: ["GROQ_API_KEY"],
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    showInConfig: true,
    blurb: "Fast inference for open models",
  },
];

const BY_NAME = new Map(PROVIDERS.map((p) => [p.name, p]));

/** Env vars that supply the API key for `provider` (resolution order = first set wins). */
export function envVarsForProvider(provider: string): string[] {
  return [...(BY_NAME.get(provider)?.envVars ?? [])];
}

/** True when an env var supplying this provider's key is set (or it needs none). */
export function providerKeyPresent(provider: string): boolean {
  return envVarsForProvider(provider).some((v) => process.env[v]);
}

/** Fallback generic env vars for an unknown/custom OpenAI-compatible provider. */
export const GENERIC_COMPAT_ENV_VARS = ["OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY"];
