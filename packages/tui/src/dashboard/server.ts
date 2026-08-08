/**
 * The localhost dashboard server — `minima dashboard`.
 *
 * Security posture (a dev tool that reads your whole work history is worth locking down):
 *  - binds 127.0.0.1 by default, never 0.0.0.0;
 *  - every route except /healthz requires a per-process bearer token, handed over once in
 *    the printed URL (`?t=…`) and then parked in a Strict/HttpOnly cookie. `?k=…` accepts a
 *    short-lived HMAC ticket instead, for the auto-started server whose URL is printed into a
 *    TUI transcript rather than a terminal the user owns (see ./auth.ts);
 *  - the token is compared in constant time, so a wrong guess leaks no timing signal;
 *  - that token is NOT a read-only credential: it reads the entire ledger and it can spawn the
 *    configured editor via /api/v1/open. `sameOrigin` below constrains browsers, not clients that
 *    simply omit the header;
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
import { constantTimeEqual, ticketValid } from "./auth.ts";
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
/** Hard ceiling on concurrent BROWSER streams; a browser opening tabs must not become unbounded
 * state. Attached TUIs are counted separately (MAX_CLIENTS) so eight tabs cannot starve a TUI of
 * the connection its own liveness depends on, and vice versa. */
export const MAX_STREAMS = 8;
/** Hard ceiling on attached TUIs. Higher than anyone runs; it exists to bound the registry. */
export const MAX_CLIENTS = 16;
/**
 * How long the managed server tolerates having no attached TUI before it exits.
 *
 * Long enough to ride out a Ctrl+C-then-relaunch or a `/new`, short enough that a closed laptop
 * lid does not leave a server running all afternoon. Erring short is safe: the TUI re-attaches,
 * and re-attaching respawns.
 */
export const GRACE_MS = 10_000;
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
  private readonly counted = new Set<(newest: number | null, kind: ActivityKind) => void>();
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

  /** Only browser streams count against MAX_STREAMS. */
  get streamCount(): number {
    return this.counted.size;
  }

  /**
   * `counted: false` opts out of the MAX_STREAMS cap — used by the attach registry, which needs the
   * same keepalive pump but must not compete with browser tabs for it.
   */
  subscribe(
    fn: (newest: number | null, kind: ActivityKind) => void,
    opts: { counted?: boolean } = {},
  ): (() => void) | null {
    const counted = opts.counted !== false;
    if (counted && this.counted.size >= MAX_STREAMS) return null;
    if (counted) this.counted.add(fn);
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
      this.counted.delete(fn);
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
    this.counted.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Who is still using this server, and therefore whether it should still exist.
 *
 * The pid is the identity and the socket is only a fast path. Socket close covers every ordinary
 * death — clean exit, `kill -9`, SIGHUP, an OOM kill — but NOT a background job that inherited the
 * fd and outlived its parent, where the connection stays open with nobody behind it. So `prune()`
 * runs on the poll tick that already exists and drops a client whose pid is gone even when its
 * socket is not, and the pid wins over the socket whenever they disagree.
 *
 * That pair makes an immortal server unlikely, not impossible: a pid reused inside the grace window
 * still reads as alive. Which is why `onIdle` is allowed to fire eagerly — the TUI re-establishes,
 * so a wrong exit costs one respawn while a missed exit costs a server nobody can see.
 */
export class ClientRegistry {
  private readonly clients = new Map<number, { seq: number; close: () => void }>();
  private seq = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly hub: ActivityHub,
    private readonly opts: {
      graceMs: number;
      maxClients: number;
      onIdle: () => void;
      alive?: (pid: number) => boolean;
    },
  ) {
    // Armed from birth: a managed server nobody ever attaches to must still go away.
    this.armIfEmpty();
  }

  get size(): number {
    return this.clients.size;
  }

  pids(): number[] {
    return [...this.clients.keys()];
  }

  /**
   * A second attach from the same pid replaces the first: a TUI whose stream broke and retried is
   * still one client, and keying on pid makes that structural rather than a cleanup race.
   */
  add(pid: number, close: () => void): number | null {
    if (!this.clients.has(pid) && this.clients.size >= this.opts.maxClients) return null;
    this.clients.get(pid)?.close();
    this.seq += 1;
    this.clients.set(pid, { seq: this.seq, close });
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.hub.subscribe(() => this.prune(), { counted: false });
    }
    return this.seq;
  }

  /** Seq-guarded so a late close from a replaced attach cannot evict the live one. */
  remove(pid: number, seq: number): void {
    if (this.clients.get(pid)?.seq !== seq) return;
    this.clients.delete(pid);
    this.armIfEmpty();
  }

  prune(): void {
    const alive = this.opts.alive ?? defaultPidAlive;
    for (const [pid, entry] of [...this.clients]) {
      if (alive(pid)) continue;
      this.clients.delete(pid);
      // The socket may still be open — held by something that inherited it. Close our end.
      try {
        entry.close();
      } catch {
        // a dead stream must not take the poller down
      }
    }
    this.armIfEmpty();
  }

  private armIfEmpty(): void {
    if (this.clients.size > 0 || this.idle) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.clients.size === 0) this.opts.onIdle();
    }, this.opts.graceMs);
    this.idle.unref?.();
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const entry of this.clients.values()) {
      try {
        entry.close();
      } catch {
        // shutting down
      }
    }
    this.clients.clear();
  }
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    return (exc as { code?: string }).code === "EPERM";
  }
}

