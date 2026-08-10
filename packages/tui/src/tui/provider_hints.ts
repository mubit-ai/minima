/**
 * Provider-key hint helpers, shared by app.tsx and the hooks lifted out of it.
 *
 * Extraction only — bodies unchanged from their original module scope in app.tsx.
 */

import { PROVIDERS, envVarsForProvider, providerKeyPresent } from "../ai/provider_catalog.ts";

/** True when at least one key-requiring model provider has its key set. */
export function anyProviderKeyPresent(): boolean {
  return PROVIDERS.some((p) => p.requiresKey && providerKeyPresent(p.name));
}

/** Suggested `/config set` hint for a provider (or a generic one). */
export function keyHint(provider?: string): string {
  const env = provider ? envVarsForProvider(provider)[0] : undefined;
  return env ? `\`/config set ${env} <key>\`` : "a model-provider key via /config";
}

/**
 * Append actionable guidance to an auth-shaped error so a user who ran `/auth` (routing only)
 * knows to set a MODEL-provider key. Leaves already-actionable messages (our own "config set"
 * text) untouched.
 */
export function actionableError(msg: string, provider?: string): string {
  const authish =
    /could not resolve authentication|api[\s_-]?key|authtoken|unauthor|x-api-key|http 401|no api key/i.test(
      msg,
    );
  if (!authish || /config set/i.test(msg)) return msg;
  return `${msg}\n→ Set a model-provider key: ${keyHint(provider)} (\`/auth\` configures routing only), then /reconnect.`;
}
