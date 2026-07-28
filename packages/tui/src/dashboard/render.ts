/**
 * HTML views. Server-rendered from TS template strings — no client framework, no bundler,
 * so the whole dashboard survives `bun build --compile` with zero asset plumbing.
 *
 * Light and dark are both SELECTED (each mode gets steps chosen for its own surface, not an
 * automatic inversion): the sequential ramp is declared by distance-from-surface, so
 * `--seq-8` is the farthest-from-surface step in either mode and magnitude always reads as
 * "more ink". Dark is the default; the theme toggle stamps `data-theme` on <html> and wins
 * over the OS setting in both directions.
 *
 * Every color lives in the single `TOKENS` block below and nowhere else — a test greps for
 * literals, so swapping in Mubit's real console tokens stays a value-only edit in one place.
 *
 * Client JS is hand-written and small: theme toggle, scope <select>, cmd-K palette, local
 * relative-age ticking, table sort/filter, a tooltip layer, and an EventSource that swaps <main>
 * when the ledger actually changes. Every NUMBER is still computed server-side — the client
 * formats and reorders, it never aggregates. Listeners are delegated on `document` because the
 * live refresh replaces <main> wholesale.
 */

import {
  type AreaPoint,
  type BarRow,
  type StatusSegment,
  areaChart,
  barChart,
  dataTable,
  emptyState,
  escapeHtml,
  seqStep,
  statusBar,
  tableFilter,
} from "./charts.ts";
import type { FileContent } from "./files.ts";
import type {
  BudgetSummary,
  DecisionRecord,
  MemorySummary,
  PlanSummary,
  ProjectSummary,
  RunDetail,
  RunSummary,
  Scope,
} from "./queries.ts";
import type {
  ChangeClass,
  Kpi,
  OverviewPayload,
  PassRate,
  PlanView,
  SessionList,
  TaskRow,
} from "./stats.ts";

export interface NavItem {
  href: string;
  label: string;
  active: boolean;
}

/** A cmd-K row. `kind` is the dim left-hand label ("view", "project", "plan", "session"). */
export interface PaletteItem {
  kind: string;
  label: string;
  href: string;
}

export interface ShellOptions {
  title: string;
  nav: NavItem[];
  projects: ProjectSummary[];
  scope: Scope;
  ledgerPath: string;
  body: string;
  /** Extra cmd-K targets beyond nav + projects; views supply plans/sessions. */
  commands?: PaletteItem[];
  /**
   * Pass `false` on a view whose content a project filter cannot change — a single-entity
   * detail page. The scope is still carried by the nav links and the URL; only the control
   * is withheld, so nothing is lost by hiding it.
   */
  projectFilter?: boolean;
}

export const fmtUsd = (n: number | null): string => {
  if (n === null) return "—";
  const mag = Math.abs(n);
  return `${n < 0 ? "-" : ""}${mag >= 1 ? `$${mag.toFixed(2)}` : `$${mag.toFixed(4)}`}`;
};

export const fmtPct = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

/**
 * A relative-age cell that carries its raw timestamp, so the client ticks it locally instead of
 * re-fetching a page to learn that a minute passed.
 */
export function agoCell(epochSeconds: number | null, now: number): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return "—";
  return `<span data-ts="${epochSeconds}">${escapeHtml(fmtAgo(epochSeconds, now))}</span>`;
}

export function fmtAgo(epochSeconds: number | null, now: number): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return "—";
  const secs = Math.max(0, now - epochSeconds);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE ONE COLOR BLOCK. Nothing outside `TOKENS` declares a color anywhere in
 * src/dashboard — `tests/dashboard.test.ts` greps for literals and fails if one
 * appears, which is what makes the promise below actually hold.
 *
 * Values are bare HSL components, so usage reads `hsl(var(--accent))` and alpha
 * comes free as `hsl(var(--accent) / 0.14)`. That is the convention Mubit's
 * `app/assets/css/tailwind.css` uses, so dropping in the real console tokens is a
 * value-only replacement inside this block. Note the LIGHT set is declared twice
 * (OS preference + explicit toggle) — replace both.
 *
 * Cascade: dark is the default (`:root`), the OS light preference applies only
 * while the user has not toggled, and an explicit `data-theme` always wins in
 * both directions.
 *
 * APPROXIMATED from /Users/eldaru/Mubit/Design (warm slate, orange accent, dark
 * default, devtools density). That directory documents the token names and the
 * aesthetic but carries no HSL values, and no tailwind.css is checked out here.
 *
 * Validated with dataviz/scripts/validate_palette.js:
 *   LIGHT status  — ALL CHECKS PASS (min normal-vision ΔE 24.5, all ≥3:1).
 *   DARK status   — every hard check passes (CVD ΔE 26.1, normal 34.4, all
 *                   ≥3:1); the amber sits ABOVE the dark lightness band
 *                   [0.48,0.67] at L 0.90 on purpose. A band-lightness yellow is
 *                   a dark olive and stops reading as "warning" at all, and
 *                   the band is a categorical-series rule — severity is
 *                   deliberately not equal-weight. Every status fill ships icon +
 *                   label + count via `statusBar`, so hue is never the only
 *                   channel.
 *   Light amber had no solution above the band: a bright yellow cannot reach
 *   3:1 on white, so light mode uses an in-band gold instead.
 *
 * `--serious` from the reserved status palette is deliberately NOT declared: its
 * salmon-orange step collides with the Mubit accent, and the dashboard grades
 * three tiers. Roles stay separated: `--accent` means interactive (links, active
 * nav, focus); status means state. Known and accepted: under protanopia the dark
 * accent and success read alike (ΔE 1.4). They never appear as members of one
 * encoding, and status always carries icon + label, so no information depends on
 * telling them apart by hue.
 * ───────────────────────────────────────────────────────────────────────────── */
const TOKENS = `
:root {
  color-scheme: dark;
  --mode: dark;

  --bg: 36 8% 7%;
  --panel: 36 7% 10%;
  --panel-soft: 36 6% 13%;
  --panel-elevated: 36 6% 16%;
  --border: 36 6% 20%;
  --border-strong: 36 6% 32%;
  --text: 40 12% 88%;
  --text-strong: 40 15% 97%;
  --muted: 38 7% 56%;
  --accent: 22 90% 58%;
  --accent-fg: 22 45% 8%;
  --success: 138 84% 32%;
  --warning: 48 100% 66%;
  --danger: 2 88% 57%;

  --grid: 36 6% 17%;
  --axis: 36 6% 26%;

  --seq-1: 24 88% 27%; --seq-2: 24 88% 34%; --seq-3: 24 88% 41%;
  --seq-4: 24 88% 49%; --seq-5: 24 88% 62%; --seq-6: 24 88% 74%;
  --seq-7: 24 88% 85%; --seq-8: 24 88% 96%;
}
@media (prefers-color-scheme: light) {
  :root:where(:not([data-theme])) {
    color-scheme: light;
    --mode: light;

    --bg: 40 20% 97%;
    --panel: 40 30% 99%;
    --panel-soft: 40 18% 95%;
    --panel-elevated: 40 40% 100%;
    --border: 38 14% 86%;
    --border-strong: 38 12% 70%;
    --text: 30 8% 20%;
    --text-strong: 30 10% 9%;
    --muted: 35 7% 44%;
    --accent: 22 85% 43%;
    --accent-fg: 40 40% 100%;
    --success: 146 74% 22%;
    --warning: 54 100% 32%;
    --danger: 4 86% 41%;

    --grid: 38 16% 90%;
    --axis: 38 12% 76%;

    --seq-1: 24 84% 68%; --seq-2: 24 84% 54%; --seq-3: 24 84% 44%;
    --seq-4: 24 84% 36%; --seq-5: 24 84% 29%; --seq-6: 24 84% 21%;
    --seq-7: 24 84% 14%; --seq-8: 24 84% 8%;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --mode: light;

  --bg: 40 20% 97%;
  --panel: 40 30% 99%;
  --panel-soft: 40 18% 95%;
  --panel-elevated: 40 40% 100%;
  --border: 38 14% 86%;
  --border-strong: 38 12% 70%;
  --text: 30 8% 20%;
  --text-strong: 30 10% 9%;
  --muted: 35 7% 44%;
  --accent: 22 85% 43%;
  --accent-fg: 40 40% 100%;
  --success: 146 74% 22%;
  --warning: 54 100% 32%;
  --danger: 4 86% 41%;

  --grid: 38 16% 90%;
  --axis: 38 12% 76%;

  --seq-1: 24 84% 68%; --seq-2: 24 84% 54%; --seq-3: 24 84% 44%;
  --seq-4: 24 84% 36%; --seq-5: 24 84% 29%; --seq-6: 24 84% 21%;
  --seq-7: 24 84% 14%; --seq-8: 24 84% 8%;
}
`;