export interface DashboardOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  token?: string;
  /** Editor command for the jump-to-source button; null/"none" disables the endpoint. */
  editor?: string | null;
  /** Zero-attached-client grace before `onIdle`. Overridden by tests to make 10s a few ms. */
  graceMs?: number;
  maxClients?: number;
  pollMs?: number;
  keepaliveMs?: number;
  /**
   * Fired when the last attached TUI has been gone for `graceMs`. The MANAGED server uses this to
   * clear its rendezvous and exit; a foreground `minima dashboard` leaves it unset and lives until
   * Ctrl+C.
   */
  onIdle?: () => void;
  /** Liveness probe override (tests). Real one is `process.kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  /** Reported by /healthz so `/dashboard` can explain a non-default port. */
  portNote?: string | null;
  startedAt?: number;
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
  /** Currently attached TUIs. */
  clients(): number;
  stop(): void;
}

interface Ctx {
  store: DashboardStore;
  token: string;
  /** Resolved editor command, or null when none was found or `--editor none` was passed. */
  editor: string | null;
  hub: ActivityHub;
  clients: ClientRegistry;
  startedAt: number;
  portNote: string | null;
}

const NAV: { path: string; label: string }[] = [
  { path: "/", label: "Overview" },
  { path: "/routing", label: "Routing" },
  { path: "/runs", label: "Sessions" },
  { path: "/plans", label: "Plans & gates" },
  { path: "/memory", label: "Memory" },
  { path: "/cost", label: "Cost" },
];

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
  const ticket = url.searchParams.get("k");
  if (ticket !== null && ticketValid(token, ticket)) return true;
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

  // Detail views drop the project filter: a session, a plan, and a recorded file each belong to
  // exactly one project, so the control could only ever reload the same page. The scope itself is
  // NOT dropped — it stays in the URL and on every nav link, so returning to a scoped list works.
  const unscoped = { projectFilter: false };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // The discovery primitive: unauthenticated on purpose, because a TUI has to be able to ask
    // "is the thing on this port MY dashboard" before it holds a token worth using. It reports the
    // ledger it serves (the only field that makes the rendezvous file trustworthy), plus the client
    // count and pid that `/dashboard` prints — none of it beyond what `ps` already shows.
    if (path === "/healthz") {
      return json({
        ok: true,
        readOnly: true,
        ledger: ctx.store.path,
        clients: ctx.clients.size,
        pid: process.pid,
        startedAt: ctx.startedAt,
        portNote: ctx.portNote,
      });
    }

    if (!authorized(req, url, ctx.token)) {
      return json(
        { error: "unauthorized", hint: "open the URL printed by `minima dashboard`" },
        401,
      );
    }

    // First hit carries the token (`t`) or a ticket (`k`) in the query string — park the durable
    // token in a cookie and drop the credential from the address bar so it stops leaking into
    // history and Referer. Redeeming a ticket for the cookie is what lets the printed link expire
    // without the browser session expiring with it.
    if (url.searchParams.has("t") || url.searchParams.has("k")) {
      const clean = new URL(url.toString());
      clean.searchParams.delete("t");
      clean.searchParams.delete("k");
      return new Response(null, {
        status: 302,
        headers: {
          location: `${clean.pathname}${clean.search}`,
          "set-cookie": `${COOKIE}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict`,
        },
      });
    }

    const scope = scopeOf(url);
    // Which model the savings tile is anchored to. Validated against the ledger's own models in
    // `overview()`, so an arbitrary string falls back to the default instead of rendering a tile
    // for a model that was never a candidate.
    const anchor = url.searchParams.get("anchor");
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
    if (path === "/api/v1/overview") return json(overview(ctx.store, scope, anchor));
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
    // The refcount. A TUI holds this open for its whole life; the kernel closing it is what tells
    // this server the TUI is gone. It rides the SAME keepalive as the browser stream — a stream that
    // says nothing is closed by Bun at `idleTimeout`, which would have dropped every client at 60s
    // and taken the server down under three live TUIs.
    if (path === "/attach") {
      const pid = Number.parseInt(url.searchParams.get("pid") ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 1) return json({ error: "bad_pid" }, 400);
      let seq: number | null = null;
      let release: (() => void) | null = null;
      let closed = false;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const shut = (): void => {
            if (closed) return;
            closed = true;
            release?.();
            release = null;
            try {
              controller.close();
            } catch {
              // already closed
            }
          };
          seq = ctx.clients.add(pid, shut);
          if (seq === null) {
            controller.enqueue(enc.encode('{"error":"too_many_clients"}\n'));
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(`{"attached":${pid}}\n`));
          release = ctx.hub.subscribe(
            () => {
              try {
                controller.enqueue(enc.encode("\n"));
              } catch {
                shut();
              }
            },
            { counted: false },
          );
        },
        cancel() {
          closed = true;
          release?.();
          release = null;
          if (seq !== null) ctx.clients.remove(pid, seq);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
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
        overviewView(overview(ctx.store, scope, anchor), ctx.store.runs(scope, 10), now),
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
        ? page("/runs", scope, "Session", runView(detail, now), unscoped)
        : page("/runs", scope, "Not found", notFoundView(path), unscoped);
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
      if (!planId || !row) return page("/plans", scope, "Not found", notFoundView(path), unscoped);
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
        unscoped,
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
        costView(overview(ctx.store, scope, anchor), ctx.store.budgets(), now),
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
  const hub = new ActivityHub(() => store.newestEvent(), {
    pollMs: opts.pollMs,
    keepaliveMs: opts.keepaliveMs,
  });
  const ctx: Ctx = {
    store,
    token: opts.token ?? crypto.randomUUID(),
    editor: detectEditor(opts.editor),
    hub,
    clients: new ClientRegistry(hub, {
      graceMs: opts.graceMs ?? GRACE_MS,
      maxClients: opts.maxClients ?? MAX_CLIENTS,
      onIdle: opts.onIdle ?? (() => {}),
      ...(opts.alive ? { alive: opts.alive } : {}),
    }),
    startedAt: opts.startedAt ?? Date.now(),
    portNote: opts.portNote ?? null,
  };
  return { handler: createHandler(ctx), ctx };
}

