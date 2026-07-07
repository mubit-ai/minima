/**
 * linkbox — HTTP transport adapter.
 *
 * Everything interesting lives behind `createApp().handle`; this module is
 * the thin shim that decodes a real `Request` into an {@link ApiRequest},
 * dispatches it, and encodes the {@link ApiResponse} back onto the wire.
 * Tests exercise the app in-process and never import this file.
 *
 * Run directly (`bun src/server.ts`) to serve on PORT (default 8080).
 */

import type { ApiRequest, ApiResponse } from "./types.ts";
import { createApp, type App } from "./app.ts";

/** Decode a fetch-style Request into the app's transport-neutral shape. */
export async function decodeRequest(request: Request): Promise<ApiRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const decoded: ApiRequest = {
    method: request.method.toUpperCase(),
    path: url.pathname,
    headers,
    query,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    if (text.length > 0) {
      try {
        decoded.body = JSON.parse(text);
      } catch {
        // Leave body undefined; validators will report the missing object.
      }
    }
  }
  return decoded;
}

/** Encode an ApiResponse as a fetch-style Response. */
export function encodeResponse(res: ApiResponse): Response {
  const headers = new Headers(res.headers ?? {});
  if (res.body === null || res.status === 204) {
    return new Response(null, { status: res.status, headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}

/** Bind an app instance to a port. Returns Bun's server handle. */
export function serve(app: App, port: number) {
  return Bun.serve({
    port,
    fetch: async (request) => encodeResponse(app.handle(await decodeRequest(request))),
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const server = serve(createApp(), port);
  console.log(`linkbox listening on http://localhost:${server.port}`);
}
