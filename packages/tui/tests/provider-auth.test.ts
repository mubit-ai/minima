/**
 * Credential resolution for the SDK-backed providers.
 *
 * These paths had no coverage and two of them were wrong: an OAuth token was passed as an
 * api key, and since @anthropic-ai/sdk 0.41 a missing key no longer throws at construction —
 * the client defers resolution to the first request and will read ambient config files to
 * find one. Both are guarded here.
 */

import { describe, expect, test } from "bun:test";
import { buildAnthropicClient } from "../src/ai/providers/anthropic.ts";
import { buildGoogleClient } from "../src/ai/providers/google.ts";

const ANTHROPIC_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];
const GOOGLE_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"];

/** Run `fn` with the given env applied and everything in `vars` otherwise blanked. */
async function withEnv<T>(
  vars: string[],
  set: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const v of vars) {
    saved[v] = process.env[v];
    process.env[v] = set[v] ?? "";
  }
  try {
    return await fn();
  } finally {
    for (const [v, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[v];
      else process.env[v] = val;
    }
  }
}

describe("anthropic credentials", () => {
  test("a plain key lands in apiKey, not authToken", async () => {
    await withEnv(ANTHROPIC_VARS, { ANTHROPIC_API_KEY: "sk-plain" }, async () => {
      const client = (await buildAnthropicClient({})) as unknown as {
        apiKey: string | null;
        authToken: string | null;
      };
      expect(client.apiKey).toBe("sk-plain");
      expect(client.authToken).toBeNull();
    });
  });

  // Regression: an OAuth token used to be passed through the apiKey slot, so it went out as
  // an x-api-key header and the request 401'd.
  test("an OAuth token lands in authToken, never in apiKey", async () => {
    await withEnv(ANTHROPIC_VARS, { ANTHROPIC_OAUTH_TOKEN: "oauth-tok" }, async () => {
      const client = (await buildAnthropicClient({})) as unknown as {
        apiKey: string | null;
        authToken: string | null;
      };
      expect(client.authToken).toBe("oauth-tok");
      expect(client.apiKey).toBeNull();
    });
  });

  test("an explicit api_key option wins over the environment", async () => {
    await withEnv(ANTHROPIC_VARS, { ANTHROPIC_API_KEY: "sk-env" }, async () => {
      const client = (await buildAnthropicClient({ api_key: "sk-opt" })) as unknown as {
        apiKey: string | null;
      };
      expect(client.apiKey).toBe("sk-opt");
    });
  });

  // Load-bearing for hermeticity: without this the SDK would go looking on disk.
  test("no credential at all fails fast with an actionable message", async () => {
    await withEnv(ANTHROPIC_VARS, {}, async () => {
      await expect(buildAnthropicClient({})).rejects.toThrow(/no API key for provider "anthropic"/);
    });
  });

  test("the retry budget the SDK provides is left at its default, not disabled", async () => {
    await withEnv(ANTHROPIC_VARS, { ANTHROPIC_API_KEY: "k" }, async () => {
      const client = (await buildAnthropicClient({})) as unknown as { maxRetries: number };
      // Nothing in src/ai retries a model call, so this is the ONLY retry on the provider
      // path — 429s and overloads depend on it.
      expect(client.maxRetries).toBeGreaterThan(0);
    });
  });

  test("the seconds-based timeout option reaches the client as milliseconds", async () => {
    await withEnv(ANTHROPIC_VARS, { ANTHROPIC_API_KEY: "k" }, async () => {
      const client = (await buildAnthropicClient({ timeout: 30 })) as unknown as {
        timeout: number;
      };
      expect(client.timeout).toBe(30_000);
    });
  });
});

describe("google credentials", () => {
  test("builds a client from any of the accepted key variables", async () => {
    for (const v of GOOGLE_VARS) {
      await withEnv(GOOGLE_VARS, { [v]: "gk" }, async () => {
        expect(await buildGoogleClient({})).toBeDefined();
      });
    }
  });

  test("no credential at all fails fast with an actionable message", async () => {
    await withEnv(GOOGLE_VARS, {}, async () => {
      await expect(buildGoogleClient({})).rejects.toThrow(/no API key for provider "google"/);
    });
  });
});