export function startDashboard(opts: DashboardOptions = {}): DashboardHandle {
  const { handler, ctx } = createDashboard(opts);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: opts.host ?? "127.0.0.1",
      port: opts.port ?? DEFAULT_PORT,
      // Bun's default is 10s, which silently killed every SSE stream on a quiet ledger. The
      // keepalive above is what actually keeps a stream alive; this is the backstop.
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: handler,
    });
  } catch (exc) {
    // A failed bind must leave NOTHING behind. `createDashboard` has already opened a readonly
    // SQLite handle and armed the client registry's idle timer — and that timer's `onIdle` shuts the
    // whole process down. A caller that walks a port range (every auto-start on a machine where
    // 4180 is taken) would therefore inherit, from each port it skipped, a live 10-second fuse that
    // saw zero clients of its own and killed a perfectly healthy server. Observed as the dashboard
    // exiting every ~10s forever with three TUIs still attached.
    ctx.clients.stop();
    ctx.hub.stop();
    ctx.store.close();
    throw exc;
  }
  const port = server.port ?? opts.port ?? DEFAULT_PORT;
  const base = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  return {
    url: `${base}/?t=${ctx.token}`,
    port,
    token: ctx.token,
    readOnly: true,
    ledgerPath: ctx.store.path,
    editor: ctx.editor,
    clients: () => ctx.clients.size,
    stop() {
      server.stop(true);
      ctx.clients.stop();
      ctx.hub.stop();
      ctx.store.close();
    },
  };
}

export { LedgerUnavailableError };
