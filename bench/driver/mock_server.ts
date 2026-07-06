/**
 * Scripted /v1 Minima server with full request capture.
 *
 * Makes offline→reconnect and recovery-ladder flows deterministic and free. Serves the
 * minimal contract the TUI touches at runtime: POST /v1/recommend, POST /v1/feedback,
 * GET /v1/models (called at startup for mapping/catalog sync), GET /v1/capabilities.
 * The client allows key-less localhost calls, so no auth is needed.
 */

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export class MockMinimaServer {
  requests: CapturedRequest[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  recommendModel = "claude-haiku-4-5";
  recommendProvider = "anthropic";

  constructor(readonly port: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): void {
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      async fetch(req: Request): Promise<Response> {
        const u = new URL(req.url);
        let body: unknown = null;
        if (req.method === "POST") {
          try {
            body = await req.json();
          } catch {}
        }
        self.requests.push({
          method: req.method,
          path: u.pathname,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        });
        return self.route(req.method, u.pathname, body);
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  captured(path: string): CapturedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  private route(method: string, path: string, body: unknown): Response {
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

    if (method === "GET" && path === "/v1/capabilities") {
      return json({
        plan: false,
        workflow: true,
        api_version: "bench-mock",
        honored_constraints: ["candidate_models", "excluded_models"],
      });
    }
    if (method === "GET" && path === "/v1/models") {
      return json({
        models: [
          {
            model_id: this.recommendModel,
            provider: this.recommendProvider,
            display_name: "Mock Haiku",
            input_cost_per_mtok: 1.0,
            output_cost_per_mtok: 5.0,
            supports_prompt_caching: true,
            context_window: 200_000,
          },
        ],
        catalog_version: "bench-mock-1",
      });
    }
    if (method === "POST" && path === "/v1/recommend") {
      const rec = {
        model_id: this.recommendModel,
        provider: this.recommendProvider,
        predicted_success: 0.9,
        est_cost_usd: 0.001,
        score: 1.0,
        rationale: "bench mock: fixed recommendation",
        decision_basis: "prior" as const,
      };
      return json({
        recommendation_id: `mock-${crypto.randomUUID().slice(0, 8)}`,
        recommended_model: rec,
        ranked: [rec],
        confidence: 0.9,
        decision_basis: "prior",
        threshold_used: 0.7,
        classified_task_type: "other",
        classified_difficulty: "easy",
        catalog_version: "bench-mock-1",
        selection_policy: "argmin",
      });
    }
    if (method === "POST" && path === "/v1/feedback") {
      const b = (body ?? {}) as Record<string, unknown>;
      return json({
        accepted: true,
        record_id: `mockrec-${String(b.recommendation_id ?? "none")}`,
        reinforced_entry_ids: [],
      });
    }
    if (method === "GET" && path === "/v1/health") return json({ status: "ok" });
    return json({ detail: `bench mock: unhandled ${method} ${path}` }, 404);
  }
}
