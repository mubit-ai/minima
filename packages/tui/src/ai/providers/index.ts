/**
 * Provider registry entry point.
 *
 * Port of the Python harness's ai/providers/__init__.py. `ensureProvidersRegistered`
 * idempotently registers the always-available openai-compat provider; the
 * anthropic/google providers register when their modules are imported (their
 * SDKs are bundled). The faux provider is opt-in via registerFauxProvider.
 */

import { AnthropicProvider } from "./anthropic.ts";
import {
  type Provider,
  getProvider,
  registerProvider,
  registeredApis,
  resetRegistry,
  unregisterProvider,
} from "./base.ts";
import { GoogleProvider } from "./google.ts";
import { OpenAICompatProvider } from "./openai_compat.ts";

export { getProvider, registerProvider, registeredApis, resetRegistry, unregisterProvider };
export type { Provider };
export { OpenAICompatProvider, AnthropicProvider, GoogleProvider };
export { registerFauxProvider, FauxRegistration, FauxProviderState } from "./faux.ts";

let REGISTERED = false;

export function ensureProvidersRegistered(): void {
  if (REGISTERED) return;
  REGISTERED = true;
  const present = new Set(registeredApis());

  // Always available: raw-fetch OpenAI-compatible provider.
  registerIfAbsent(present, "openai-completions", () => {
    const provider = new OpenAICompatProvider();
    return [provider.apiId, provider] as const;
  });

  // Anthropic + Google build their SDK clients lazily (on first stream), so registering
  // the instances is safe even without keys present; a missing key surfaces only when a
  // model of that api is actually called.
  for (const ctor of [AnthropicProvider, GoogleProvider]) {
    registerIfAbsent(present, "", () => {
      const p = new ctor();
      return [p.apiId, p] as const;
    });
  }

  // The faux provider registers on demand via registerFauxProvider for tests/demos.
}

/** Register only when not already present, so tests' injected providers aren't clobbered. */
function registerIfAbsent(
  present: Set<string>,
  _expected: string,
  build: () => readonly [string, Provider],
): void {
  try {
    const [api, provider] = build();
    if (present.has(api)) return;
    registerProvider(api, provider);
  } catch (exc) {
    console.debug(`provider not registered: ${String(exc)}`);
  }
}

/** Test helper: reset the lazy-init flag (pair with resetRegistry). */
export function resetProviderRegistration(): void {
  REGISTERED = false;
}
