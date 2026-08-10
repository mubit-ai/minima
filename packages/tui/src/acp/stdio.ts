/**
 * The process's stdio, as an ACP `Stream`.
 *
 * The transport is newline-delimited JSON over stdin/stdout, which is what every ACP client
 * spawning an agent binary expects. Two consequences worth stating out loud, because breaking
 * either produces a session that fails in a way the user cannot diagnose:
 *
 *   1. **stdout belongs to the protocol.** Nothing else may write to it for the life of an
 *      `acp` run — one stray line of human-readable text corrupts the frame stream and the
 *      client disconnects. Every notice on this path goes to stderr, where the editor collects
 *      it as agent log output.
 *   2. **The pipe closing is the shutdown signal.** When the editor exits, stdin ends, the
 *      connection's read loop finishes, and `serveAcp` resolves — which is what lets the
 *      bootstrap run its normal end-of-session work instead of being killed mid-write.
 */

import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";

/** stdin/stdout as one bidirectional ACP stream. */
export function stdioStream(): Stream {
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      // The callback form is the backpressure-honest one: resolving only once the chunk has
      // been handed to the OS keeps the SDK's write queue from outrunning a slow reader.
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
  });
  return ndJsonStream(output, Bun.stdin.stream());
}
