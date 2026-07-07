/**
 * linkbox — read-only stats endpoints.
 *
 *   GET /api/stats/links/top    most-clicked links (`?limit=`, default 5)
 *   GET /api/stats/tags         note tag usage counts
 *
 * All stats routes require the read scope.
 */

import type { RouteDef } from "../types.ts";
import type { Store } from "../store.ts";
import { json } from "../respond.ts";
import { parseBoundedInt } from "../validate.ts";

/** Dependencies injected by the app shell. */
export interface StatsDeps {
  store: Store;
}

/** Bounds for the top-links `limit` parameter. */
const TOP_LIMIT = { min: 1, max: 50, fallback: 5 };

/** Build the stats route table. */
export function statsRoutes({ store }: StatsDeps): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: "/api/stats/links/top",
      scope: "read",
      handler: (req) => {
        const limit = parseBoundedInt(req.query.limit, TOP_LIMIT);
        if (limit === null) return json(400, { error: "invalid_limit" });
        return json(200, { items: store.topLinks(limit) });
      },
    },
    {
      method: "GET",
      pattern: "/api/stats/tags",
      scope: "read",
      handler: () => {
        return json(200, { items: store.tagCounts() });
      },
    },
  ];
}
