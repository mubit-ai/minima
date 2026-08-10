import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent/agent.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import { supportsImageInput } from "../src/ai/provider_quirks.ts";
import type { FauxRegistration } from "../src/ai/providers/faux.ts";
import { readTool } from "../src/tools/index.ts";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const VISION: Model = {
  id: "faux-vision",
  provider: "faux",
  api: "faux",
  name: "Faux Vision",
  cost: { input: 0, output: 0 },
  context_window: 100_000,
  max_tokens: 4096,
  input: ["text", "image"],
};
const TEXT_ONLY: Model = { ...VISION, id: "faux-text", name: "Faux Text", input: ["text"] };

let tmp = "";
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
  resetRegistry();
  resetProviderRegistration();
});

function pngPath(): string {
  tmp = mkdtempSync(join(tmpdir(), "minima-img-e2e-"));
  const p = join(tmp, "shot.png");
  writeFileSync(p, Buffer.from(PNG_1X1_B64, "base64"));
  return p;
}

/** One turn: the model calls read on `p`, then replies. */
async function runTurn(model: Model, p: string): Promise<{ reg: FauxRegistration; agent: Agent }> {
  resetRegistry();
  resetProviderRegistration();
  const reg = registerFauxProvider([model]);
  reg.setResponses([
    new AssistantMessage({
      content: [toolCall("c1", "read", { path: p })],
      stop_reason: "toolUse",
    }),
    new AssistantMessage({ content: [text("seen")] }),
  ]);
  const agent = new Agent({
    model: reg.getModel(),
    tools: [readTool({ imageResults: () => supportsImageInput(model) })],
  });
  await agent.prompt("what is in this image?");
  return { reg, agent };
}

describe("read → image block → provider (end to end)", () => {
  test("a vision model receives the image", async () => {
    const p = pngPath();
    const { reg, agent } = await runTurn(VISION, p);
    // The SECOND request is the one carrying the tool result back to the model.
    expect(reg.state.requests[1]?.images).toEqual([
      { mime: "image/png", bytes: PNG_1X1_B64.length },
    ]);
    const result = agent.agentState.messages.find((m) => m.role === "toolResult")!;
    expect(result.content.map((b) => b.type)).toEqual(["text", "image"]);
    expect(result.textContent).toContain("[image]");
  });

  test("a text-only model gets the refusal and no image reaches the provider", async () => {
    const p = pngPath();
    const { reg, agent } = await runTurn(TEXT_ONLY, p);
    expect(reg.state.requests[1]?.images).toEqual([]);
    const result = agent.agentState.messages.find((m) => m.role === "toolResult")!;
    expect(result.content.map((b) => b.type)).toEqual(["text"]);
    expect(result.textContent).toMatch(/image file not supported/);
  });
});
