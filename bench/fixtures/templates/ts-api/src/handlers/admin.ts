/**
 * linkbox — admin endpoints (admin scope required).
 *
 *   POST /api/admin/snapshot   capture the full dataset as a JSON snapshot
 *   POST /api/admin/restore    replace the full dataset from a snapshot body
 *
 * Restore also clears the rate limiter: restored traffic patterns have no
 * relationship to whatever windows were open before.
 */

import type { RouteDef } from "../types.ts";
import type { Store } from "../store.ts";
import type { FixedWindowLimiter } from "../ratelimit.ts";
import { SnapshotError } from "../errors.ts";
import { json } from "../respond.ts";
import { restoreSnapshot, takeSnapshot } from "../persist.ts";

/** Dependencies injected by the app shell. */
export interface AdminDeps {
  store: Store;
  limiter: FixedWindowLimiter;
}

/** Build the admin route table. */
export function adminRoutes({ store, limiter }: AdminDeps): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: "/api/admin/snapshot",
      scope: "admin",
      handler: (_req, ctx) => {
        return json(200, takeSnapshot(store, ctx.now()));
      },
    },
    {
      method: "POST",
      pattern: "/api/admin/restore",
      scope: "admin",
      handler: (req) => {
        try {
          const restored = restoreSnapshot(store, req.body);
          limiter.reset();
          return json(200, { restored });
        } catch (err) {
          if (err instanceof SnapshotError) {
            return json(400, { error: "invalid_snapshot", detail: err.message });
          }
          throw err;
        }
      },
    },
  ];
}
