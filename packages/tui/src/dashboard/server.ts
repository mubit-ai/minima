/**
 * The localhost dashboard server — `minima dashboard`.
 *
 * Security posture (a dev tool that reads your whole work history is worth locking down):
 *  - binds 127.0.0.1 by default, never 0.0.0.0;
 *  - every route except /healthz requires a per-process bearer token, handed over once in
 *    the printed URL (`?t=…`) and then parked in a Strict/HttpOnly cookie;
 *  - the token is compared in constant time, so a wrong guess leaks no timing signal;
 *  - READ-ONLY by default: the SQLite handle is opened `readonly`, so no route can write
 *    even if it tried. `--allow-writes` opens a second, read-write MinimaDb handle used by
 *    exactly one endpoint;
 *  - that write endpoint additionally requires a same-origin request, so a page in another
 *    tab cannot drive it with a cross-site form POST.
 *
 * The HTML views and the JSON API are built from the SAME payloads (`stats.ts`), so the
 * `/api/v1/*` contract is a real contract — a future SPA can consume it without the server
 * growing a second data path.
 */

import { MinimaDb, defaultDbPath } from "../db/minima_db.ts";
import { DashboardStore, LedgerUnavailableError, type Scope } from "./queries.ts";
import {
  type NavItem,
  type PaletteItem,
  costView,
  memoryView,
  notFoundView,
  overviewView,
  planDetailView,
  plansView,
  routingView,
  runView,
  runsView,
  shell,
} from "./render.ts";
import { overview, planView, sessionList } from "./stats.ts";

export const DEFAULT_PORT = 4180;
const COOKIE = "minima_dash";

export interface DashboardOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  token?: string;
  allowWrites?: boolean;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  readOnly: boolean;
  ledgerPath: string;
  stop(): void;
}

interface Ctx {
  store: DashboardStore;
  writeDb: MinimaDb | null;
  token: string;
  allowWrites: boolean;
}

const NAV: { path: string; label: string }[] = [
  { path: "/", label: "Overview" },
  { path: "/routing", label: "Routing" },
  { path: "/runs", label: "Sessions" },
  { path: "/plans", label: "Plans & gates" },
  { path: "/memory", label: "Memory" },
  { path: "/cost", label: "Cost" },
];

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return rest.join("=");
  }
  return null;
}

function authorized(req: Request, url: URL, token: string): boolean {
  const supplied =
    url.searchParams.get("t") ?? req.headers.get("x-minima-token") ?? cookieToken(req);
  return supplied !== null && constantTimeEqual(supplied, token);
}

/** Blocks cross-site form POSTs: Origin must be absent (curl) or this exact server. */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function scopeOf(url: URL): Scope {
  const project = url.searchParams.get("project");
  return project && project.length > 0 ? project : null;
}

