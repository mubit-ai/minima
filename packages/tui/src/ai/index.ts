/**
 * AI layer — port of the Python harness's ai/ (types, streaming, provider registry).
 */

export * from "./types.ts";
export * from "./events.ts";
export * from "./usage.ts";
export * from "./stream.ts";
export {
  getProvider,
  registerProvider,
  unregisterProvider,
  registeredApis,
  resetRegistry,
  resetProviderRegistration,
  ensureProvidersRegistered,
  type Provider,
} from "./providers/index.ts";
export { registerFauxProvider, FauxRegistration, FauxProviderState } from "./providers/faux.ts";
export { OpenAICompatProvider, AnthropicProvider, GoogleProvider } from "./providers/index.ts";
export {
  registerModel,
  registerModels,
  tryGetModel,
  findModelById,
  allModels,
  resetModelRegistry,
} from "./registry.ts";
