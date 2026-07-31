import { describe, expect, test } from "bun:test";

import { supportsImageInput } from "../src/ai/provider_quirks.ts";
import { SEED_MODELS } from "../src/cli/main.ts";

describe("supportsImageInput", () => {
  test("true only when the registry says so", () => {
    expect(supportsImageInput({ input: ["text", "image"] })).toBe(true);
    expect(supportsImageInput({ input: ["image"] })).toBe(true);
  });

  // Fail-closed: a text-only model 400s on an image block, and models synthesized from the
  // service catalog or OpenRouter carry no modality at all. Unknown must mean no.
  test("false for text-only, for an absent declaration, and for a null model", () => {
    expect(supportsImageInput({ input: ["text"] })).toBe(false);
    expect(supportsImageInput({})).toBe(false);
    expect(supportsImageInput(null)).toBe(false);
  });
});

describe("SEED_MODELS modality", () => {
  // Cheap guard so a future Anthropic/Google seed cannot silently ship without vision.
  test("every anthropic and google seed declares image input", () => {
    const missing = SEED_MODELS.filter(
      (m) => (m.provider === "anthropic" || m.provider === "google") && !supportsImageInput(m),
    ).map((m) => m.id);
    expect(missing).toEqual([]);
  });

  test("models whose vision support is unverified stay fail-closed", () => {
    const byId = new Map(SEED_MODELS.map((m) => [m.id, m]));
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "z-ai/glm-5.2"]) {
      expect(supportsImageInput(byId.get(id) ?? null)).toBe(false);
    }
  });
});
