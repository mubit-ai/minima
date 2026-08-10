/**
 * Server-rendered SVG chart primitives. No client-side chart library, no build step — the
 * dashboard ships inside the compiled `minima` binary, so every mark is emitted as markup.
 *
 * Conventions held here so callers cannot get them wrong:
 *  - marks are thin, data-ends are 4px-rounded and anchored to the baseline;
 *  - single-measure charts use ONE sequential hue (color carries no extra meaning, the axis
 *    label carries identity), so no legend is emitted for them;
 *  - status colors (gate tiers) are the reserved status palette and always ship icon + label
 *    + a visible value — the yellow step is sub-3:1 on the light surface by design, so the
 *    label IS the accessibility channel, never the hue;
 *  - grid and axes are recessive hairlines; label/value text wears ink tokens, never a
 *    series color;
 *  - every mark carries a <title> so an HTML chart is hoverable by default, and every chart
 *    has a table counterpart (`dataTable`) so identity is never color-alone.
 *
 * Colors are referenced as CSS custom properties defined once in `render.ts`, so light/dark
 * swap in one place.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const num = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : "0");

/** A rect whose far (data) end is rounded and whose baseline end stays square. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.max(0, Math.min(r, w, h / 2));
  if (radius === 0 || w <= 0)
    return `M${num(x)},${num(y)}h${num(Math.max(w, 0))}v${num(h)}h${num(-Math.max(w, 0))}z`;
  return [
    `M${num(x)},${num(y)}`,
    `h${num(w - radius)}`,
    `a${num(radius)},${num(radius)} 0 0 1 ${num(radius)},${num(radius)}`,
    `v${num(h - 2 * radius)}`,
    `a${num(radius)},${num(radius)} 0 0 1 ${num(-radius)},${num(radius)}`,
    `h${num(-(w - radius))}`,
    "z",
  ].join("");
}

export interface BarRow {
  label: string;
  value: number;
  /** Rendered as the direct label at the data end; falls back to the raw value. */
  display?: string;
  /** Extra hover detail. */
  hover?: string;
}

export function emptyState(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

/**
 * Horizontal bars — the default for "magnitude by identity" with long category names.
 * One hue; identity lives in the axis label, so no legend.
 *
 * `reference` draws one recessive vertical rule across the plot with a direct label — for
 * "what actually happened" behind "what each alternative would have cost". It is a rule, not a
 * second series: same measure, same axis, so it needs no legend either.
 */
export function barChart(
  rows: BarRow[],
  opts: { max?: number; reference?: { value: number; label: string } } = {},
): string {
  if (rows.length === 0) return emptyState("No data yet.");
  const rowH = 30;
  const barH = 11;
  const labelW = 190;
  const valueW = 96;
  const width = 760;
  const plotW = width - labelW - valueW;
  const refH = opts.reference ? 18 : 0;
  const height = rows.length * rowH + 8 + refH;
  const max = opts.max ?? Math.max(...rows.map((r) => r.value), opts.reference?.value ?? 0, 0);

  const marks = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const w = max > 0 ? Math.max((r.value / max) * plotW, r.value > 0 ? 2 : 0) : 0;
      const display = r.display ?? String(r.value);
      const hover = r.hover ? `${r.label} — ${r.hover}` : `${r.label}: ${display}`;
      return [
        `<g><title>${escapeHtml(hover)}</title>`,
        `<text class="cat" x="${labelW - 10}" y="${y + barH}" text-anchor="end">${escapeHtml(r.label)}</text>`,
        `<path class="bar" d="${barPath(labelW, y + barH / 2 - barH / 2 + 1, w, barH)}" />`,
        `<text class="val" x="${labelW + w + 8}" y="${y + barH}">${escapeHtml(display)}</text>`,
        "</g>",
      ].join("");
    })
    .join("");

  const ref = opts.reference;
  const refMark =
    ref && max > 0
      ? (() => {
          const x = labelW + Math.min(1, ref.value / max) * plotW;
          const bottom = rows.length * rowH + 8;
          return [
            `<g><title>${escapeHtml(ref.label)}</title>`,
            `<line class="ref" x1="${num(x)}" y1="4" x2="${num(x)}" y2="${num(bottom)}" />`,
            `<text class="tick" x="${num(x)}" y="${num(bottom + 13)}" text-anchor="middle">${escapeHtml(ref.label)}</text>`,
            "</g>",
          ].join("");
        })()
      : "";

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
  <line class="axis" x1="${labelW}" y1="4" x2="${labelW}" y2="${rows.length * rowH + 4}" />
  ${marks}
  ${refMark}
