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
 * The only client JS is the theme toggle, an auto-refresh timer, the scope <select>, and the
 * cmd-K palette — every number on the page is computed server-side.
 */

import {
  type AreaPoint,
  type BarRow,
  areaChart,
  barChart,
  dataTable,
  emptyState,
  escapeHtml,
  seqStep,
  statusBar,
} from "./charts.ts";
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
import type { Kpi, OverviewPayload } from "./stats.ts";

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
  readOnly: boolean;
  body: string;
  /** Extra cmd-K targets beyond nav + projects; views supply plans/sessions. */
  commands?: PaletteItem[];
}

export const fmtUsd = (n: number | null): string => {
  if (n === null) return "—";
  const mag = Math.abs(n);
  return `${n < 0 ? "-" : ""}${mag >= 1 ? `$${mag.toFixed(2)}` : `$${mag.toFixed(4)}`}`;
};

export const fmtPct = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

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

  var refresh = document.getElementById("refresh");
  var timer = null;
  function label() { refresh.textContent = timer ? "Auto-refresh: on" : "Auto-refresh: off"; }
  if (refresh) {
    refresh.addEventListener("click", function () {
      if (timer) { clearInterval(timer); timer = null; }
      else { timer = setInterval(function () { window.location.reload(); }, 10000); }
      try { localStorage.setItem("minima-dash-refresh", timer ? "1" : "0"); } catch (e) {}
      label();
    });
    try {
      if (localStorage.getItem("minima-dash-refresh") === "1") {
        timer = setInterval(function () { window.location.reload(); }, 10000);
      }
    } catch (e) {}
    label();
  }

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
    <div class="brand"><b>Minima</b><span class="ro">${opts.readOnly ? "read-only" : "writes on"}</span></div>
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
        <select id="scope" aria-label="Project scope">${options}</select>
        <button class="ghost" id="refresh" type="button">Auto-refresh: off</button>
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
  <h2>Task type × model — learned outcomes</h2>
  ${scoreboard}
  <p class="note">Cells with n &lt; ${payload.minN} are suppressed; this table is advisory and never re-ranks routing.</p>
</section>
<section class="card">
  <h2>Recent sessions</h2>
  ${runsTable(runs.slice(0, 10), now)}
</section>`;
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
      { header: "Updated", numeric: true, cell: (r) => escapeHtml(fmtAgo(r.updated, now)) },
    ],
    "No sessions recorded yet — run `minima` in a repo to populate the ledger.",
  );
}

function statusPill(status: string): string {
  const cls =
    status === "done" ? "good" : status === "active" ? "" : status === "degraded" ? "warn" : "bad";
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

export function runsView(runs: RunSummary[], now: number): string {
  return `<section class="card"><h2>Sessions</h2>${runsTable(runs, now)}</section>`;
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
  <p class="note"><span class="mono">${escapeHtml(d.run.run_id)}</span> · ${escapeHtml(d.run.project_key)} · ${statusPill(d.run.status)} · updated ${escapeHtml(fmtAgo(d.run.updated, now))}</p>
</section>
<div class="kpis">
  <div class="kpi"><div class="label">Decisions</div><div class="value">${d.run.decisions}</div><div class="note">routed this session</div></div>
  <div class="kpi"><div class="label">Spend</div><div class="value">${escapeHtml(fmtUsd(d.run.cost_usd))}</div><div class="note">realized cost</div></div>
  <div class="kpi"><div class="label">Tool calls</div><div class="value">${d.run.tool_calls}</div><div class="note">${d.run.tool_errors} errored</div></div>
</div>
<section class="card"><h2>Routing decisions</h2>${decisionsTable(d.decisions, now)}</section>
<div class="grid-2">
  <section class="card"><h2>Tool usage</h2>${barChart(tools)}</section>
  <section class="card"><h2>Plans</h2>${plansTable(d.plans)}</section>
</div>`;
}

function decisionsTable(rows: DecisionRecord[], now: number): string {
  return dataTable(
    rows.slice(0, 200),
    [
      { header: "When", numeric: true, cell: (r) => escapeHtml(fmtAgo(r.ts, now)) },
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

function plansTable(plans: PlanSummary[]): string {
  return dataTable(
    plans,
    [
      { header: "Plan", cell: (p) => escapeHtml(p.title ?? p.id.slice(0, 8)) },
      { header: "Status", cell: (p) => `<span class="pill">${escapeHtml(p.status ?? "—")}</span>` },
      {
        header: "Steps",
        cell: (p) => (p.steps > 0 ? meter(p.done / p.steps) : "—"),
      },
      { header: "Done", numeric: true, cell: (p) => `${p.done}/${p.steps}` },
      { header: "Gates", numeric: true, cell: (p) => String(p.gates) },
      {
        header: "Session",
        cell: (p) =>
          p.session_id
            ? `<a href="/runs/${encodeURIComponent(p.session_id)}" class="mono">${escapeHtml(p.session_id.slice(0, 8))}</a>`
            : "—",
      },
    ],
    "No plans recorded yet.",
  );
}

export function plansView(plans: PlanSummary[], gates: OverviewPayload["gates"]): string {
  return `<section class="card">
  <h2>Verification gate tiers</h2>
  ${statusBar([
    { key: "green", label: "Green (deterministic)", icon: "✔", n: gates.green },
    { key: "yellow", label: "Yellow (flag)", icon: "▲", n: gates.yellow },
    { key: "red", label: "Red (stop)", icon: "✖", n: gates.red },
    { key: "ungraded", label: "Ungraded", icon: "•", n: gates.ungraded },
  ])}
</section>
<section class="card"><h2>Plans</h2>${plansTable(plans)}</section>`;
}

export function memoryView(rows: MemorySummary[], now: number, allowWrites: boolean): string {
  const controls = (m: MemorySummary): string => {
    if (!allowWrites) return '<span class="pill">read-only</span>';
    const btn = (status: string, label: string) =>
      `<button class="ghost" type="submit" name="status" value="${status}">${label}</button>`;
    return `<form method="post" action="/api/v1/memories/${encodeURIComponent(m.id)}/status" style="display:flex;gap:4px">
      ${btn("pinned", "Pin")}${btn("active", "Confirm")}${btn("rejected", "Reject")}
    </form>`;
  };
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
      { header: "Updated", numeric: true, cell: (m) => escapeHtml(fmtAgo(m.updated, now)) },
      { header: "", cell: controls },
    ],
    "No memories curated yet.",
  );
  const banner = allowWrites
    ? `<div class="banner">Writes are enabled. Status changes go through the same audited path as <span class="mono">/memory</span> — every change appends a <span class="mono">memory_events</span> row. Deletes are not exposed here.</div>`
    : `<div class="banner">Read-only. Start with <span class="mono">--allow-writes</span> to enable memory status changes from the browser.</div>`;
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
      { header: "Updated", numeric: true, cell: (b) => escapeHtml(fmtAgo(b.updated, now)) },
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
