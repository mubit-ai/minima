# Localhost dashboard (`minima dashboard`)

A local web view over the harness ledger — visualizations, statistics, and (eventually) some
control, in the spirit of an agent-platform console but for a CLI-first harness.

**Status: draft / skeleton.** Every view below is real and reads real rows. The point of this
first pass is to fix the architecture, the honesty rules, and the security posture *before*
the surface grows. Read this before adding features.

```bash
minima dashboard                     # http://127.0.0.1:4180, read-only
minima dashboard --port 4181 --open  # pick a port, open a browser
minima dashboard --db /path/to.db    # read a specific ledger
minima dashboard --editor cursor     # jump-to-source target (autodetected; "none" disables)
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
| `server.ts` | `Bun.serve`, auth, routing, the activity poller. `createHandler` is test-callable. |
| `index.ts` | Public surface; imported lazily so normal TUI startup doesn't pay for it. |

The HTML views and the JSON API are built from the **same** payloads, so `/api/v1/*` is a real
contract rather than an afterthought — a React SPA can be dropped on top later without the
server growing a second data path.

## Views

- **Overview** — stat tiles (sessions, spend, saved vs the named anchor, quality-per-dollar, gate
  green rate), realized spend per day, decisions by model, gate tiers, task-type × model
  scoreboard.
- **Cost** — the cost tiles, realized spend per day, **what one model would have cost** (one bar
  per model this ledger has evidence for, realized spend as the reference rule, an anchor picker
  that drives the tile via `?anchor=`), and the budget ledger. See *Anchor repricing* below.
- **Routing** — model mix with cost/call, avg quality (judged rows only), avg latency; recent
  decisions with basis, outcome, and quality.
- **Sessions** — every run with **last recorded activity**, decisions, spend, tool calls/errors;
  drill into one session for its decisions, tool usage, and plans. Runs that recorded zero events
  are hidden as empty shells and counted in a note.
- **Plans & tasks** — the plan list (progress, gates, checks vs baselines, writes, last activity)
  and a per-plan detail view: every task with its stored status, its **derived** gate tier and
  reason, its `verify` command and what the ledger can prove about it, the writes it claims, and
  its realized $. Plus the recomputed write-attribution panel.
- **Memory** — the curated memory ledger with origin and evidence source. A view only; pin,
  confirm and reject live in `/memory` inside the harness.
- **Source** (`/files`) — any recorded path, rendered in-page with line numbers, a copy-path
  button, and a jump-to-editor button.

**Detail views withhold the project filter** — `/plans/:id`, `/runs/:id` and `/files`. Each of
those rows belongs to exactly one project, so picking another could only ever reload the same page.
The scope itself is **not** dropped: it stays in the URL and on every nav link, so the way back to
a scoped list is unaffected, and cmd-K still switches project from anywhere. The lists and
summaries (`/`, `/routing`, `/runs`, `/plans`, `/memory`, `/cost`) keep the control, because there
it changes what you see.

## Reading source (`/files`)

Clicking a path opens it in-page. That is the default action, because zero friction beats a link
that needs a scheme handler — browsers silently refuse `file://` from an `http://` page.

**A request never supplies a filesystem path.** It supplies a *ledger row reference*: a plan id
plus the exact `file_changes.path` string as recorded. The server looks that row up, resolves it
itself against the run's `runs.project_key`, and only then touches disk. Traversal is not
filtered — it is structurally impossible, because no caller-controlled string reaches `open()`.
A path that was never recorded simply has no row, so `../../etc/passwd` and an absolute
`/etc/passwd` both 404.

Recorded paths are mostly **relative** (234 of 241 rows on a real ledger) and resolve through
`runs.project_key`; the 7 absolute rows pass through. Two checks remain, because a recorded path
is not automatically a safe one:

- a relative row must still resolve **inside** its project root after `realpath`, so a repo file
  symlinked outward is refused;
- reads are capped at **512KB and 2,000 lines**. Past either, a head/tail excerpt ships with an
  explicit banner and **true** line numbers (the tail is not renumbered). The cap is the RAM
  requirement — an uncapped read is the one way this server grows.

Deleted files, escaping symlinks, binaries and unresolvable rows are all explained states rather
than errors, and **copy-path keeps working in every one of them** — a dead link with no way to
grab the path is worse than an honest gap.

`POST /api/v1/open` hands the resolved path to an editor through a `Bun.spawn` **argv array**,
never a shell string, with the line coerced through `parseInt`. POST + same-origin + token, so it
cannot be driven cross-site and never lands in browser history. It is the **only** route in the
server that accepts a non-GET, and what it touches is your editor, never the ledger. The guard
that matters is the ledger-row lookup.

## Live updates

There is no change notification for a separate readonly SQLite reader, so this is a poll — but
**one poller for the whole process**, not one per browser tab, which is the difference between
flat memory and a leak. `ActivityHub` starts on the first subscriber and **stops on the last**, so
an idle dashboard runs no timer at all.

The broadcast payload is just the newest event timestamp. The client decides whether that warrants
re-fetching, swaps `<main>` in place (preserving scroll), and keeps **no** event history — the
whole point is that an open tab accumulates nothing. Relative ages tick locally off `data-ts`
attributes, so "12s ago" becoming "13s ago" costs no network at all.

**A quiet ledger must not look like a dead one.** `Bun.serve`'s `idleTimeout` defaults to 10
seconds, and the poller originally said nothing at all unless the newest timestamp moved — so with
no session running the socket went silent and Bun closed it every 10s: a warning in the terminal, a
client reconnect, repeat. Raising the timeout alone only moves the disconnect later, so the stream
had to stop being idle. Every 20s of quiet the poller emits a keepalive on the timer it already
owns, as its own `event: ping` frame (re-sending `activity` when nothing happened would put a frame
on the wire that means the opposite of its payload); `idleTimeout` is set to 60s as the backstop
behind it. The keepalive is also how an abandoned stream is noticed — a slept laptop never fires
`cancel()`, so its slot used to be held against the cap until the lifetime cap expired.

Bounded on purpose: **8 concurrent streams** (the 9th is refused, not queued), a hard 30-minute
lifetime cap per stream (set when it opens, never reset — the browser reconnects, so it is
invisible in use), and a 2s poll — already far finer than the data's own resolution, since events
land at turn boundaries with a p95 gap of 34s.

Measured on the live 11MB ledger: 4 concurrent streams held open for 130s left RSS oscillating
between 33MB and 42MB and **ending 8MB below where it started**. Opening 10 streams accepted 8 and
refused 2; RSS returned below baseline after they closed.

This replaced a 10s full-page meta-refresh. Client listeners are delegated on `document` because
the live swap replaces `<main>` wholesale — binding by id would leave them dead after the first
update.

## Honesty rules (do not "improve" these)

A dashboard that disagrees with the TUI is worse than no dashboard. `stats.ts` mirrors `/cost`
and `taskTypeScoreboard` exactly:

- **Quality-per-dollar over judged rows only.** Abstentions are excluded, never counted as
  zero. Coverage is shown in **dollars as well as rows** — `47/492 rows — $1.15 of $45.17, 2.5%
  of the money`. The row share flatters it: 10% of rows sounds survivable, and 2.5% of the spend
  is the number that tells you how little of the money this metric has seen.
- **Savings is one unit, and it names its anchor.** See *Anchor repricing* below. There is
  exactly one savings tile; its label is `Saved vs <model>`, because **a tile is honest when its
  caveat fits in its label**. Savings can be **negative** — the tile then leads with *overspent
  this anchor by …* and, when the anchor's own predictions missed the row thresholds, with the
  τ-miss count, because a bare minus sign under a label reading "Saved" gets read as "routing
  wasted that much".
- **A number that is only honest with a sentence attached does not go in a tile.** A tile is
  glanceable by construction; a caveat that *inverts* the reading cannot live in 11px muted text
  beside the number it contradicts. That is why the per-model comparison is a chart, where the
  bar, the τ-miss rate and the evidence split are one hoverable object, and why there is no tile
  per anchor.
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

### Anchor repricing (`src/db/anchors.ts`)

**The bug this replaced.** `est_cost_usd` (and `all_premium_cost_usd`, which is
`max(ranked[].estCostUsd)`) price roughly **one model call**. `actual_cost_usd` is the realized
total for the **whole agent turn**, which is many calls once the tool loop runs. Subtracting them
compared a per-call estimate against a per-turn actual: on a 492-decision ledger realized spend
was **10.75×** the estimate ($45.17 vs $4.17), so "saved vs all-premium" printed **−$33.78** for
an anchor that would in fact have cost 3.5× more, and the optimal-cost ratio printed 4%.

**The fix is a ratio, not a subtraction.** `routing_decisions` stores no token columns, so
realized tokens cannot be recovered — but a price *ratio* can:

```
anchor_realized = actual × (est_anchor / est_chosen)
```

Two tiers, kept separate because they rest on very different evidence, and both reported:

| Tier | When | Rests on |
|---|---|---|
| **direct** | the anchor is in this row's own `ranked[]` | two numbers the ledger already holds — **no price table at all** |
| **solved** | the anchor was not a candidate | a token vector `(E_in, E_out)` recovered by least squares over the row's candidates at catalog prices |
| **unpriced** | <2 priced candidates, a degenerate solve, a non-physical solution, or no chosen-model estimate | nothing — **counted and disclosed, never guessed** |

Both halves were verified before shipping: the chosen model is in `ranked[]` on **423/423** priced
rows with `est_cost_usd` matching its ranked entry exactly, and one token vector at catalog prices
reproduces *every* candidate's estimate exactly on **375/423** rows (median relative residual
0.0000). For the default anchor, `claude-opus-4-8`, 413 of 424 routed rows are direct — **99.3% of
the routed dollars**.

The one assumption, stated on every surface that shows the number: **it assumes the realized
input:output mix matches the row's estimated mix**, which is unverifiable from what the ledger
stores. Sensitivity is roughly ±6% on dollars and ±1pp on the percentage.

**Rules that keep it honest, all covered by `tests/anchors.test.ts`:**

- **The bar set is the ledger's, not the catalog's.** 9 models here, not `SEED_MODELS`' 20. The
  line is direct evidence: a model that was a *candidate* on 413 rows is direct-tier on all 413
  even if it was never picked, while a model the router never proposed would be 100% solved-tier —
  pure inference about something that never entered a decision.
- **Ids are normalized before any grouping.** `anthropic/claude-sonnet-5` and `claude-sonnet-5`
  are one model, and a real ledger holds both spellings; grouping without this splits one bar in
  two *and* misses the price lookup on the prefixed half. The provider segment is stripped **only**
  when the remainder is a known model, because `moonshotai/kimi-k2.6` and `z-ai/glm-5.2` carry
  the slash in their real ids.
- **Coverage is disclosed in dollars.** `gpt-5.6-luna` has 5 routed rows at **$0.00**; the anchor
  multiplies `actual`, so they contribute exactly nothing while still counting as rows priced.
- **The workhorse is computed over the routed population**, the one the anchors can price.
  `claude-haiku-4-5` is 107 chosen but only 48 routed, so "most chosen" flips with the
  denominator — over all rows the label would name a model priced by almost none of its own rows.
- **Unrouted spend is never in an anchor comparison** (it has no candidate set), and is reported
  separately: `$0.3605 of it unrouted (offline/pinned)`.
- **A τ-miss count travels with every negative comparison.** `gemini-2.5-flash` "saves" $34.41 —
  and missed the row's own threshold on **240 of 388** rows (62%). The cheaper bill is not the
  same work.

**Removed with the bug:** the *Saved vs baseline* tile (`config.baselineModelId` is hardcoded
`null` with no env var and no flag, so `configured_baseline_cost_usd` is NULL on 492/492 rows and
always would be) and the *Optimal cost ratio* tile (its oracle was an estimate over a realized
denominator, so it read 4%; repaired to estimate-over-estimate it is ≥1 by construction on real
data and its own cap pins it at exactly 1.0 — a metric with one possible value is not a
measurement). Five cost tiles became three.

**`meter.report()` no longer claims savings either.** It is appended to the *same* `/cost` output,
immediately above `metricsReport`, and it printed `baseline $0.000000 (0 rows) | savings 0.0%
($-X)` — the negative of session spend, labeled savings, next to "savings 0.0%". The rule that a
dashboard disagreeing with the TUI is worse than no dashboard does not stop at the process
boundary: two savings numbers in one command's output is the same failure, and a tighter one,
because you cannot even blame a stale window. The meter now reports only what a live session can
know (actual, est, turns, quality, outcome, KV-cache, cost-of-pass) and the anchor comes from
`anchors.ts`, which both screens read.

`CostRow.baselineCostUsd`, `routing.baselineCostUsd` and the `configured_baseline_cost_usd` column
all **stay** — they are fed by the router and are what a wired baseline would use, and migrations
are append-only. `MINIMA_BASELINE_MODEL` is deliberately **not** wired: it would only affect
future rows and would not fix any number already on the screen.
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
- **read-only, structurally** — the SQLite handle is opened `readonly` *and* `src/dashboard/`
  does not import `MinimaDb` at all, so there is no code path that could open a writable handle.
  Opening the dashboard never creates a ledger file;
- all ledger text is HTML-escaped on the way out (there is a test that tries to inject a
  `<script>` through a memory row);
- the one non-GET route (`/api/v1/open`) additionally requires a **same-origin** request, so
  another tab cannot drive it with a cross-site POST.

## No write seam

There was one: `POST /api/v1/memories/:id/status` behind an `--allow-writes` flag. Both are
**removed**. The endpoint 404s, the flag is gone (passing it prints a note and starts read-only),
and `/memory` renders the ledger with no control that could submit anything.

Read-only stopped being a default and became a property of what is linked in. Memory status
changes belong to `/memory` inside the harness, which appends the audited `memory_events` row —
a browser tab is the wrong place to hold that authority, and `/healthz` reports
`readOnly: true` so a caller can check without reading this file.

## Deliberately not built yet

The next decision is **how much control** the browser should get. Ranked by cost:

1. **Safe ledger writes** (small, and currently a deliberate no): budget cap + mode changes,
   routing-profile switching, `/memory` operations. All are already user-owned state, but the
   write path was removed rather than merely gated, so re-opening one means re-arguing that a
   browser tab is the right place to hold the authority — not just copying an endpoint shape.
2. **Live-run control** (large): abort/steer an in-flight run, approve a plan step from the
   browser. The dashboard is a *separate process* from the running TUI, so this needs a real
   IPC channel (a unix socket or a `bg_jobs`-style command table the harness polls) plus a
   decision about what happens when two clients steer at once. This is where a "give the user
   control" feature actually gets designed — not a UI problem.
3. ~~**Streaming**~~ — shipped, see "Live updates" above.

Other known gaps: no date-range filter yet (scope is project-only); the scoreboard renders the
top 20 cells; and the `verify` command's OUTPUT is captured nowhere in the ledger, so a failing
check can be reported but never explained (that needs an upstream change).

The estimate-vs-realized cost basis **is** fixed — see *Anchor repricing*. What remains
unrecoverable is per-row realized tokens: `routing_decisions` has no token columns, so the anchor
ratio has to assume the realized input:output mix matches the estimated one. Adding those columns
is an upstream change, and it would only improve rows written after it lands.

Fixed since the first pass: charts carry a real tooltip layer (native `<title>` stays as the
no-JS fallback), and `spendByDay` is zero-filled.

## Charting conventions

`charts.ts` holds them so callers can't get them wrong: one hue for single-measure charts (the
axis label carries identity, so no legend), thin marks with 4px rounded data-ends anchored to
the baseline, recessive hairline grid/axes, value text in ink tokens rather than series colors,
and a `dataTable` counterpart for every chart. `barChart`'s optional `reference` draws one
recessive dashed rule with a direct label — it is a rule, not a second series (same measure, same
axis), which is how "what each model would have cost" and "what was actually spent" share one
chart without a second y-scale. Gate tiers use the reserved status palette and
**always** ship icon + label + count — the yellow step is sub-3:1 on the light surface by
design, so the label is the accessibility channel, never the hue. Light and dark each get steps
chosen for their own surface; the sequential ramp is declared by distance-from-surface so
magnitude reads as "more ink" in both modes.

## Tests

`packages/tui/tests/dashboard.test.ts` — hermetic (temp-file ledger seeded through `MinimaDb`,
handler invoked directly, no socket, no network). Covers the read-only guarantee, project
scoping, the honesty rules, auth/cookie behavior, HTML escaping, that `/api/v1/open` is the only
route accepting a non-GET, that detail views withhold the project filter while keeping the scope,
and that the keepalive fires on a quiet ledger.

`packages/tui/tests/anchors.test.ts` — the estimator, over hand-built row arrays with hand-computed
prices, so it needs no ledger at all. Covers both tiers, every exclusion (single candidate,
degenerate solve, non-physical solution, missing chosen-model estimate, unparseable `ranked`), that
the unit bug cannot return (a row whose realized cost is 10× its estimate must scale with the
realized cost), that a negative saving stays negative, id normalization both ways, dollar-vs-row
coverage, the workhorse population rule, and that `meter.report()` contains no savings claim.

One thing no hermetic test can prove: that Bun honors `idleTimeout`. A source guard asserts the
option is passed and is labeled as exactly that — the real check is a tab left open past 10s.

`tsconfig.tests.json` typechecks `tests/**` (the base config covers `src/**` only, which is how
three stale ctx literals in `dashboard.test.ts` kept passing). It is a **ratchet**: 124 of 166 test
files pass today and are gated now; the 42 that don't are named in an explicit `exclude` list that
is a debt ledger — delete lines as files are fixed, never add one. `src/**` must stay in its
`include`, or the ambient `declare module "keytar"` in `src/types.d.ts` goes missing and the config
invents a phantom TS2307.
