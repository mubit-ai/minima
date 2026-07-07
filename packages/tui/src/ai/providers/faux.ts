/**
 * In-memory provider for hermetic tests and demos.
 *
 * Port of minima_harness/ai/providers/faux.py. Opt-in; not registered by default.
 * One deterministic scripted flow per registration. Usage is estimated at roughly
 * 1 token per 4 characters when not provided on the message.
 */

import type { StreamEvent } from "../events.ts";
import {
  done as doneEv,
  error as errorEv,
  start as startEv,
  textDelta,
  textEnd,
  textStart,
  thinkingDelta,
  thinkingEnd,
  thinkingStart,
  toolCallEnd,
  toolCallStart,
} from "../events.ts";
import { AssistantMessage, type Context, type Model, text } from "../types.ts";
import { attachCost } from "../usage.ts";
import { type Provider, registerProvider, unregisterProvider } from "./base.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux (test)",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
  input: ["text"],
  reasoning: false,
};

// Roughly 1 token per 4 characters, per PI's faux provider.
const CHARS_PER_TOKEN = 4;

function estimateUsage(msg: AssistantMessage): void {
  if (msg.usage.input || msg.usage.output) return;
  let charLen = 0;
  for (const b of msg.content) {
    if (b.type === "text") charLen += b.text.length;
    else if (b.type === "thinking") charLen += b.thinking.length;
  }
  msg.usage.output = Math.max(1, Math.floor(charLen / CHARS_PER_TOKEN));
}

/** Observable per-registration state. */
export class FauxProviderState {
  callCount = 0;
  responses: AssistantMessage[] = [];
  get pendingResponseCount(): number {
    return this.responses.length;
  }
}

/** Handle returned by registerFauxProvider. */
export class FauxRegistration {
  readonly models: Model[];
  readonly state = new FauxProviderState();
  private readonly provider: FauxProvider;

  constructor(models?: Model[]) {
    this.models = models ?? [FAUX_MODEL];
    this.provider = new FauxProvider(this.state, this.models);
  }

  getModel(modelId?: string): Model {
    if (!modelId) return this.models[0]!;
    const m = this.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`faux model not found: ${modelId}`);
    return m;
  }

  setResponses(messages: AssistantMessage[]): this {
    this.state.responses = [...messages];
    return this;
  }

  appendResponses(messages: AssistantMessage[]): this {
    this.state.responses.push(...messages);
    return this;
  }

  register(): this {
    registerProvider("faux", this.provider);
    return this;
  }

  unregister(): void {
    unregisterProvider("faux");
  }

  /** Use as a callback: registers, runs `fn`, always unregisters. */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    this.register();
    try {
      return await fn();
    } finally {
      this.unregister();
    }
  }
}

class FauxProvider implements Provider {
  readonly apiId = "faux";
  constructor(
    private readonly state: FauxProviderState,
    private readonly models: Model[],
  ) {}

  async *stream(
    model: Model,
    _context: Context,
    opts?: { options?: Record<string, unknown>; signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    // Honor a pre-aborted signal like the real providers, so abort behaviour is
    // exercisable in hermetic tests.
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.state.callCount += 1;
    const queued = this.state.responses.shift();
    if (!queued) {
      const err = new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "No more faux responses queued",
      });
      err.model = model.id;
      yield errorEv("error", err);
      return;
    }

    const msg = queued;
    msg.model = model.id;
    estimateUsage(msg);
    attachCost(model, msg.usage);

    yield startEv(msg);
    for (const [index, block] of msg.content.entries()) {
      if (block.type === "text") {
        yield textStart(index);
        if (block.text) yield textDelta(block.text, index);
        yield textEnd(block.text, index);
      } else if (block.type === "thinking") {
        yield thinkingStart(index);
        if (block.thinking) yield thinkingDelta(block.thinking, index);
        yield thinkingEnd(block.thinking, index);
      } else if (block.type === "toolCall") {
        yield toolCallStart(index);
        yield toolCallEnd(block, index);
      }
    }
    yield doneEv(msg.stop_reason, msg);
  }
}

/** Register a temporary in-memory provider for tests/demos. Unregister when done. */
export function registerFauxProvider(models?: Model[]): FauxRegistration {
  return new FauxRegistration(models).register();
}
