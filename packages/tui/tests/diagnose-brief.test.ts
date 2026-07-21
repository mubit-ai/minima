import { describe, expect, test } from "bun:test";
import {
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

// The recovery ladder's memory brief: /v1/diagnose failure lessons formatted for the
// replan preamble. Strictly fail-open — a memory outage or an old server must never
// block a retry.

function routerWith(handler: (path: string) => { status: number; json: unknown }) {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const result = handler(u.pathname);
    return { status: result.status, json: async () => result.json };
  };
  const client = new MinimaClient({ baseUrl: "http://svc.local", apiKey: "k", fetch: fetchLike });
  const config = harnessConfig({ minimaApiKey: "k", candidates: ["m"] });
  return new MinimaRouter({ client, config, mapping: new ModelMapping() });
}

describe("MinimaRouter.diagnoseBrief", () => {
  test("formats matched failure lessons into an injectable brief", async () => {
    const router = routerWith(() => ({
      status: 200,
      json: {
        lane: "minima:default",
        failure_lessons: [
          { lesson_id: "l1", content: "pin the SDK before deleting shims" },
          { lesson_id: "l2", content: "  " }, // blank content must be dropped
          { lesson_id: "l3", content: "never hand-patch site-packages" },
        ],
      },
    }));
    const brief = await router.diagnoseBrief("ModuleNotFoundError: mubit");
    expect(brief).toContain("Past failure lessons");
    expect(brief).toContain("- pin the SDK before deleting shims");
    expect(brief).toContain("- never hand-patch site-packages");
    expect(brief?.split("\n")).toHaveLength(3); // header + 2 non-blank lessons
  });

  test("returns null when nothing matched", async () => {
    const router = routerWith(() => ({
      status: 200,
      json: { lane: "minima:default", failure_lessons: [] },
    }));
    expect(await router.diagnoseBrief("some error")).toBeNull();
  });

  test("returns null on server error (fail-open) and on empty input", async () => {
    const router = routerWith(() => ({ status: 500, json: { detail: "boom" } }));
    expect(await router.diagnoseBrief("some error")).toBeNull();
    expect(await router.diagnoseBrief("   ")).toBeNull();
  });
});