</svg>`;
}

export interface AreaPoint {
  label: string;
  value: number;
  hover?: string;
}

/**
 * Single-series area + line over time. One measure, one axis — never a second y-scale.
 */
export function areaChart(
  points: AreaPoint[],
  opts: { valueFmt?: (n: number) => string } = {},
): string {
  if (points.length === 0) return emptyState("No spend recorded yet.");
  const fmt = opts.valueFmt ?? ((n: number) => n.toFixed(4));
  const width = 760;
  const height = 220;
  const padL = 64;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...points.map((p) => p.value), 0);
  const scaleMax = max > 0 ? max : 1;
  const x = (i: number) =>
    padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / scaleMax) * plotH;

  const ticks = [0, 0.5, 1]
    .map((t) => {
      const v = scaleMax * t;
      return `<g><line class="grid" x1="${padL}" y1="${num(y(v))}" x2="${width - padR}" y2="${num(y(v))}" />
      <text class="tick" x="${padL - 8}" y="${num(y(v) + 4)}" text-anchor="end">${escapeHtml(fmt(v))}</text></g>`;
    })
    .join("");

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${num(x(i))},${num(y(p.value))}`)
    .join("");
  const area = `${line}L${num(x(points.length - 1))},${num(padT + plotH)}L${num(x(0))},${num(padT + plotH)}z`;

  const showMarker = points.length <= 40;
  const marks = points
    .map((p, i) => {
      const hover = p.hover ?? `${p.label}: ${fmt(p.value)}`;
      return `<g><title>${escapeHtml(hover)}</title>
        ${showMarker ? `<circle class="dot" cx="${num(x(i))}" cy="${num(y(p.value))}" r="4" />` : ""}
        <circle class="hit" cx="${num(x(i))}" cy="${num(y(p.value))}" r="9" /></g>`;
    })
    .join("");

  const step = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points
    .map((p, i) =>
      i % step === 0 || i === points.length - 1
        ? `<text class="tick" x="${num(x(i))}" y="${height - 12}" text-anchor="middle">${escapeHtml(p.label)}</text>`
        : "",
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
  ${ticks}
  <path class="area" d="${area}" />
  <path class="line" d="${line}" />
  ${marks}
  <line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" />
  ${xLabels}
</svg>`;
}

export interface StatusSegment {
  key: "green" | "yellow" | "red" | "ungraded";
  label: string;
  icon: string;
  n: number;
}

/**
 * Stacked status bar for gate tiers. 2px surface gaps between segments; icon + label +
 * count always rendered, so the reserved status hues never carry meaning alone.
 */
export function statusBar(segments: StatusSegment[]): string {
  const total = segments.reduce((s, x) => s + x.n, 0);
  if (total === 0) return emptyState("No verification gates recorded yet.");
  const width = 760;
  const barH = 14;
  const present = segments.filter((s) => s.n > 0);

  let cursor = 0;
  const marks = present
    .map((s) => {
      const w = (s.n / total) * width;
      const drawW = Math.max(w - 2, 1);
      const seg = `<g><title>${escapeHtml(`${s.label}: ${s.n} of ${total}`)}</title>
        <path class="seg seg-${s.key}" d="${barPath(cursor, 0, drawW, barH, 3)}" /></g>`;
      cursor += w;
      return seg;
    })
    .join("");

  const legend = segments
    .map(
      (s) =>
        `<li><span class="dot-${s.key}" aria-hidden="true"></span>
         <span class="lg-icon">${escapeHtml(s.icon)}</span>
         <span class="lg-label">${escapeHtml(s.label)}</span>
         <span class="lg-val">${s.n}</span>
         <span class="lg-pct">${total > 0 ? Math.round((s.n / total) * 100) : 0}%</span></li>`,
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${barH}" width="100%" height="${barH}" role="img">${marks}</svg>
<ul class="legend">${legend}</ul>`;
}

/** Sequential blue step for a 0..1 rate — heatmap cells only (magnitude, one hue). */
export function seqStep(rate: number): string {
  const clamped = Math.max(0, Math.min(1, rate));
  const steps = 8;
  const idx = Math.min(steps, Math.floor(clamped * steps) + 1);
  return `hsl(var(--seq-${idx}))`;
}

export interface TableColumn<T> {
  header: string;
  /** Right-align + tabular figures for numeric columns. */
  numeric?: boolean;
  /**
   * Let this column's text wrap. `td` is `white-space: nowrap` by default — right for ids and
   * numbers, wrong for prose, and the class has to land on the `td` itself (a `<span class="wrap">`
   * inside one inherits the nowrap and does nothing, which is how memory content shipped as a
   * single unwrappable line).
   */
  wrap?: boolean;
  cell: (row: T) => string;
}

const cellClass = <T>(c: TableColumn<T>): string => {
  const names = [c.numeric ? "num" : "", c.wrap ? "wrap" : ""].filter(Boolean);
  return names.length > 0 ? ` class="${names.join(" ")}"` : "";
};

/** The table counterpart every chart needs — also the primary view for dense ledger rows. */
export function dataTable<T>(
  rows: T[],
  cols: TableColumn<T>[],
  emptyMsg = "Nothing here yet.",
  /** Pass an id to make the table sortable by header click and filterable by `tableFilter`. */
  id?: string,
): string {
  if (rows.length === 0) return emptyState(emptyMsg);
  const head = cols
    .map((c) => `<th${c.numeric ? ' class="num"' : ""}>${escapeHtml(c.header)}</th>`)
    .join("");
  const body = rows
    .map((r) => `<tr>${cols.map((c) => `<td${cellClass(c)}>${c.cell(r)}</td>`).join("")}</tr>`)
    .join("");
  const attrs = id ? ` id="${escapeHtml(id)}" class="sortable"` : "";
  return `<div class="table-wrap"><table${attrs}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * The filter control for a `dataTable` given an id. Sorting and filtering are client-side on
 * rows already in the HTML — no query, no round-trip, and the row count stays visible so a
 * filtered view can never be mistaken for the whole set.
 */
export function tableFilter(id: string, title: string, rows: number): string {
  return `<div class="thead"><h2>${escapeHtml(title)}</h2>
  <span class="spacer"></span>
  <span class="rowcount" id="${escapeHtml(id)}-count">${rows} row${rows === 1 ? "" : "s"}</span>
  <input class="tfilter" type="search" placeholder="Filter…" aria-label="Filter ${escapeHtml(title)}" data-for="${escapeHtml(id)}" /></div>`;
}
