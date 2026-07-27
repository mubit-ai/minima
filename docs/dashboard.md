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

## Running it from another repo — `minima-loc --wt`

The harness resolves `.env.harness`/`.env` **relative to the current directory**, so a worktree
build invoked from some other repo picks up that repo's env rather than your credentials. The
`minima-loc` shell function (in `~/.zshrc`, not part of this repo) handles that: it resolves a
worktree by name via `git worktree list`, sources that worktree's `.env.harness` — falling back
to the main checkout, since the file is gitignored and usually only lives there — inside a
subshell so the credentials never leak into the interactive shell, and preserves cwd so per-repo
routing and memory still key off wherever you invoked it.

```bash
minima-loc --wt minima-dashboard dashboard          # this branch's dashboard
minima-loc --wt minima-dashboard dashboard --open
```

No extra wrapper is needed: the dashboard reads a local SQLite file and makes **no model or
service calls**, so it runs fine even with no credentials at all — they only matter when the
same build is used for an actual agent session.

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
- **Sessions** — every run with **last recorded activity**, decisions, spend, tool calls/errors;
  drill into one session for its decisions, tool usage, and plans. Runs that recorded zero events
  are hidden as empty shells and counted in a note.
- **Plans & tasks** — the plan list (progress, gates, checks vs baselines, writes, last activity)
  and a per-plan detail view: every task with its stored status, its **derived** gate tier and
  reason, its `verify` command and what the ledger can prove about it, the writes it claims, and
  its realized $. Plus the recomputed write-attribution panel.
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
- **Gate tiers are derived through `gateVerdictFor`**, exactly as `/why` derives them: the
  stored `confidence` column when set, else recomputed from `factors_json`. Reading the raw
  column is wrong — `step_check` gates are written with `confidence: null` by design (the
  stored tier is a milestone-level rollup), so the column alone reported 81% of a real
  ledger's gates as "ungraded" when only 3 of 180 genuinely had no verdict. The tier chart
  also renders the **reason** breakdown; a tier distribution without reasons isn't actionable.

- **Recency is derived, and rendered as a timestamp rather than a boolean.** `runs.status` is
  not liveness — it never closes when a session crashes, so 135 of 268 runs on a real ledger read
  `active`. `runs.updated` is not recency either: it is written at create and close and never per
  turn, so 134 of those 135 had `updated - created < 1s` while their events landed up to 19,854s
  (5.5h) later. Deriving from it would mark a genuinely running session dead about a second after
  launch — a worse failure than the one it fixes. The only honest signal is `MAX(events.ts)`, and
  87 of those 135 had **zero events at all**, so filtering empty shells removes most of the noise
  before any heuristic applies. The UI shows *"last recorded activity 12s ago"*, never a green
  dot: events are written at turn boundaries (89% of gaps under 10s, p95 34s, but 109 in the
  60s–5m band), so a session mid-stream can read minutes stale. A timestamp degrades gracefully
  under that; a boolean is simply wrong.
- **Write attribution is recomputed, and always shown against the stored column.**
  `file_changes.origin` is frozen at write time, compared against only the then-in-progress step
  by a bare-basename substring match (`big_plan.ts:361`) — and because that check reads
  `step && isPathClaimed(...)` (`big_plan.ts:294`), a write with no in-progress step
  short-circuits straight to `off_plan` with **no comparison evaluated at all**. On a real ledger
  that is 73 of 208 off-plan rows: 35% of all reported drift was a null check, not a measurement.
  `stats.ts:classifyChanges` rematches every write against **every** step in the plan, so those
  rows are assessed for the first time, and splits the result:
  - **path claim** — the step names the full path or a ≥2-segment suffix of it;
  - **filename claim** — basename only, the weak rule, **counted separately**;
  - **off-plan** — no step in the plan claims it;
  - **unattributable** — an opaque write with no path any rule could match; a third state, not drift.
  Real-ledger effect: 208/241 (86.3%) stored → **158/241 (65.6%)** recomputed. The panel prints
  both numbers, because asserting an improvement without showing the before is as unhelpful as
  shipping the frozen column. It is still a heuristic; hovering a path names the claiming step
  and which rule fired.

  Worth knowing: of the 83 writes that a step does claim, **1 is a path claim and 66 are
  filename-only**. Models write bare filenames into todos, essentially never path-qualified
  ones — which is exactly why the split is rendered rather than summed into one "on-plan" figure.
- **Worked-ahead is reported, not discarded.** Matching against every step would otherwise hide
  writes that landed before their claiming step became active. Those are flagged separately —
  work done out of order is not drift, but it is not nothing.
- **A missing baseline and a check that never flipped are different sentences.** A step can have
  captured a baseline and still not have gone red→green; printing "no baseline captured" for it
  would be a false statement. 147 of 172 checked steps on a real ledger captured no baseline,
  which is why almost nothing reaches green.
- **The `verify` command is shown; its output does not exist.** `plan_steps.verify` holds the
  command and `factors_json` holds `pass`/`redToGreen`/`hasCheck`/`coverageHit`/`tamper`, but the
  run's **stdout/stderr/exit code is captured nowhere in the ledger**. So a task panel can say
  *"`bun test tests/foo.test.ts` — check did not pass"* and can never say why. Capturing output is
  an upstream change, not a dashboard one.

### Known metric caveat: estimate vs realized

`est_cost_usd` (and `all_premium_cost_usd`, which is `max(ranked[].estCostUsd)`) price roughly
**one model call**. `actual_cost_usd` is the **realized total for the whole agent turn**, which
is many calls once the tool loop runs. So "saved vs all-premium" and the optimal-cost ratio
compare a per-call estimate against a per-turn actual, and both look far worse than reality. On
a 489-decision ledger the overrun tracked turn count almost perfectly — 1.4× at one turn, 26.6×
at sixteen — giving 10.8× overall, a negative "saved vs all-premium", and a 4% cost ratio.

This lives upstream in `src/db/metrics.ts`, not in the dashboard; the dashboard reports it
faithfully. Fixing it means either pricing the anchor per-turn or comparing estimate-to-estimate
and realized-to-realized. Until then, treat both numbers as directional at best.
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