/**
 * Layout, type, and density. Mubit's dense devtools scale: 13px base, mono for
 * every numeral/ID/timestamp, 2–4px radii on inline controls, 8px on cards, and
 * a system serif for page titles (the documented "calm shell" display face —
 * approximated with ui-serif since no webfont is downloaded).
 */
const STYLE = `${TOKENS}
:root {
  --r-sm: 2px; --r-md: 3px; --r-lg: 4px; --r-card: 8px;
  --side-w: 248px;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --serif: ui-serif, Georgia, "Times New Roman", serif;
}
* { box-sizing: border-box; }
body {
  margin: 0; font: 13px/1.55 var(--sans);
  background: hsl(var(--bg)); color: hsl(var(--text));
  -webkit-font-smoothing: antialiased;
}
a { color: hsl(var(--accent)); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid hsl(var(--accent)); outline-offset: 2px; border-radius: var(--r-md); }

.app { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); min-height: 100vh; }
aside.side {
  border-right: 1px solid hsl(var(--border)); background: hsl(var(--panel));
  display: flex; flex-direction: column; gap: 4px; padding: 16px 12px;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px 14px; }
.brand b { font: 600 17px/1 var(--serif); letter-spacing: -0.01em; color: hsl(var(--text-strong)); }
.brand .ro {
  font: 500 10px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.06em;
  color: hsl(var(--muted)); border: 1px solid hsl(var(--border)); border-radius: var(--r-sm);
  padding: 2px 4px;
}
aside.side nav { display: flex; flex-direction: column; gap: 1px; }
aside.side nav a {
  padding: 6px 8px; border-radius: var(--r-lg); color: hsl(var(--text));
  display: flex; align-items: center; gap: 8px;
}
aside.side nav a:hover { background: hsl(var(--panel-soft)); text-decoration: none; }
aside.side nav a[aria-current="page"] {
  background: hsl(var(--accent) / 0.13); color: hsl(var(--accent)); font-weight: 550;
}
.side-foot { margin-top: auto; padding: 12px 8px 0; border-top: 1px solid hsl(var(--border)); }
.side-foot div { font: 11px/1.5 var(--mono); color: hsl(var(--muted)); word-break: break-all; }
.kbd {
  font: 10px/1 var(--mono); border: 1px solid hsl(var(--border)); border-radius: var(--r-sm);
  padding: 3px 4px; color: hsl(var(--muted));
}

header.top {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 24px; border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--bg) / 0.92); backdrop-filter: blur(6px);
  position: sticky; top: 0; z-index: 5;
}
header.top h1 { font: 500 21px/1.2 var(--serif); margin: 0; color: hsl(var(--text-strong)); }
.spacer { flex: 1 1 auto; }
.controls { display: flex; align-items: center; gap: 6px; }
select, button.ghost {
  font: 12px/1 var(--sans); color: hsl(var(--text)); background: hsl(var(--panel-soft));
  border: 1px solid hsl(var(--border)); border-radius: var(--r-lg); padding: 6px 8px;
  cursor: pointer;
}
select:hover, button.ghost:hover { border-color: hsl(var(--border-strong)); }
main { padding: 20px 24px 48px; max-width: 1240px; }

h2 { font: 550 13px/1.3 var(--sans); margin: 0 0 12px; color: hsl(var(--text-strong)); }
section.card {
  background: hsl(var(--panel)); border: 1px solid hsl(var(--border));
  border-radius: var(--r-card); padding: 16px; margin-bottom: 16px;
}
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(184px, 1fr)); gap: 10px; margin-bottom: 16px; }
.kpi {
  background: hsl(var(--panel)); border: 1px solid hsl(var(--border));
  border-radius: var(--r-card); padding: 12px 14px;
}
.kpi .label { font: 11px/1.3 var(--mono); text-transform: uppercase; letter-spacing: 0.05em; color: hsl(var(--muted)); }
.kpi .value {
  font: 500 24px/1.2 var(--mono); letter-spacing: -0.02em; margin: 6px 0 3px;
  color: hsl(var(--text-strong)); font-variant-numeric: tabular-nums;
}
.kpi .note { font: 11px/1.4 var(--sans); color: hsl(var(--muted)); }
.kpi.nodata .value { color: hsl(var(--muted)); font-size: 17px; }

svg.chart { display: block; overflow: visible; }
svg.chart .bar { fill: hsl(var(--seq-6)); }
svg.chart .cat { fill: hsl(var(--text)); font-size: 11px; font-family: var(--sans); }
svg.chart .val { fill: hsl(var(--text-strong)); font-size: 11px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
svg.chart .tick { fill: hsl(var(--muted)); font-size: 10px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
svg.chart .grid { stroke: hsl(var(--grid)); stroke-width: 1; }
svg.chart .axis { stroke: hsl(var(--axis)); stroke-width: 1; }
svg.chart .area { fill: hsl(var(--accent) / 0.16); }
svg.chart .line { fill: none; stroke: hsl(var(--accent)); stroke-width: 2; stroke-linejoin: round; }
svg.chart .dot { fill: hsl(var(--accent)); stroke: hsl(var(--panel)); stroke-width: 2; }
svg.chart .hit { fill: transparent; }
svg.chart .seg-green { fill: hsl(var(--success)); }
svg.chart .seg-yellow { fill: hsl(var(--warning)); }
svg.chart .seg-red { fill: hsl(var(--danger)); }
svg.chart .seg-ungraded { fill: hsl(var(--axis)); }

ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 16px; padding: 12px 0 0; margin: 0; }
ul.legend li { display: flex; align-items: center; gap: 6px; font-size: 12px; color: hsl(var(--text)); }
ul.legend .lg-val { font-family: var(--mono); font-weight: 500; color: hsl(var(--text-strong)); font-variant-numeric: tabular-nums; }
ul.legend .lg-pct { font-family: var(--mono); color: hsl(var(--muted)); font-variant-numeric: tabular-nums; }
[class^="dot-"] { width: 9px; height: 9px; border-radius: var(--r-sm); display: inline-block; }
.dot-green { background: hsl(var(--success)); } .dot-yellow { background: hsl(var(--warning)); }
.dot-red { background: hsl(var(--danger)); } .dot-ungraded { background: hsl(var(--axis)); }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid hsl(var(--border)); white-space: nowrap; }
th {
  font: 500 10px/1.3 var(--mono); text-transform: uppercase; letter-spacing: 0.06em;
  color: hsl(var(--muted)); position: sticky; top: 0; background: hsl(var(--panel));
}
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
tbody tr:hover { background: hsl(var(--panel-soft)); }
td.wrap { white-space: normal; min-width: 260px; }
tbody tr:last-child td { border-bottom: 0; }

.meter { display: inline-flex; align-items: center; gap: 7px; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.meter .track { width: 54px; height: 6px; border-radius: var(--r-lg); background: hsl(var(--grid)); overflow: hidden; }
.meter .fill { height: 100%; border-radius: var(--r-lg); }
.pill {
  display: inline-block; padding: 1px 6px; border-radius: var(--r-md); font: 11px/1.5 var(--mono);
  border: 1px solid hsl(var(--border)); color: hsl(var(--muted));
}
.pill.good { color: hsl(var(--success)); border-color: hsl(var(--success) / 0.4); }
.pill.warn { color: hsl(var(--warning)); border-color: hsl(var(--warning) / 0.4); }
.pill.bad { color: hsl(var(--danger)); border-color: hsl(var(--danger) / 0.4); }
p.empty { color: hsl(var(--muted)); font-size: 12px; margin: 4px 0; }
p.note { color: hsl(var(--muted)); font-size: 11px; margin: 10px 0 0; }
.mono { font-family: var(--mono); font-size: 11px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 16px; }
.banner {
  border: 1px solid hsl(var(--warning) / 0.35); border-left: 3px solid hsl(var(--warning));
  border-radius: var(--r-card); padding: 10px 14px; margin-bottom: 16px; font-size: 12px;
  color: hsl(var(--text)); background: hsl(var(--warning) / 0.07);
}

/* Task list. A table would be wrong here — step content is prose and must wrap, so this is a
   3-column grid: gutter (index + status), body (title, evidence, files), realized $. */
ol.tasks { list-style: none; margin: 0; padding: 0; }
li.task {
  display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 12px;
  padding: 11px 6px; border-bottom: 1px solid hsl(var(--border));
}
li.task:last-child { border-bottom: 0; }
li.task:hover { background: hsl(var(--panel-soft)); }
li.task[data-status="in_progress"] {
  background: hsl(var(--accent) / 0.07); box-shadow: inset 2px 0 0 hsl(var(--accent));
}
.t-gutter {
  display: flex; align-items: baseline; gap: 5px;
  font: 11px/1.6 var(--mono); color: hsl(var(--muted)); font-variant-numeric: tabular-nums;
}
.t-title { color: hsl(var(--text-strong)); line-height: 1.5; }
li.task[data-status="completed"] .t-title { color: hsl(var(--text)); }
.t-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; align-items: center; }
.t-check { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.t-check code {
  font: 11px/1.5 var(--mono); background: hsl(var(--panel-soft));
  border: 1px solid hsl(var(--border)); border-radius: var(--r-md); padding: 2px 6px;
  color: hsl(var(--text)); word-break: break-all;
}
.t-evid { font-size: 11px; color: hsl(var(--muted)); }
.t-cost {
  font: 12px/1.6 var(--mono); color: hsl(var(--text));
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
ul.paths { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
ul.paths li {
  font: 11px/1.5 var(--mono); border: 1px solid hsl(var(--border));
  border-radius: var(--r-md); padding: 1px 6px; color: hsl(var(--text));
}
ul.paths li.weak { border-style: dashed; color: hsl(var(--muted)); }
/* Tier text wears INK, never the status hue — the glyph alone carries color, so an 11px label
   is never asked to be legible at the amber's 3.86:1 on the light surface. */
.tier { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px; color: hsl(var(--text)); }
.tier .g { font-size: 10px; }
.tier-green .g { color: hsl(var(--success)); }
.tier-yellow .g { color: hsl(var(--warning)); }
.tier-red .g { color: hsl(var(--danger)); }
.tier-none { color: hsl(var(--muted)); }
/* File viewer. The gutter is a fixed column so long lines scroll the code, not the numbers. */
.src { overflow-x: auto; border: 1px solid hsl(var(--border)); border-radius: var(--r-card); background: hsl(var(--panel-soft)); }
table.code { width: 100%; border-collapse: collapse; font: 12px/1.55 var(--mono); }
table.code td { border: 0; padding: 0 10px; white-space: pre; vertical-align: top; }
table.code td.ln {
  width: 1%; text-align: right; color: hsl(var(--muted)); user-select: none;
  background: hsl(var(--panel)); border-right: 1px solid hsl(var(--border));
  position: sticky; left: 0; font-variant-numeric: tabular-nums;
}
table.code tr:hover td { background: hsl(var(--accent) / 0.07); }
table.code tr.gap td { color: hsl(var(--muted)); text-align: center; padding: 6px 10px; background: hsl(var(--panel)); }
.fbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.fbar .fpath { font: 12px/1.5 var(--mono); color: hsl(var(--text-strong)); word-break: break-all; }
.crumb { font-size: 12px; color: hsl(var(--muted)); margin: 0 0 12px; }
.crumb a { color: hsl(var(--muted)); }
.crumb a:hover { color: hsl(var(--accent)); }

.tip {
  position: fixed; z-index: 60; pointer-events: none; opacity: 0; transition: opacity 90ms;
  background: hsl(var(--panel-elevated)); color: hsl(var(--text-strong));
  border: 1px solid hsl(var(--border-strong)); border-radius: var(--r-lg);
  padding: 6px 9px; font: 11px/1.45 var(--sans); max-width: 320px;
  box-shadow: 0 4px 14px hsl(var(--bg) / 0.55);
}
.tip.on { opacity: 1; }
table.sortable th { cursor: pointer; user-select: none; }
table.sortable th:hover { color: hsl(var(--accent)); }
table.sortable th[data-dir="asc"]::after { content: " ▲"; font-size: 8px; }
table.sortable th[data-dir="desc"]::after { content: " ▼"; font-size: 8px; }
input.tfilter {
  font: 12px/1 var(--sans); color: hsl(var(--text)); background: hsl(var(--panel-soft));
  border: 1px solid hsl(var(--border)); border-radius: var(--r-lg); padding: 6px 8px;
  min-width: 180px;
}
.thead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.thead h2 { margin: 0; }
.rowcount { font: 11px/1.5 var(--mono); color: hsl(var(--muted)); }
#live {
  font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.06em;
  color: hsl(var(--muted)); border: 1px solid hsl(var(--border));
  border-radius: var(--r-sm); padding: 4px 5px;
}

#pal { position: fixed; inset: 0; z-index: 50; display: none; }
#pal[open] { display: block; }
#pal .scrim { position: absolute; inset: 0; background: hsl(var(--bg) / 0.72); }
#pal .box {
  position: relative; max-width: 520px; margin: 12vh auto 0; background: hsl(var(--panel-elevated));
  border: 1px solid hsl(var(--border-strong)); border-radius: var(--r-card); overflow: hidden;
}
#pal input {
  width: 100%; border: 0; border-bottom: 1px solid hsl(var(--border)); padding: 13px 15px;
  font: 14px/1 var(--sans); background: transparent; color: hsl(var(--text-strong));
}
#pal input:focus { outline: none; }
#pal ul { list-style: none; margin: 0; padding: 6px; max-height: 44vh; overflow-y: auto; }
#pal li { padding: 8px 10px; border-radius: var(--r-lg); cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
#pal li[aria-selected="true"] { background: hsl(var(--accent) / 0.14); }
#pal li .k { font: 10px/1.4 var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: hsl(var(--muted)); min-width: 58px; }
#pal li .t { color: hsl(var(--text-strong)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 860px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  aside.side { position: static; height: auto; border-right: 0; border-bottom: 1px solid hsl(var(--border)); }
  aside.side nav { flex-direction: row; overflow-x: auto; }
  .side-foot { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const SCRIPT = `
