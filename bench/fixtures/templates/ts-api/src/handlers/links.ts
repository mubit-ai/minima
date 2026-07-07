/**
 * linkbox — link endpoints.
 *
 *   POST   /api/links          create a link (write scope)
 *   GET    /api/links          list links, paginated (read scope)
 *   GET    /api/links/:slug    fetch one link (read scope)
 *   PATCH  /api/links/:slug    update url and/or rename slug (write scope)
 *   DELETE /api/links/:slug    delete a link (write scope)
 *   GET    /r/:slug            public redirect; counts a click; rate limited
 *
 * Link JSON returned to clients is the stored record plus a `clicks` field
 * joined in from the click ledger.
 */

import type { LinkRecord, RouteDef } from "../types.ts";
import type { Store } from "../store.ts";
import { ConflictError } from "../errors.ts";
import { json, noContent, redirect } from "../respond.ts";
import { parsePagination, validateLinkCreate, validateLinkUpdate } from "../validate.ts";

/** Dependencies injected by the app shell. */
export interface LinkDeps {
  store: Store;
}

/** Client-facing view of a link: the record plus its click count. */
function linkView(store: Store, record: LinkRecord): Record<string, unknown> {
  return { ...record, clicks: store.getClicks(record.slug) };
}

/** Build the link route table. */
export function linkRoutes({ store }: LinkDeps): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: "/api/links",
      scope: "write",
      handler: (req) => {
        const parsed = validateLinkCreate(req.body);
        if (!parsed.ok) return json(400, { error: "invalid_link", details: parsed.errors });
        try {
          const record = store.createLink(parsed.value);
          return json(201, linkView(store, record));
        } catch (err) {
          if (err instanceof ConflictError) return json(409, { error: "slug_taken" });
          throw err;
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/links",
      scope: "read",
      handler: (req) => {
        const page = parsePagination(req.query);
        if (!page.ok) return json(400, { error: "invalid_pagination", details: page.errors });
        const { items, total } = store.listLinks(page.value);
        return json(200, {
          items: items.map((record) => linkView(store, record)),
          total,
          limit: page.value.limit,
          offset: page.value.offset,
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/links/:slug",
      scope: "read",
      handler: (_req, ctx) => {
        const record = store.getLinkBySlug(ctx.params.slug!);
        if (record === undefined) return json(404, { error: "not_found" });
        return json(200, linkView(store, record));
      },
    },
    {
      method: "PATCH",
      pattern: "/api/links/:slug",
      scope: "write",
      handler: (req, ctx) => {
        const parsed = validateLinkUpdate(req.body);
        if (!parsed.ok) return json(400, { error: "invalid_update", details: parsed.errors });
        try {
          const record = store.updateLink(ctx.params.slug!, parsed.value);
          if (record === undefined) return json(404, { error: "not_found" });
          return json(200, linkView(store, record));
        } catch (err) {
          if (err instanceof ConflictError) return json(409, { error: "slug_taken" });
          throw err;
        }
      },
    },
    {
      method: "DELETE",
      pattern: "/api/links/:slug",
      scope: "write",
      handler: (_req, ctx) => {
        if (!store.deleteLink(ctx.params.slug!)) return json(404, { error: "not_found" });
        return noContent();
      },
    },
    {
      method: "GET",
      pattern: "/r/:slug",
      rateLimited: true,
      handler: (_req, ctx) => {
        const record = store.getLinkBySlug(ctx.params.slug!);
        if (record === undefined) return json(404, { error: "not_found" });
        store.recordClick(record.slug);
        return redirect(record.url);
      },
    },
  ];
}
