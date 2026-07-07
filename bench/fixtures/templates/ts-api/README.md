# linkbox

A small self-contained HTTP API service for short links and notes, written in
TypeScript with zero runtime dependencies (Bun's built-in tooling only).

The service is transport-agnostic: handlers are plain functions over
`ApiRequest` → `ApiResponse` values (see `src/types.ts`), so the whole API is
unit-testable in-process. A deployment binds `createApp().handle` to a socket
with a ~20-line adapter.

## Endpoints

| Route                      | Scope | Description                                |
| -------------------------- | ----- | ------------------------------------------ |
| `GET /api/health`          | —     | liveness + uptime                          |
| `POST /api/links`          | write | create a short link (optional custom slug) |
| `GET /api/links`           | read  | list links (paginated, slug order)         |
| `GET /api/links/:slug`     | read  | fetch one link with click count            |
| `PATCH /api/links/:slug`   | write | change destination url and/or rename slug  |
| `DELETE /api/links/:slug`  | write | delete a link                              |
| `GET /r/:slug`             | —     | public redirect; rate limited per client   |
| `POST /api/notes`          | write | create a note                              |
| `GET /api/notes`           | read  | list notes (`?tag=` filter)                |
| `GET /api/notes/:id`       | read  | fetch one note                             |
| `DELETE /api/notes/:id`    | write | delete a note                              |
| `GET /api/stats/links/top` | read  | most-clicked links                         |
| `GET /api/stats/tags`      | read  | note tag usage counts                      |
| `POST /api/admin/snapshot` | admin | export the dataset as a JSON snapshot      |
| `POST /api/admin/restore`  | admin | replace the dataset from a snapshot        |

Authentication is `Authorization: Bearer <token>` against a configurable
token registry; tokens carry `read` / `write` / `admin` scopes.

## Development

```sh
bun test tests/
```

The clock, token registry, rate-limit policy and slug-generator seed are all
injectable through `createApp(options)`, which keeps every test deterministic.