(function () {
  var root = document.documentElement;
  function mode() { return getComputedStyle(root).getPropertyValue("--mode").trim(); }
  var toggle = document.getElementById("theme");
  if (toggle) toggle.addEventListener("click", function () {
    var next = mode() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("minima-dash-theme", next); } catch (e) {}
  });
  try {
    var saved = localStorage.getItem("minima-dash-theme");
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {}

  var scope = document.getElementById("scope");
  if (scope) scope.addEventListener("change", function () {
    var url = new URL(window.location.href);
    if (scope.value) url.searchParams.set("project", scope.value);
    else url.searchParams.delete("project");
    window.location.href = url.toString();
  });

  var pal = document.getElementById("pal");
  if (!pal) return;
  var input = pal.querySelector("input");
  var list = pal.querySelector("ul");
  var items = JSON.parse(pal.getAttribute("data-items") || "[]");
  var shown = [];
  var cur = 0;
  function draw() {
    var q = input.value.toLowerCase();
    shown = q ? items.filter(function (i) { return (i.kind + " " + i.label).toLowerCase().indexOf(q) >= 0; }) : items;
    shown = shown.slice(0, 40);
    if (cur >= shown.length) cur = Math.max(0, shown.length - 1);
    list.textContent = "";
    shown.forEach(function (i, n) {
      var li = document.createElement("li");
      li.setAttribute("aria-selected", n === cur ? "true" : "false");
      var k = document.createElement("span"); k.className = "k"; k.textContent = i.kind;
      var t = document.createElement("span"); t.className = "t"; t.textContent = i.label;
      li.appendChild(k); li.appendChild(t);
      li.addEventListener("click", function () { window.location.href = i.href; });
      list.appendChild(li);
    });
  }
  function open() { pal.setAttribute("open", ""); input.value = ""; cur = 0; draw(); input.focus(); }
  function close() { pal.removeAttribute("open"); }
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); return; }
    if (!pal.hasAttribute("open")) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(cur + 1, shown.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(cur - 1, 0); draw(); }
    else if (e.key === "Enter" && shown[cur]) { window.location.href = shown[cur].href; }
  });
  input.addEventListener("input", function () { cur = 0; draw(); });
  pal.querySelector(".scrim").addEventListener("click", close);
  var opener = document.getElementById("palopen");
  if (opener) opener.addEventListener("click", open);

  function flash(btn, text) {
    var was = btn.getAttribute("data-was") || btn.textContent;
    btn.setAttribute("data-was", was);
    btn.textContent = text;
    setTimeout(function () { btn.textContent = was; }, 1400);
  }

  // DELEGATED, not bound by id: the SSE refresh swaps <main> wholesale, so listeners attached
  // to elements inside it would be dead after the first update.
  document.addEventListener("click", function (e) {
    var copy = e.target.closest && e.target.closest("[data-copy]");
    if (copy) {
      var value = copy.getAttribute("data-copy") || "";
      if (navigator.clipboard) navigator.clipboard.writeText(value).then(
        function () { flash(copy, "Copied"); },
        function () { flash(copy, "Copy failed"); }
      );
      else flash(copy, "Copy unavailable");
      return;
    }
    var open = e.target.closest && e.target.closest("#openedit");
    if (open) {
      // POST, not GET: a GET that spawns a process lands in history and is fetchable by any
      // same-origin <img src>. The body carries a ledger row reference, never a real path.
      fetch("/api/v1/open", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: open.getAttribute("data-plan"),
          path: open.getAttribute("data-path"),
          line: open.getAttribute("data-line") || null
        })
      }).then(function (r) { return r.json(); }).then(function (j) {
        flash(open, j && j.ok ? "Opened" : "Failed: " + ((j && j.error) || "unknown"));
      }, function () { flash(open, "Failed"); });
      return;
    }
    var th = e.target.closest && e.target.closest("table.sortable th");
    if (th) sortBy(th);
  });

  // Relative ages tick locally off data-ts. No network, no server round-trip — the only thing
  // SSE is needed for is learning that NEW activity happened.
  function ago(secs) {
    if (secs < 60) return "just now";
    if (secs < 3600) return Math.floor(secs / 60) + "m ago";
    if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
    return Math.floor(secs / 86400) + "d ago";
  }
  function tickAges() {
    var now = Date.now() / 1000;
    var cells = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < cells.length; i++) {
      var ts = parseFloat(cells[i].getAttribute("data-ts"));
      if (isFinite(ts)) cells[i].textContent = ago(Math.max(0, now - ts));
    }
  }
  tickAges();
  setInterval(tickAges, 1000);

  function sortBy(th) {
    var table = th.closest("table");
    var body = table.tBodies[0];
    if (!body) return;
    var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
    var dir = th.getAttribute("data-dir") === "asc" ? -1 : 1;
    var heads = th.parentNode.children;
    for (var h = 0; h < heads.length; h++) heads[h].removeAttribute("data-dir");
    th.setAttribute("data-dir", dir === 1 ? "asc" : "desc");
    var numeric = th.classList.contains("num");
    var rows = Array.prototype.slice.call(body.rows);
    rows.sort(function (a, b) {
      var x = (a.cells[idx] || {}).textContent || "";
      var y = (b.cells[idx] || {}).textContent || "";
      if (numeric) {
        var nx = parseFloat(x.replace(/[^0-9.eE+-]/g, ""));
        var ny = parseFloat(y.replace(/[^0-9.eE+-]/g, ""));
        if (!isFinite(nx)) nx = -Infinity;
        if (!isFinite(ny)) ny = -Infinity;
        return (nx - ny) * dir;
      }
      return x.localeCompare(y) * dir;
    });
    for (var r = 0; r < rows.length; r++) body.appendChild(rows[r]);
  }

  document.addEventListener("input", function (e) {
    if (!e.target.matches || !e.target.matches("input.tfilter")) return;
    var q = e.target.value.toLowerCase();
    var table = document.getElementById(e.target.getAttribute("data-for"));
    if (!table || !table.tBodies[0]) return;
    var rows = table.tBodies[0].rows;
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = !q || rows[i].textContent.toLowerCase().indexOf(q) >= 0;
      rows[i].style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    var count = document.getElementById(e.target.getAttribute("data-for") + "-count");
    if (count) count.textContent = shown + " of " + rows.length + " rows";
  });

  // Tooltip layer. The native <title> stays in the markup as the no-JS fallback; this replaces
  // its ~1s delay with something usable.
  var tip = document.createElement("div");
  tip.className = "tip";
  document.body.appendChild(tip);
  document.addEventListener("mousemove", function (e) {
    var host = e.target.closest && e.target.closest("[data-hover]");
    if (!host) { tip.classList.remove("on"); return; }
    tip.textContent = host.getAttribute("data-hover");
    tip.classList.add("on");
    var pad = 14;
    var w = tip.offsetWidth;
    var x = Math.min(Math.max(pad, e.clientX + pad), window.innerWidth - w - pad);
    var y = e.clientY + pad + tip.offsetHeight > window.innerHeight
      ? e.clientY - tip.offsetHeight - pad
      : e.clientY + pad;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  });

  // One EventSource per tab against ONE server-side poller. The payload is just the newest
  // event timestamp; the page decides whether that is worth re-fetching, and no event history
  // is kept client-side — the whole point is that an idle tab accumulates nothing.
  var live = document.getElementById("live");
  var seen = null;
  var busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    fetch(window.location.href, { credentials: "same-origin", headers: { "x-partial": "1" } })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var doc = new DOMParser().parseFromString(text, "text/html");
        var next = doc.querySelector("main");
        var cur = document.querySelector("main");
        if (next && cur) {
          var top = window.scrollY;
          cur.innerHTML = next.innerHTML;
          window.scrollTo(0, top);
          tickAges();
        }
        busy = false;
      }, function () { busy = false; });
  }
  function setLive(text) { if (live) live.textContent = text; }
  if (window.EventSource) {
    var es = new EventSource("/api/v1/stream");
    // ANY frame proves the stream is up, so the label heals itself after a blip. Keying the
    // reset off "seen === null" meant one reconnect left it reading "reconnecting" forever.
    es.addEventListener("activity", function (ev) {
      setLive("Live");
      var data = {};
      try { data = JSON.parse(ev.data); } catch (err) { return; }
      if (seen === null) { seen = data.newest; return; }
      if (data.newest !== seen) { seen = data.newest; refresh(); }
    });
    es.addEventListener("ping", function () { setLive("Live"); });
    es.addEventListener("full", function () {
      es.close();
      setLive("Live (too many tabs)");
    });
    es.onerror = function () { setLive("Live: reconnecting"); };
  } else {
    setLive("Live unsupported");
  }
})();
`;

export function shell(opts: ShellOptions): string {
  const links = opts.nav
    .map(
      (n) =>
        `<a href="${escapeHtml(n.href)}"${n.active ? ' aria-current="page"' : ""}>${escapeHtml(n.label)}</a>`,
    )
    .join("");
  const options = [
    `<option value=""${opts.scope === null ? " selected" : ""}>All projects</option>`,
    ...opts.projects.map(
      (p) =>
        `<option value="${escapeHtml(p.project_key)}"${p.project_key === opts.scope ? " selected" : ""}>${escapeHtml(p.project_key)} (${p.runs})</option>`,
    ),
  ].join("");
  const filter =
    opts.projectFilter === false
      ? ""
      : `<select id="scope" aria-label="Project scope">${options}</select>`;
  const palette: PaletteItem[] = [
    ...opts.nav.map((n) => ({ kind: "view", label: n.label, href: n.href })),
    ...opts.projects.map((p) => ({
      kind: "project",
      label: p.project_key,
      href: `/?project=${encodeURIComponent(p.project_key)}`,
    })),
    ...(opts.commands ?? []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(opts.title)} — Minima</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><b>Minima</b><span class="ro">read-only</span></div>
    <nav>${links}</nav>
    <div class="side-foot">
      <div>${escapeHtml(opts.ledgerPath)}</div>
      <button class="ghost" id="palopen" type="button" style="margin-top:10px;width:100%">Search <span class="kbd">⌘K</span></button>
    </div>
  </aside>
  <div class="col">
    <header class="top">
      <h1>${escapeHtml(opts.title)}</h1>
      <span class="spacer"></span>
      <div class="controls">
        <span id="live" title="server-sent activity stream">connecting</span>
        ${filter}
        <button class="ghost" id="theme" type="button" aria-label="Toggle theme">◐</button>
      </div>
    </header>
    <main>${opts.body}</main>
  </div>
</div>
<div id="pal" data-items="${escapeHtml(JSON.stringify(palette))}">
  <div class="scrim"></div>
  <div class="box">
    <input type="text" placeholder="Jump to a view, project, session or plan…" aria-label="Search" />
    <ul></ul>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function kpiTiles(kpis: Kpi[]): string {
  return `<div class="kpis">${kpis
    .map(
      (k) =>
        `<div class="kpi${k.raw === null ? " nodata" : ""}">
          <div class="label">${escapeHtml(k.label)}</div>
          <div class="value">${escapeHtml(k.value)}</div>
          <div class="note">${escapeHtml(k.note)}</div>
        </div>`,
    )
    .join("")}</div>`;
}

function meter(rate: number): string {
  return `<span class="meter"><span class="track"><span class="fill" style="width:${Math.round(rate * 100)}%;background:${seqStep(rate)}"></span></span><span>${fmtPct(rate)}</span></span>`;
}

export function overviewView(payload: OverviewPayload, runs: RunSummary[], now: number): string {
  const spend: AreaPoint[] = payload.spendByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.cost_usd,
    hover: `${d.day}: ${fmtUsd(d.cost_usd)} over ${d.n} decisions`,
  }));
  const models: BarRow[] = payload.models.slice(0, 10).map((m) => ({
    label: m.model,
    value: m.n,
    display: String(m.n),
    hover: `${m.n} decisions · ${fmtUsd(m.cost_usd)} · ${fmtPct(m.share)} of traffic`,
  }));
  const tiers = statusBar([
    { key: "green", label: "Green (deterministic)", icon: "✔", n: payload.gates.green },
    { key: "yellow", label: "Yellow (flag)", icon: "▲", n: payload.gates.yellow },
    { key: "red", label: "Red (stop)", icon: "✖", n: payload.gates.red },
    { key: "ungraded", label: "Ungraded", icon: "•", n: payload.gates.ungraded },
  ]);

  const scoreboard =
    payload.scoreboard.length === 0
      ? emptyState(
          `No task-type × model cell has reached n ≥ ${payload.minN} yet — small-n cells are suppressed on purpose.`,
        )
      : dataTable(payload.scoreboard.slice(0, 20), [
          { header: "Task type", cell: (c) => escapeHtml(c.taskType) },
          { header: "Model", cell: (c) => `<span class="mono">${escapeHtml(c.model)}</span>` },
          { header: "n", numeric: true, cell: (c) => String(c.n) },
          { header: "Green rate", cell: (c) => meter(c.greenRate) },
          { header: "Reds", numeric: true, cell: (c) => String(c.reds) },
          { header: "Median cost", numeric: true, cell: (c) => fmtUsd(c.medianCostUsd) },
        ]);

  return `${kpiTiles(payload.kpis)}
