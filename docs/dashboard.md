# Localhost dashboard (`minima dashboard`)

A local web view over the harness ledger — visualizations, statistics, and (eventually) some
control, in the spirit of an agent-platform console but for a CLI-first harness.

**Status: draft / skeleton.** Every view below is real and reads real rows. The point of this
first pass is to fix the architecture, the honesty rules, and the security posture *before*
the surface grows. Read this before adding features.

```bash
minima dashboard                     # http://127.0.0.1:4180, read-only
minima dashboard --port 4181 --open  # pick a port, open a browser
minima dashboard --allow-writes      # enable the one audited write control
minima dashboard --db /path/to.db    # read a specific ledger
```

## Why it reads the harness ledger, not the service

The Minima service is **recommend-only and stateless** — it holds no session history to plot.
Everything worth visualizing (`route → run → judge → feedback`, plan gates, budgets, curated
memory) already lands in the harness's SQLite spine at `~/.minima-harness/minima.db`. So the
dashboard is a **read model over that ledger** and lives in `packages/tui/src/dashboard/`,
shipping inside the same compiled `minima` binary. No new service, no new datastore, no new
toolchain.

## Layout

| File | Job |
|---|---|
| `queries.ts` | Every SQL statement. Opens its own `readonly` handle. Project-scopable. |
| `stats.ts` | All aggregation → the `/api/v1/*` payloads. Pure functions over row arrays. |
| `charts.ts` | Server-rendered SVG primitives + the table counterpart. |
| `render.ts` | Page shell, CSS custom properties, one function per view. |
| `server.ts` | `Bun.serve`, auth, routing, the write seam. `createHandler` is test-callable. |
| `index.ts` | Public surface; imported lazily so normal TUI startup doesn't pay for it. |

The HTML views and the JSON API are built from the **same** payloads, so `/api/v1/*` is a real
contract rather than an afterthought — a React SPA can be dropped on top later without the
server growing a second data path.

## Views

- **Overview** — stat tiles (spend, savings, quality-per-dollar, optimal-cost ratio, gate green
  rate), realized spend per day, decisions by model, gate tiers, task-type × model scoreboard.
- **Routing** — model mix with cost/call, avg quality (judged rows only), avg latency; recent
  decisions with basis, outcome, and quality.
- **Sessions** — every run with decisions, spend, tool calls/errors; drill into one session for
  its decisions, tool usage, and plans.
- **Plans & gates** — plan progress and gate tier distribution.
- **Memory** — the curated memory ledger with origin and evidence source.
- **Cost** — spend over time plus the budget ledger (limit / spent / reserved / mode).

## Honesty rules (do not "improve" these)

A dashboard that disagrees with the TUI is worse than no dashboard. `stats.ts` mirrors `/cost`
and `taskTypeScoreboard` exactly:

- **Quality-per-dollar over judged rows only.** Abstentions are excluded, never counted as
  zero. Coverage (`47/489`) is always shown next to the number.
- **Savings never conflates its two anchors.** "vs all-premium" is the generous anchor; "vs
  configured baseline" is the honest one. They are separate tiles and never summed. Savings can
  be **negative** — the tile then says *overspent this anchor by …* rather than showing a bare
  minus sign under a label that reads "Saved".
- **Green means a deterministic gate said green.** A judge's green is not a green.
- **Cells under `SCOREBOARD_MIN_N` (3) are suppressed**, not rendered as weak signal.
- **No coverage → "no data"**, never `0`. A fabricated zero reads as a real measurement.
- Every derived rate ships the n it was computed from.

## Security posture

A dev tool that renders your entire work history deserves locking down:

- binds `127.0.0.1` by default (`--host` to override, deliberately explicit);
- every route except `/healthz` needs a per-process token, handed over once in the printed URL
  (`?t=…`), then parked in a `HttpOnly; SameSite=Strict` cookie and dropped from the address
  bar so it stops leaking into history and `Referer`;
- the token is compared in **constant time**;
- **read-only by default** — the SQLite handle is opened `readonly`, so no route can write even
  if it tried, and opening the dashboard never creates a ledger file;
- all ledger text is HTML-escaped on the way out (there is a test that tries to inject a
  `<script>` through a memory row);
- the write endpoint additionally requires a **same-origin** request, so another tab cannot
  drive it with a cross-site form POST.

## The write seam

Exactly one endpoint writes, and only under `--allow-writes`:

```
POST /api/v1/memories/:id/status   status=pinned|active|rejected
```

It delegates to `MinimaDb.setMemoryStatus`, the same audited path `/memory` uses, so every
change appends a `memory_events` row (`pin by dashboard`) instead of doing a bare `UPDATE`.
Delete is **not** exposed. This exists to prove the pattern — auth + same-origin + an audited
ledger call + a `403` when writes are off — so the controls added next have a shape to copy.

## Deliberately not built yet

The next decision is **how much control** the browser should get. Ranked by cost:

1. **Safe ledger writes** (small): budget cap + mode changes, routing-profile switching,
   remaining `/memory` operations. All are already user-owned state; each needs the same
   audited-call + gated-endpoint shape as the write seam.
2. **Live-run control** (large): abort/steer an in-flight run, approve a plan step from the
   browser. The dashboard is a *separate process* from the running TUI, so this needs a real
   IPC channel (a unix socket or a `bg_jobs`-style command table the harness polls) plus a
   decision about what happens when two clients steer at once. This is where a "give the user
   control" feature actually gets designed — not a UI problem.
3. **Streaming** (medium): replace the 10s meta-refresh with SSE over the `events` table so a
   running session updates live.

Other known gaps: charts hover via native SVG `<title>` (a real crosshair/tooltip layer is a
follow-up); no date-range filter yet (scope is project-only); `spendByDay` has no gap-filling
so quiet days are absent rather than zero; the scoreboard renders the top 20 cells.

## Charting conventions

`charts.ts` holds them so callers can't get them wrong: one hue for single-measure charts (the
axis label carries identity, so no legend), thin marks with 4px rounded data-ends anchored to
the baseline, recessive hairline grid/axes, value text in ink tokens rather than series colors,
and a `dataTable` counterpart for every chart. Gate tiers use the reserved status palette and
**always** ship icon + label + count — the yellow step is sub-3:1 on the light surface by
design, so the label is the accessibility channel, never the hue. Light and dark each get steps
chosen for their own surface; the sequential ramp is declared by distance-from-surface so
magnitude reads as "more ink" in both modes.

## Tests

`packages/tui/tests/dashboard.test.ts` — hermetic (temp-file ledger seeded through `MinimaDb`,
handler invoked directly, no socket, no network). Covers the read-only guarantee, project
scoping, the honesty rules, auth/cookie behavior, HTML escaping, and every write-seam refusal
path.
