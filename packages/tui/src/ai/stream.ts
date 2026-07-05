/**
 * Unified generation entry points: stream() and complete().
 *
 * Port of the Python harness's ai/stream.py. Dispatches to the provider registered
 * for `model.api`. `stream()` returns a Stream (async iterable) that also
 * exposes `.result()` for the final assistant message — mirrors PI's TS stream
 * object, which is not a promise.
 */

import type { StreamEvent } from "./events.ts";
import { getProvider } from "./providers/base.ts";
import { ensureProvidersRegistered } from "./providers/index.ts";
import type { AssistantMessage, Context, Model } from "./types.ts";

export class Stream {
  private readonly iter: AsyncIterator<StreamEvent>;
  private resultMsg: AssistantMessage | null = null;
  private consumed = false;

  constructor(iter: AsyncIterable<StreamEvent>) {
    this.iter = iter[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<StreamEvent>> {
    const n = await this.iter.next();
    if (n.done) {
      this.consumed = true;
      return { done: true, value: undefined };
    }
    const ev = n.value as StreamEvent;
    if (ev.type === "done") {
      this.resultMsg = ev.message;
      this.consumed = true;
    } else if (ev.type === "error") {
      this.resultMsg = ev.error;
      this.consumed = true;
    }
    return { done: false, value: ev };
  }

  /** Drain the stream and return the final assistant message (done or error). */
  async result(): Promise<AssistantMessage> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of this) {
      // drain
    }
    if (!this.resultMsg) {
      throw new Error("stream ended without a done/error event");
    }
    return this.resultMsg;
  }

  get isConsumed(): boolean {
    return this.consumed;
  }
}

export interface StreamOptions {
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Begin streaming a generation for `model` against `context`. */
export function stream(model: Model, context: Context, opts: StreamOptions = {}): Stream {
  ensureProvidersRegistered();
  const provider = getProvider(model.api);
  return new Stream(provider.stream(model, context, opts));
}

/** Non-streaming convenience: return the final assistant message. */
export async function complete(
  model: Model,
  context: Context,
  opts: StreamOptions = {},
): Promise<AssistantMessage> {
  return stream(model, context, opts).result();
}