<section class="card">
  <h2>Realized spend per day</h2>
  ${areaChart(spend, { valueFmt: (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`) })}
  <p class="note">Quiet days are zero-filled. Without that the series simply omits them, and the
  line drawn across the gap reads as steady spend when the truth is none.</p>
</section>
<div class="grid-2">
  <section class="card">
    <h2>Decisions by model</h2>
    ${barChart(models)}
  </section>
  <section class="card">
    <h2>Verification gate tiers</h2>
    ${tiers}
    ${gateReasons(payload.gates)}
  </section>
</div>
<section class="card">
  <h2>Step-check outcomes</h2>
  ${passRateBar(payload.passRate)}
  <p class="note">Read from <span class="mono">factors_json.pass</span>, which is populated on
  every step check — unlike <span class="mono">gates.confidence</span>, which is NULL on nearly
  all of them by design. There is deliberately no tier-rate trend line: with so few greens it
  would be a flat zero implying a precision this data does not have.</p>
</section>
<section class="card">
  <h2>Task type × model — learned outcomes</h2>
  ${scoreboard}
  <p class="note">Cells with n &lt; ${payload.minN} are suppressed; this table is advisory and never re-ranks routing.</p>
</section>
<section class="card">
  <h2>Recent sessions</h2>
  ${runsTable(runs.slice(0, 10), now)}
</section>`;
}

/**
 * Pass/fail over deterministic step checks. A status bar rather than a trend, because that is
 * the shape the data supports: a binary outcome with full coverage and no meaningful daily
 * granularity at this sample size.
 */
function passRateBar(rate: PassRate): string {
  if (rate.pass + rate.fail === 0) {
    return emptyState("No step check has recorded a deterministic outcome yet.");
  }
  const segments: StatusSegment[] = [
    { key: "green", label: "Check passed", icon: "✔", n: rate.pass },
    { key: "red", label: "Check did not pass", icon: "✖", n: rate.fail },
  ];
  if (rate.unknown > 0) {
    segments.push({ key: "ungraded", label: "No parseable outcome", icon: "•", n: rate.unknown });
  }
  const bar = statusBar(segments);
  return `${bar}<p class="note">${fmtPct(rate.rate)} of ${rate.pass + rate.fail} graded step
  checks passed${rate.unknown > 0 ? ` · ${rate.unknown} carried no parseable outcome and are excluded from the rate, never counted as failures` : ""}.</p>`;
}

/** Why gates landed where they did — a tier chart without this is not actionable. */
function gateReasons(gates: OverviewPayload["gates"]): string {
  if (gates.reasons.length === 0) return "";
  const cls: Record<string, string> = { red: "bad", yellow: "warn", green: "good" };
  const rows = gates.reasons
    .map(
      (r) =>
        `<tr><td><span class="pill ${cls[r.tier] ?? ""}">${escapeHtml(r.tier)}</span></td>
         <td class="wrap">${escapeHtml(r.reason)}</td>
         <td class="num">${r.n}</td>
         <td class="num">${gates.total > 0 ? Math.round((r.n / gates.total) * 100) : 0}%</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Tier</th><th>Reason</th><th class="num">Gates</th><th class="num">Share</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  <p class="note">Tier is derived the same way <span class="mono">/why</span> derives it — the stored
  <span class="mono">confidence</span> column when set, else recomputed from
  <span class="mono">factors_json</span>. Step checks are written with no stored tier by design, so
  reading the column alone would report them all as ungraded.</p>`;
}

function runsTable(runs: RunSummary[], now: number): string {
  return dataTable(
    runs,
    [
      {
        header: "Session",
        cell: (r) =>
          `<a href="/runs/${encodeURIComponent(r.run_id)}">${escapeHtml(r.display_name ?? r.run_id.slice(0, 8))}</a>`,
      },
      { header: "Project", cell: (r) => `<span class="mono">${escapeHtml(r.project_key)}</span>` },
      { header: "Status", cell: (r) => statusPill(r.status) },
      { header: "Decisions", numeric: true, cell: (r) => String(r.decisions) },
      { header: "Spend", numeric: true, cell: (r) => fmtUsd(r.cost_usd) },
      {
        header: "Tools",
        numeric: true,
        cell: (r) =>
          r.tool_errors > 0 ? `${r.tool_calls} (${r.tool_errors} err)` : String(r.tool_calls),
      },
      {
        // MAX(events.ts), not runs.updated — see stats.ts:sessionList for why the stored
        // column and the stored status are both unusable as recency.
        header: "Last activity",
        numeric: true,
        cell: (r) => agoCell(r.last_event ?? null, now),
      },
    ],
    "No sessions recorded yet — run `minima` in a repo to populate the ledger.",
    "t-sessions",
  );
}

function statusPill(status: string): string {
  const cls =
    status === "done" ? "good" : status === "active" ? "" : status === "degraded" ? "warn" : "bad";
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

export function runsView(list: SessionList, now: number): string {
  const freshness =
    list.newest === null
      ? "No session has recorded any activity."
      : `Newest recorded activity ${fmtAgo(list.newest, now)}. Ordered by real activity, not by <span class="mono">runs.updated</span> — that column is written only at create and close.`;
  const hidden =
    list.hidden > 0
      ? ` ${list.hidden} run row${list.hidden === 1 ? "" : "s"} with zero recorded events hidden as empty shells.`
      : "";
  return `<section class="card">${tableFilter("t-sessions", "Sessions", list.rows.length)}${runsTable(list.rows, now)}
  <p class="note">${freshness}${escapeHtml(hidden)}</p></section>`;
}

export function runView(detail: RunDetail, now: number): string {
  const d = detail;
  const tools: BarRow[] = d.tools.map((t) => ({
    label: t.tool,
    value: t.n,
    display: t.errors > 0 ? `${t.n} · ${t.errors} err` : String(t.n),
    hover: `${t.n} calls, ${t.errors} errors`,
  }));
  return `<section class="card">
  <h2>${escapeHtml(d.run.display_name ?? d.run.run_id)}</h2>
  <p class="note"><span class="mono">${escapeHtml(d.run.run_id)}</span> · ${escapeHtml(d.run.project_key)} · ${statusPill(d.run.status)} · updated ${agoCell(d.run.updated, now)}</p>
</section>
<div class="kpis">
  <div class="kpi"><div class="label">Decisions</div><div class="value">${d.run.decisions}</div><div class="note">routed this session</div></div>
  <div class="kpi"><div class="label">Spend</div><div class="value">${escapeHtml(fmtUsd(d.run.cost_usd))}</div><div class="note">realized cost</div></div>
  <div class="kpi"><div class="label">Tool calls</div><div class="value">${d.run.tool_calls}</div><div class="note">${d.run.tool_errors} errored</div></div>
</div>
<section class="card"><h2>Routing decisions</h2>${decisionsTable(d.decisions, now)}</section>
<div class="grid-2">
  <section class="card"><h2>Tool usage</h2>${barChart(tools)}</section>
  <section class="card"><h2>Plans</h2>${plansTable(d.plans, now)}</section>
</div>`;
}

function decisionsTable(rows: DecisionRecord[], now: number): string {
  return dataTable(
    rows.slice(0, 200),
    [
      { header: "When", numeric: true, cell: (r) => agoCell(r.ts, now) },
      { header: "Task", cell: (r) => escapeHtml(r.task_type ?? "—") },
      {
        header: "Model",
        cell: (r) => `<span class="mono">${escapeHtml(r.chosen_model ?? "—")}</span>`,
      },
      {
        header: "Basis",
        cell: (r) => `<span class="pill">${escapeHtml(r.decision_basis ?? "—")}</span>`,
      },
      { header: "Routed", cell: (r) => escapeHtml(r.routed) },
      {
        header: "Outcome",
        cell: (r) =>
          r.outcome
            ? `<span class="pill ${outcomeClass(r.outcome)}">${escapeHtml(r.outcome)}</span>`
            : '<span class="pill">unlabeled</span>',
      },
      {
        header: "Quality",
        numeric: true,
        cell: (r) => (r.judged && r.quality !== null ? r.quality.toFixed(2) : "abstain"),
      },
      { header: "Cost", numeric: true, cell: (r) => fmtUsd(r.actual_cost_usd) },
      {
        header: "Latency",
        numeric: true,
        cell: (r) => (r.latency_ms === null ? "—" : `${Math.round(r.latency_ms)}ms`),
      },
    ],
    "No routing decisions recorded.",
  );
}

function outcomeClass(outcome: string): string {
  if (outcome === "success") return "good";
  if (outcome === "partial") return "warn";
  if (outcome === "failure") return "bad";
  return "";
}

export function routingView(
  payload: OverviewPayload,
  decisions: DecisionRecord[],
  now: number,
): string {
  const table = dataTable(
    payload.models,
    [
      { header: "Model", cell: (m) => `<span class="mono">${escapeHtml(m.model)}</span>` },
      { header: "Decisions", numeric: true, cell: (m) => String(m.n) },
      { header: "Share", cell: (m) => meter(m.share) },
      { header: "Spend", numeric: true, cell: (m) => fmtUsd(m.cost_usd) },
      { header: "Cost/call", numeric: true, cell: (m) => fmtUsd(m.costPerCall) },
      {
        header: "Avg quality",
        numeric: true,
        cell: (m) => (m.avgQuality === null ? "—" : `${m.avgQuality.toFixed(2)} (n=${m.judged_n})`),
      },
      {
        header: "Avg latency",
        numeric: true,
        cell: (m) => (m.avgLatencyMs === null ? "—" : `${Math.round(m.avgLatencyMs)}ms`),
      },
    ],
    "No routing decisions recorded yet.",
  );
  return `<section class="card"><h2>Model mix</h2>${table}
  <p class="note">Avg quality is over judged rows only — abstentions are excluded, not counted as zero.</p></section>
<section class="card"><h2>Recent decisions</h2>${decisionsTable(decisions, now)}</section>`;
}

function plansTable(plans: PlanSummary[], now: number): string {
  return dataTable(
    plans,
    [
      {
        header: "Plan",
        cell: (p) =>
          `<a href="/plans/${encodeURIComponent(p.id)}">${escapeHtml(p.title ?? p.id.slice(0, 8))}</a>`,
      },
      { header: "Status", cell: (p) => `<span class="pill">${escapeHtml(p.status ?? "—")}</span>` },
      { header: "Progress", cell: (p) => (p.steps > 0 ? meter(p.done / p.steps) : "—") },
      { header: "Steps", numeric: true, cell: (p) => `${p.done}/${p.steps}` },
      { header: "Gates", numeric: true, cell: (p) => String(p.gates) },
      {
        // Checks present vs checks that can actually prove a red→green transition. On a real
        // ledger this reads 172 and 25 — the gap is why almost nothing reaches green.
        header: "Checks",
        numeric: true,
        cell: (p) =>
          p.verify_steps === 0 ? "—" : `${p.verify_steps} · ${p.baseline_steps} w/ baseline`,
      },
      { header: "Writes", numeric: true, cell: (p) => (p.changes > 0 ? String(p.changes) : "—") },
      {
        header: "Last activity",
        numeric: true,
        cell: (p) => agoCell(p.last_event ?? null, now),
      },
    ],
    "No plans recorded yet.",
    "t-plans",
  );
}

export function plansView(
  plans: PlanSummary[],
  gates: OverviewPayload["gates"],
  now: number,
): string {
  return `<section class="card">
  <h2>Verification gate tiers</h2>
  ${statusBar([
    { key: "green", label: "Green (deterministic)", icon: "✔", n: gates.green },
    { key: "yellow", label: "Yellow (flag)", icon: "▲", n: gates.yellow },
    { key: "red", label: "Red (stop)", icon: "✖", n: gates.red },
    { key: "ungraded", label: "Ungraded", icon: "•", n: gates.ungraded },
  ])}
  <p class="note">Tiers derive through the same <span class="mono">gateVerdictFor</span> path
  <span class="mono">/why</span> uses — the stored tier when set, else recomputed from
  <span class="mono">factors_json</span>. Reading <span class="mono">gates.confidence</span>
  directly would report most step checks as ungraded.</p>
</section>
<section class="card">${tableFilter("t-plans", "Plans", plans.length)}${plansTable(plans, now)}</section>`;
}

const TIER_GLYPH: Record<string, string> = { green: "✔", yellow: "▲", red: "✖" };
const STATUS_GLYPH: Record<string, string> = {
  pending: "○",
  in_progress: "◑",
  completed: "●",
  unknown: "·",
};

function tierBadge(tier: string | null, reason: string | null): string {
  if (!tier) {
    return `<span class="tier tier-none"><span class="g">·</span>${escapeHtml(reason ?? "not verified")}</span>`;
  }
  return `<span class="tier tier-${escapeHtml(tier)}"><span class="g">${TIER_GLYPH[tier] ?? "·"}</span>${escapeHtml(tier)}${reason ? ` — ${escapeHtml(reason)}` : ""}</span>`;
}

/** The check line: the command, then what the ledger can and cannot prove about it. */
function checkLine(t: TaskRow): string {
  if (!t.verify) {
    return `<div class="t-check"><span class="t-evid">no check attached — this step is flagged, never verified</span></div>`;
  }
  const bits: string[] = [];
  if (t.pass === true) bits.push("check passed");
  else if (t.pass === false) bits.push("check did not pass");
  // Two DIFFERENT failures, and conflating them puts a false sentence on the page: a step can
  // have captured a baseline and still not have flipped. The missing-baseline case is the
  // common one — 147 of 172 checked steps on a real ledger never captured one, which is why
  // almost nothing reaches green.
  if (!t.hasBaseline) bits.push("no baseline captured — red→green cannot be proven");
  else if (t.redToGreen === false)
    bits.push("baseline captured, but the check never went red→green");
  if (t.checkOrigin) bits.push(`origin ${t.checkOrigin}`);
  return `<div class="t-check"><code>${escapeHtml(t.verify)}</code>${
    bits.length > 0 ? `<span class="t-evid">${escapeHtml(bits.join(" · "))}</span>` : ""
  }</div>`;
}

/**
 * Path chips. Each one links straight into the in-page viewer — that is the default action,
 * because zero friction beats any link that needs a scheme handler. The href carries the plan
 * id and the exact recorded path, never a filesystem path.
 */
function pathChips(items: ChangeClass[], planId: string): string {
  if (items.length === 0) return "";
  return `<ul class="paths">${items
    .map((c) => {
      const weak = c.rule === "filename";
      const why = weak
        ? `claimed by step ${(c.stepIdx ?? 0) + 1} (filename only)`
        : c.stepIdx !== null
          ? `claimed by step ${c.stepIdx + 1} (path)`
          : "off-plan";
      const ahead = c.workedAhead ? " · written ahead of the active step" : "";
      const href = `/files?plan=${encodeURIComponent(planId)}&path=${encodeURIComponent(c.change.path)}`;
      return `<li class="${weak ? "weak" : ""}" title="${escapeHtml(`${c.change.kind} · ${why}${ahead}`)}"><a href="${escapeHtml(href)}">${escapeHtml(c.change.path)}</a></li>`;
    })
    .join("")}</ul>`;
}

/** The viewer. Every failure is a state with an explanation, and copy always works. */
export function fileView(
  file: FileContent,
  planId: string,
  planTitle: string,
  editor: string | null,
): string {
  const copyable = escapeHtml(file.absPath ?? file.path);
  const bar = `<div class="fbar">
  <span class="fpath">${escapeHtml(file.path)}</span>
  <span class="spacer"></span>
  ${
    file.absPath && editor
      ? `<button class="ghost" id="openedit" type="button" data-plan="${escapeHtml(planId)}" data-path="${escapeHtml(file.path)}">Open in ${escapeHtml(editor)}</button>`
      : file.absPath
        ? `<span class="pill" title="pass --editor to enable, or install one on PATH">no editor detected</span>`
        : ""
  }
  <button class="ghost" id="copypath" type="button" data-copy="${copyable}">Copy path</button>
</div>`;

  const meta =
    file.status === "ok" || file.status === "truncated"
      ? `<p class="note">${file.lines} lines · ${Math.round((file.bytes ?? 0) / 1024) || "<1"}KB${
          file.absPath ? ` · <span class="mono">${escapeHtml(file.absPath)}</span>` : ""
        }</p>`
      : "";

  // The copy button keeps working in every failure state — a dead link with no way to grab the
  // path is worse than the honest gap.
  const body =
    file.shown.length === 0
      ? `<div class="banner">${escapeHtml(file.note ?? "nothing to show")}</div>`
      : `${file.status === "truncated" ? `<div class="banner">${escapeHtml(file.note ?? "")}</div>` : ""}
<div class="src"><table class="code"><tbody>${file.shown
          .map((l, i) => {
            const prev = file.shown[i - 1];
            const gap =
              prev && l.n !== prev.n + 1
                ? `<tr class="gap"><td class="ln">⋯</td><td>${l.n - prev.n - 1} lines not shown</td></tr>`
                : "";
            return `${gap}<tr><td class="ln">${l.n}</td><td>${escapeHtml(l.text)}</td></tr>`;
          })
          .join("")}</tbody></table></div>`;

  return `<p class="crumb"><a href="/plans">Plans</a> / <a href="/plans/${encodeURIComponent(planId)}">${escapeHtml(planTitle)}</a> / ${escapeHtml(file.path)}</p>
<section class="card">${bar}${meta}${body}</section>`;
}

export function planDetailView(view: PlanView, now: number): string {
  const p = view.plan;
  const tasks =
    view.tasks.length === 0
      ? emptyState("This plan has no steps recorded.")
      : `<ol class="tasks">${view.tasks
          .map(
            (t) => `<li class="task" data-status="${escapeHtml(t.status)}">
    <div class="t-gutter"><span>${t.idx + 1}</span><span title="${escapeHtml(t.status)}">${STATUS_GLYPH[t.status] ?? "·"}</span></div>
    <div class="t-body">
      <div class="t-title">${escapeHtml(t.content || "(no description recorded)")}</div>
      <div class="t-meta">${tierBadge(t.tier, t.tierReason)}${
        t.gateCount > 0
          ? `<span class="pill">${t.gateCount} gate${t.gateCount === 1 ? "" : "s"}</span>`
          : ""
      }</div>
      ${checkLine(t)}
      ${pathChips(t.claimed, p.id)}
    </div>
    <div class="t-cost">${t.costUsd === null ? "—" : escapeHtml(fmtUsd(t.costUsd))}</div>
  </li>`,
          )
          .join("")}</ol>`;

  const drift = driftPanel(view);
  return `<p class="crumb"><a href="/plans">Plans</a> / ${escapeHtml(p.title ?? p.id.slice(0, 8))}</p>
<div class="kpis">
  <div class="kpi"><div class="label">Step</div><div class="value">${view.position}/${view.total}</div><div class="note">${p.done} completed${p.in_progress > 0 ? ` · ${p.in_progress} in progress` : ""}</div></div>
  <div class="kpi"><div class="label">Checks</div><div class="value">${p.verify_steps}/${view.total}</div><div class="note">${view.verifyWithoutBaseline} with no baseline captured</div></div>
  <div class="kpi"><div class="label">Off-plan writes</div><div class="value">${view.offPlan.length}/${p.changes}</div><div class="note">recomputed · ledger column said ${view.storedOffPlan}</div></div>
  <div class="kpi${view.costUsd === 0 ? " nodata" : ""}"><div class="label">Step-attributed spend</div><div class="value">${view.costUsd === 0 ? "no data" : escapeHtml(fmtUsd(view.costUsd))}</div><div class="note">${escapeHtml(fmtUsd(view.unattributedUsd))} of this run's spend claims no step</div></div>
</div>
<section class="card">
  <h2>Tasks</h2>
  <p class="note">Status glyph is the stored step status; the tier beside it is derived, not the
  <span class="mono">gates.confidence</span> column. Realized $ comes from the
  <span class="mono">step_id</span> stamp — a step with no stamped decision shows
  &ldquo;—&rdquo;, never $0.00.</p>
  ${tasks}
</section>
${drift}
<section class="card">
  <h2>Session</h2>
  <p class="note">${
    p.session_id
      ? `<a href="/runs/${encodeURIComponent(p.session_id)}" class="mono">${escapeHtml(p.session_id)}</a> · ${escapeHtml(p.project_key ?? "unknown project")} · last recorded activity ${agoCell(p.last_event ?? null, now)}`
      : "This plan is not attached to any session."
  }</p>
</section>`;
}

/**
 * Off-plan writes, recomputed. Always shows what the stored column claimed next to the new
 * number — the point is the difference, and asserting an improvement without showing the
 * before is exactly as unhelpful as shipping the frozen column.
 */
function driftPanel(view: PlanView): string {
  const total = view.plan.changes;
  const rows: { label: string; n: number; note: string }[] = [
    {
      label: "Claimed by a step (path match)",
      n: view.onPlanStrong,
      note: "step text names the path or a ≥2-segment suffix of it",
    },
    {
      label: "Claimed by a step (filename only)",
      n: view.onPlanWeak,
      note: "weaker rule — counted separately on purpose",
    },
    {
      label: "Off-plan",
      n: view.offPlan.length,
      note: "no step in this plan lays claim to the path",
    },
    {
      label: "Unattributable",
      n: view.unattributable.length,
      note: "opaque write — no path any rule could match",
    },
  ];
  const table = `<div class="table-wrap"><table>
  <thead><tr><th>Classification</th><th class="num">Writes</th><th class="num">Share</th><th>Rule</th></tr></thead>
  <tbody>${rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.label)}</td><td class="num">${r.n}</td><td class="num">${total > 0 ? fmtPct(r.n / total) : "—"}</td><td>${escapeHtml(r.note)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;

  const ahead =
    view.workedAhead.length > 0
      ? `<p class="note">${view.workedAhead.length} write${view.workedAhead.length === 1 ? "" : "s"} landed
      before the claiming step became active — work done out of order, which is not drift but is
      not nothing either.</p>`
      : "";

  return `<section class="card">
  <h2>Write attribution</h2>
  <p class="note">The stored <span class="mono">file_changes.origin</span> column is computed
  once at write time against only the then-in-progress step, by a bare-basename substring match,
  and short-circuits straight to off-plan whenever no step was in progress. It said
  <strong>${view.storedOffPlan}</strong> of ${total} were off-plan. Recomputed against every step
  in the plan with a stricter rule, it is <strong>${view.offPlan.length}</strong>. This is a
  heuristic either way — hover a path to see which step claimed it and how.</p>
  ${total === 0 ? emptyState("No file changes recorded against this plan.") : table}
  ${ahead}
  ${view.offPlan.length > 0 ? `<h2 style="margin-top:16px">Off-plan paths</h2>${pathChips(view.offPlan, view.plan.id)}` : ""}
</section>`;
}

export function memoryView(rows: MemorySummary[], now: number): string {
  const table = dataTable(
    rows,
    [
      { header: "Kind", cell: (m) => `<span class="pill">${escapeHtml(m.kind)}</span>` },
      {
        header: "Status",
        cell: (m) =>
          `<span class="pill ${m.status === "pinned" || m.status === "active" ? "good" : m.status === "rejected" ? "bad" : "warn"}">${escapeHtml(m.status)}</span>`,
      },
      { header: "Content", cell: (m) => `<span class="wrap">${escapeHtml(m.content)}</span>` },
      { header: "Origin", cell: (m) => escapeHtml(`${m.origin}/${m.evidence_source}`) },
      { header: "Updated", numeric: true, cell: (m) => agoCell(m.updated, now) },
    ],
    "No memories curated yet.",
  );
  const banner = `<div class="banner">A view, not a control surface. Pin, confirm and reject live in
  <span class="mono">/memory</span> inside the harness, which appends an audited
  <span class="mono">memory_events</span> row for every change; this process holds a readonly
  handle and cannot write one.</div>`;
  return `${banner}<section class="card"><h2>Memory ledger</h2>${table}</section>`;
}

export function costView(payload: OverviewPayload, budgets: BudgetSummary[], now: number): string {
  const spend: AreaPoint[] = payload.spendByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.cost_usd,
    hover: `${d.day}: ${fmtUsd(d.cost_usd)} over ${d.n} decisions`,
  }));
  const budgetTable = dataTable(
    budgets,
    [
      { header: "Scope", cell: (b) => `<span class="mono">${escapeHtml(b.scope_key)}</span>` },
      { header: "Mode", cell: (b) => `<span class="pill">${escapeHtml(b.mode)}</span>` },
      {
        header: "Used",
        cell: (b) => (b.limit_usd > 0 ? meter(Math.min(1, b.spent_usd / b.limit_usd)) : "—"),
      },
      { header: "Spent", numeric: true, cell: (b) => fmtUsd(b.spent_usd) },
      { header: "Reserved", numeric: true, cell: (b) => fmtUsd(b.reserved_usd) },
      { header: "Limit", numeric: true, cell: (b) => fmtUsd(b.limit_usd) },
      { header: "Updated", numeric: true, cell: (b) => agoCell(b.updated, now) },
    ],
    "No budget scopes recorded.",
  );
  return `${kpiTiles(payload.kpis.filter((k) => k.key !== "runs" && k.key !== "gate_green"))}
<section class="card"><h2>Realized spend per day</h2>${areaChart(spend, { valueFmt: (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`) })}</section>
<section class="card"><h2>Budget ledger</h2>${budgetTable}</section>`;
}

export function notFoundView(path: string): string {
  return `<section class="card"><h2>Not found</h2><p class="empty">Nothing at <span class="mono">${escapeHtml(path)}</span>.</p><p class="note"><a href="/">Back to overview</a></p></section>`;
}
