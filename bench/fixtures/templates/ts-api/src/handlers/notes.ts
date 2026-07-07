/**
 * linkbox — note endpoints.
 *
 *   POST   /api/notes        create a note (write scope)
 *   GET    /api/notes        list notes, optionally `?tag=` filtered (read)
 *   GET    /api/notes/:id    fetch one note (read scope)
 *   DELETE /api/notes/:id    delete a note (write scope)
 */

import type { RouteDef } from "../types.ts";
import type { Store } from "../store.ts";
import { json, noContent } from "../respond.ts";
import { isValidTag, validateNoteCreate } from "../validate.ts";

/** Dependencies injected by the app shell. */
export interface NoteDeps {
  store: Store;
}

/** Build the note route table. */
export function noteRoutes({ store }: NoteDeps): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: "/api/notes",
      scope: "write",
      handler: (req) => {
        const parsed = validateNoteCreate(req.body);
        if (!parsed.ok) return json(400, { error: "invalid_note", details: parsed.errors });
        const record = store.createNote(parsed.value);
        return json(201, record);
      },
    },
    {
      method: "GET",
      pattern: "/api/notes",
      scope: "read",
      handler: (req) => {
        const tag = req.query.tag;
        if (tag !== undefined && !isValidTag(tag)) {
          return json(400, { error: "invalid_tag" });
        }
        const items = store.listNotes({ tag });
        return json(200, { items, total: items.length });
      },
    },
    {
      method: "GET",
      pattern: "/api/notes/:id",
      scope: "read",
      handler: (_req, ctx) => {
        const record = store.getNote(ctx.params.id!);
        if (record === undefined) return json(404, { error: "not_found" });
        return json(200, record);
      },
    },
    {
      method: "DELETE",
      pattern: "/api/notes/:id",
      scope: "write",
      handler: (_req, ctx) => {
        if (!store.deleteNote(ctx.params.id!)) return json(404, { error: "not_found" });
        return noContent();
      },
    },
  ];
}
