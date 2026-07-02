/**
 * Builds a Mubit-backed HarnessMemory from the environment. Kept separate from memory.ts
 * so that module (and its tests) stay free of the @mubit-ai/sdk import; the SDK is loaded
 * lazily here, only when a MUBIT_API_KEY is present. Returns a no-op memory otherwise, so
 * the harness runs unchanged when Mubit isn't configured.
 */

import {
  type HarnessMemory,
  type MemoryClient,
  MubitHarnessMemory,
  NoopHarnessMemory,
} from "./memory.ts";

const DEFAULT_ENDPOINT = "https://api.mubit.ai";
const AGENT_ID = "minima-harness";

export async function createMubitMemory(sessionId: string): Promise<HarnessMemory> {
  const key = process.env.MUBIT_API_KEY;
  if (!key) return new NoopHarnessMemory();
  // `or` (not ??) so a blank MUBIT_ENDPOINT="" falls back to the hosted default.
  const endpoint = process.env.MUBIT_ENDPOINT || DEFAULT_ENDPOINT;
  try {
    const { Client } = await import("@mubit-ai/sdk");
    const transport = endpoint.startsWith("http") ? "http" : "auto";
    const client = new Client({ endpoint, api_key: key, transport }) as unknown as MemoryClient;
    return new MubitHarnessMemory(client, sessionId, AGENT_ID);
  } catch {
    // Mubit must never block the harness — degrade to no-op memory.
    return new NoopHarnessMemory();
  }
}