function navFor(path: string, scope: Scope): NavItem[] {
  const qs = scope ? `?project=${encodeURIComponent(scope)}` : "";
  return NAV.map((n) => ({
    href: `${n.path}${qs}`,
    label: n.label,
    // /runs stays highlighted while drilled into a single session.
    active: n.path === "/" ? path === "/" : path === n.path || path.startsWith(`${n.path}/`),
  }));
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The full request handler. Exported so tests can exercise every route without listening. */
export function createHandler(ctx: Ctx): (req: Request) => Promise<Response> {
  // cmd-K reaches the two things worth jumping to by name. Capped: the palette is a
  // navigation aid, not a search index, and every row ships inside the HTML.
  const paletteFor = (scope: Scope): PaletteItem[] => [
    ...ctx.store.plans(scope, 40).map((p) => ({
      kind: "plan",
      label: p.title ?? p.id.slice(0, 8),
      href: `/plans/${encodeURIComponent(p.id)}`,
    })),
    ...ctx.store
      .runs(scope, 40)
      .filter((r) => r.events > 0)
      .map((r) => ({
        kind: "session",
        label: r.display_name ?? r.run_id.slice(0, 8),
        href: `/runs/${encodeURIComponent(r.run_id)}`,
      })),
  ];

  const page = (path: string, scope: Scope, title: string, body: string): Response =>
    html(
      shell({
        title,
        nav: navFor(path, scope),
        projects: ctx.store.projects(),
        scope,
        ledgerPath: ctx.store.path,
        readOnly: !ctx.allowWrites,
        body,
        commands: paletteFor(scope),
      }),
    );

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return json({ ok: true, readOnly: !ctx.allowWrites, ledger: ctx.store.path });
    }

    if (!authorized(req, url, ctx.token)) {
      return json(
        { error: "unauthorized", hint: "open the URL printed by `minima dashboard`" },
        401,
      );
    }

    // First hit carries the token in the query string — park it in a cookie and drop it from
    // the address bar so it stops leaking into history and Referer.
    if (url.searchParams.has("t")) {
      const clean = new URL(url.toString());
      clean.searchParams.delete("t");
      return new Response(null, {
        status: 302,
        headers: {
          location: `${clean.pathname}${clean.search}`,
          "set-cookie": `${COOKIE}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict`,
        },
      });
    }

    const scope = scopeOf(url);
    const now = Date.now() / 1000;

    if (req.method === "POST") {
      const match = /^\/api\/v1\/memories\/([^/]+)\/status$/.exec(path);
      if (!match) return json({ error: "not_found" }, 404);
      if (!ctx.allowWrites || !ctx.writeDb) {
        return json({ error: "read_only", hint: "restart with --allow-writes" }, 403);
      }
      if (!sameOrigin(req, url)) return json({ error: "cross_origin_denied" }, 403);

      const id = decodeURIComponent(match[1]!);
      const form = await req.formData().catch(() => null);
      const status = String(form?.get("status") ?? "");
      if (status !== "pinned" && status !== "active" && status !== "rejected") {
        return json({ error: "bad_status", allowed: ["pinned", "active", "rejected"] }, 400);
      }
      // Reuses the audited /memory path: appends a memory_events row, never a bare UPDATE.
      const changed = ctx.writeDb.setMemoryStatus(id, status, "dashboard");
      if (req.headers.get("accept")?.includes("text/html")) {
        return new Response(null, { status: 303, headers: { location: `/memory${url.search}` } });
      }
      return json({ ok: changed, id, status });
    }

    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    // ---- JSON contract (v1) ----
    if (path === "/api/v1/overview") return json(overview(ctx.store, scope));
    if (path === "/api/v1/projects") return json({ projects: ctx.store.projects() });
    if (path === "/api/v1/runs") return json({ runs: ctx.store.runs(scope, 200) });
    if (path === "/api/v1/decisions") return json({ decisions: ctx.store.decisions(scope, 500) });
    if (path === "/api/v1/plans") return json({ plans: ctx.store.plans(scope, 200) });
    if (path === "/api/v1/memories") return json({ memories: ctx.store.memories(scope, 200) });
    if (path === "/api/v1/budgets") return json({ budgets: ctx.store.budgets() });
    if (path === "/api/v1/sessions") {
      return json(sessionList(ctx.store.runs(scope, 200), now));
    }
    const apiPlan = /^\/api\/v1\/plans\/([^/]+)$/.exec(path);
    if (apiPlan) {
      const detail = ctx.store.planDetail(decodeURIComponent(apiPlan[1]!));
      return detail ? json(planView(detail)) : json({ error: "not_found" }, 404);
    }
    const apiRun = /^\/api\/v1\/runs\/([^/]+)$/.exec(path);
    if (apiRun) {
      const detail = ctx.store.runDetail(decodeURIComponent(apiRun[1]!));
      return detail ? json(detail) : json({ error: "not_found" }, 404);
    }
    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);

    // ---- HTML views ----
    if (path === "/") {
      return page(
        "/",
        scope,
        "Overview",
        overviewView(overview(ctx.store, scope), ctx.store.runs(scope, 10), now),
      );
    }
    if (path === "/routing") {
      return page(
        path,
        scope,
        "Routing",
        routingView(overview(ctx.store, scope), ctx.store.decisions(scope, 200), now),
      );
    }
    if (path === "/runs") {
      return page(
        path,
        scope,
        "Sessions",
        runsView(sessionList(ctx.store.runs(scope, 200), now), now),
      );
    }
    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const detail = ctx.store.runDetail(decodeURIComponent(runMatch[1]!));
      return detail
        ? page("/runs", scope, "Session", runView(detail, now))
        : page("/runs", scope, "Not found", notFoundView(path));
    }
    if (path === "/plans") {
      return page(
        path,
        scope,
        "Plans & gates",
        plansView(ctx.store.plans(scope, 200), overview(ctx.store, scope).gates, now),
      );
    }
    const planMatch = /^\/plans\/([^/]+)$/.exec(path);
    if (planMatch) {
      const detail = ctx.store.planDetail(decodeURIComponent(planMatch[1]!));
      return detail
        ? page("/plans", scope, detail.plan.title ?? "Plan", planDetailView(planView(detail), now))
        : page("/plans", scope, "Not found", notFoundView(path));
    }
    if (path === "/memory") {
      return page(
        path,
        scope,
        "Memory",
        memoryView(ctx.store.memories(scope, 200), now, ctx.allowWrites),
      );
    }
    if (path === "/cost") {
      return page(
        path,
        scope,
        "Cost",
        costView(overview(ctx.store, scope), ctx.store.budgets(), now),
      );
    }
    return page(path, scope, "Not found", notFoundView(path));
  };
}

/** Build a handler + its context against a ledger path. Throws LedgerUnavailableError. */
export function createDashboard(opts: DashboardOptions = {}): {
  handler: (req: Request) => Promise<Response>;
  ctx: Ctx;
} {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const store = new DashboardStore(dbPath);
  const ctx: Ctx = {
    store,
    writeDb: opts.allowWrites ? new MinimaDb(dbPath) : null,
    token: opts.token ?? crypto.randomUUID(),
    allowWrites: Boolean(opts.allowWrites),
  };
  return { handler: createHandler(ctx), ctx };
}

export function startDashboard(opts: DashboardOptions = {}): DashboardHandle {
  const { handler, ctx } = createDashboard(opts);
  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    fetch: handler,
  });
  const port = server.port ?? opts.port ?? DEFAULT_PORT;
  const base = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  return {
    url: `${base}/?t=${ctx.token}`,
    port,
    token: ctx.token,
    readOnly: !ctx.allowWrites,
    ledgerPath: ctx.store.path,
    stop() {
      server.stop(true);
      ctx.store.close();
      ctx.writeDb?.close();
    },
  };
}

export { LedgerUnavailableError };
