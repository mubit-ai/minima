/**
 * The localhost dashboard server — `minima dashboard`.
 *
 * Security posture (a dev tool that reads your whole work history is worth locking down):
 *  - binds 127.0.0.1 by default, never 0.0.0.0;
 *  - every route except /healthz requires a per-process bearer token, handed over once in
 *    the printed URL (`?t=…`) and then parked in a Strict/HttpOnly cookie;
 *  - the token is compared in constant time, so a wrong guess leaks no timing signal;
 *  - READ-ONLY, structurally: the SQLite handle is opened `readonly` and this module does not
 *    import MinimaDb at all, so there is no code path that could open a writable handle. The
 *    only non-GET route is `/api/v1/open`, which touches the editor, never the ledger;
 *  - that route additionally requires a same-origin request, so a page in another tab cannot
 *    drive it with a cross-site POST.
 *
 * The HTML views and the JSON API are built from the SAME payloads (`stats.ts`), so the
 * `/api/v1/*` contract is a real contract — a future SPA can consume it without the server
 * growing a second data path.
 */

import { defaultDbPath } from "../db/minima_db.ts";
import { detectEditor, openInEditor, readRecorded, resolveRecorded } from "./files.ts";
import { DashboardStore, LedgerUnavailableError, type Scope } from "./queries.ts";
import {
  type NavItem,
  type PaletteItem,
  costView,
  fileView,
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

/**
 * How often the shared poller asks the ledger whether anything happened. SQLite has no change
 * notification for a separate readonly process, so this is a poll — but ONE poll for the whole
 * process, not one per browser tab, which is the difference between flat memory and a leak.
 *
 * 2s is already far finer than the data's own resolution (events land at turn boundaries; p95
 * inter-event gap is 34s), so polling faster would only burn CPU to learn nothing sooner.
 */
const POLL_MS = 2_000;
/** Hard ceiling on concurrent streams; a browser opening tabs must not become unbounded state. */
export const MAX_STREAMS = 8;
/**
 * A stream that has said nothing for this long gets a keepalive frame.
 *
 * Without it a quiet ledger means a silent socket, and Bun closes an idle connection at its
 * `idleTimeout` (10s by default) — which is exactly how this shipped: warning in the terminal,
 * client reconnect, repeat, forever. Raising the timeout alone only moves the disconnect later,
 * so the stream has to stop being idle. It rides the poller that already exists, so this costs
 * no extra timer, and it is how an abandoned stream (a slept laptop never fires `cancel()`) is
 * finally noticed and evicted from the MAX_STREAMS cap.
 */
const KEEPALIVE_MS = 20_000;
/** Passed to `Bun.serve`; must stay comfortably above KEEPALIVE_MS. */
export const IDLE_TIMEOUT_S = 60;
/**
 * A hard lifetime cap per stream — set once when the stream opens and never reset, so a
 * forgotten tab cannot pin memory indefinitely. The browser reconnects, so it is invisible
 * in use.
 */
const STREAM_MAX_MS = 30 * 60 * 1_000;

/** `activity` = the newest event timestamp moved. `ping` = nothing happened, still alive. */
export type ActivityKind = "activity" | "ping";

/**
 * One poller, many subscribers.
 *
 * Starts on the first subscriber and STOPS on the last — an idle dashboard runs no timer at all.
 * The broadcast payload is deliberately tiny (the newest event timestamp): the client decides
 * whether that warrants re-fetching, and no event history is accumulated anywhere.
 */
export class ActivityHub {
  private readonly subscribers = new Set<(newest: number | null, kind: ActivityKind) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: number | null = null;
  private quietMs = 0;
  private readonly pollMs: number;
  private readonly keepaliveMs: number;

  constructor(
    private readonly newestOf: () => number | null,
    opts: { pollMs?: number; keepaliveMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
  }

  get size(): number {
    return this.subscribers.size;
  }

  subscribe(fn: (newest: number | null, kind: ActivityKind) => void): (() => void) | null {
    if (this.subscribers.size >= MAX_STREAMS) return null;
    this.subscribers.add(fn);
    if (!this.timer) {
      this.last = this.newestOf();
      this.quietMs = 0;
      this.timer = setInterval(() => this.tick(), this.pollMs);
      // Never hold the process open just to poll.
      this.timer.unref?.();
    }
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private tick(): void {
    const newest = this.newestOf();
    const changed = newest !== this.last;
    this.quietMs += this.pollMs;
    if (!changed && this.quietMs < this.keepaliveMs) return;
    this.last = newest;
    this.quietMs = 0;
    const kind: ActivityKind = changed ? "activity" : "ping";
    for (const fn of [...this.subscribers]) {
      try {
        fn(newest, kind);
      } catch {
        // A dead stream must not take the poller down with it.
        this.subscribers.delete(fn);
      }
    }
  }

  stop(): void {
    this.subscribers.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface DashboardOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  token?: string;
  /** Editor command for the jump-to-source button; null/"none" disables the endpoint. */
  editor?: string | null;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  /** Always true. Kept in the contract so a caller learns the posture without reading this file. */
  readOnly: true;
  ledgerPath: string;
  /** The editor the jump-to-source button will launch, or null when none is available. */
  editor: string | null;
  stop(): void;
}

interface Ctx {
  store: DashboardStore;
  token: string;
  /** Resolved editor command, or null when none was found or `--editor none` was passed. */
  editor: string | null;
  hub: ActivityHub;
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

  const page = (
    path: string,
    scope: Scope,
    title: string,
    body: string,
    opts: { projectFilter?: boolean } = {},
  ): Response =>
    html(
      shell({
        title,
        nav: navFor(path, scope),
        projects: ctx.store.projects(),
        scope,
        ledgerPath: ctx.store.path,
        body,
        commands: paletteFor(scope),
        projectFilter: opts.projectFilter,
      }),
    );

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return json({ ok: true, readOnly: true, ledger: ctx.store.path });
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

    // The one non-GET route in the server, and it touches the editor rather than the ledger.
    // POST + token + same-origin, so no cross-site page can drive it and it never lands in
    // browser history. The guard that matters is that `path` is a LEDGER ROW REFERENCE — the
    // spawn only ever receives a path the server resolved itself, via an argv array that is
    // never a shell string.
    if (req.method === "POST" && path === "/api/v1/open") {
      if (!sameOrigin(req, url)) return json({ error: "cross_origin" }, 403);
      if (!ctx.editor) return json({ ok: false, error: "no_editor" }, 403);
      const body = (await req.json().catch(() => null)) as {
        plan?: string;
        path?: string;
        line?: string | number | null;
      } | null;
      if (!body?.plan || !body?.path) return json({ error: "bad_request" }, 400);
      const row = ctx.store.recordedFile(body.plan, body.path);
      if (!row) return json({ error: "not_found" }, 404);
      const resolved = resolveRecorded(row.project_key, row.path);
      if (!resolved) return json({ ok: false, error: "unresolvable" }, 409);
      const parsed = Number.parseInt(String(body.line ?? ""), 10);
      const line = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      const result = await openInEditor(ctx.editor, resolved, line);
      return json(result, result.ok ? 200 : 500);
    }

    if (req.method !== "GET") return json({ error: "not_found" }, 404);

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
    if (path === "/api/v1/file") {
      const planId = url.searchParams.get("plan");
      const wanted = url.searchParams.get("path");
      if (!planId || !wanted) return json({ error: "bad_request" }, 400);
      const row = ctx.store.recordedFile(planId, wanted);
      if (!row) return json({ error: "not_found" }, 404);
      return json(await readRecorded(row.project_key, row.path));
    }
    if (path === "/api/v1/stream") {
      let release: (() => void) | null = null;
      let idle: ReturnType<typeof setTimeout> | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // A keepalive is its OWN event type. Re-sending `activity` when nothing happened
          // would put a frame on the wire that says the opposite of what the payload means.
          const send = (newest: number | null, kind: ActivityKind = "activity"): void => {
            const data = kind === "activity" ? JSON.stringify({ newest }) : "{}";
            controller.enqueue(enc.encode(`event: ${kind}\ndata: ${data}\n\n`));
          };
          send(ctx.store.newestEvent());
          release = ctx.hub.subscribe(send);
          if (!release) {
            controller.enqueue(enc.encode('event: full\ndata: {"error":"too_many_streams"}\n\n'));
            controller.close();
            return;
          }
          idle = setTimeout(() => {
            release?.();
            release = null;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }, STREAM_MAX_MS);
          idle.unref?.();
        },
        cancel() {
          release?.();
          release = null;
          if (idle) clearTimeout(idle);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
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
      // No project filter here: a plan belongs to exactly one project, so the control could only
      // ever reload the same page. The scope itself is NOT dropped — it stays in the URL and on
      // every nav link, so returning to a scoped list still works.
      const unscoped = { projectFilter: false };
      return detail
        ? page(
            "/plans",
            scope,
            detail.plan.title ?? "Plan",
            planDetailView(planView(detail), now),
            unscoped,
          )
        : page("/plans", scope, "Not found", notFoundView(path), unscoped);
    }
    if (path === "/files") {
      const planId = url.searchParams.get("plan");
      const wanted = url.searchParams.get("path");
      const row = planId && wanted ? ctx.store.recordedFile(planId, wanted) : null;
      if (!planId || !row) return page("/plans", scope, "Not found", notFoundView(path));
      const detail = ctx.store.planDetail(planId);
      return page(
        "/plans",
        scope,
        row.path,
        fileView(
          await readRecorded(row.project_key, row.path),
          planId,
          detail?.plan.title ?? planId.slice(0, 8),
          ctx.editor,
        ),
      );
    }
    if (path === "/memory") {
      return page(path, scope, "Memory", memoryView(ctx.store.memories(scope, 200), now));
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
    token: opts.token ?? crypto.randomUUID(),
    editor: detectEditor(opts.editor),
    hub: new ActivityHub(() => store.newestEvent()),
  };
  return { handler: createHandler(ctx), ctx };
}

export function startDashboard(opts: DashboardOptions = {}): DashboardHandle {
  const { handler, ctx } = createDashboard(opts);
  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    // Bun's default is 10s, which silently killed every SSE stream on a quiet ledger. The
    // keepalive above is what actually keeps a stream alive; this is the backstop.
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: handler,
  });
  const port = server.port ?? opts.port ?? DEFAULT_PORT;
  const base = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  return {
    url: `${base}/?t=${ctx.token}`,
    port,
    token: ctx.token,
    readOnly: true,
    ledgerPath: ctx.store.path,
    editor: ctx.editor,
    stop() {
      server.stop(true);
      ctx.hub.stop();
      ctx.store.close();
    },
  };
}

export { LedgerUnavailableError };
